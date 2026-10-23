// Controlador de claude-router, independiente de la interfaz: lo usan la web (por defecto) y la terminal (--terminal).
// La vista solo implementa `ui`: { log(texto), setInput(texto), focusInput(), changed(), quit(), shortcuts }.
// Los textos usan etiquetas estilo blessed ({green-fg}, {bold}, {/}); cada vista las pinta a su manera.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { Session, PROFILES, MODELS, TIERS, tierOf, authStatus, authLogout, claudeCmd, effectiveVerify, DEFAULT_ALLOW, isQuick } from './core.mjs';
import { ACTIONS } from './actions.mjs';
import { loadSettings, saveSettings, getProject, setProject, loadCustom } from './config.mjs';
import { DriftTracker, installRules, hasRules, lessonsInfo, LESSONS_REL, lessonsRel } from './rules.mjs';
import * as gitx from './git.mjs';
import * as history from './history.mjs';
import { detectStack, SPECIALISTS, SPEC_KEYS, specialistsFor } from './stack.mjs';
import { newPlan, planItems, togglePlan, resolvePlan, skipNote, planLines, actionInfo } from './plan.mjs';
import { TaskQueue } from './queue.mjs';
import { scanDocs, digestState, contextFiles, contextPrompt, readable, CONTEXT_REL, contextRel } from './docs.mjs';
import { currentVersion, checkUpdate, runUpdate } from './update.mjs';
import { composePrompt, needsText, rank, MAX_FLOWS, routerPrompt, parseRouter, localRoute, GENERAL } from './intent.mjs';

export const esc = (s) => String(s).replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));
export const COLOR = { haiku: 'green', sonnet: 'cyan', opus: 'magenta', other: 'white' };
const PROFILE_KEYS = Object.keys(PROFILES);
const PERMS = [
  ['acceptEdits', 'edita archivos solo; los comandos fuera de la lista permitida se deniegan (/permitir)'],
  ['auto', 'un clasificador revisa cada acción (si tu cuenta lo permite)'],
  ['plan', 'solo planifica, no toca nada'],
];
const VERIFY_MODES = ['auto', 'siempre', 'nunca'];
// Acciones destacadas: en la web salen como botones grandes arriba
const PRIMARY = new Set(['/feature', '/bugprofundo', '/auditoria', '/pulir', 'changes', 'undo']);

export const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
export const bar = (f, w = 10) => '█'.repeat(Math.max(0, Math.min(w, Math.round(f * w)))).padEnd(w, '░');
export const fmtDur = (ms) => { const t = Math.max(0, Math.round((ms || 0) / 1000)); const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); const sec = t % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`; };
export const pct = (x) => `${Math.round((x || 0) * 100)}%`;

export function createApp(cwd, ui) {
  const settings = loadSettings();
  if (!PROFILES[settings.profile]) settings.profile = 'balanced';
  if (!Array.isArray(settings.collapsed)) settings.collapsed = [];
  const custom = loadCustom(cwd);
  const stack = detectStack(cwd);
  const saved = getProject(cwd);
  settings.allow = [...new Set([...(settings.allow || []), ...custom.allow])];
  const session = new Session({ cwd, profile: settings.profile, permission: settings.permission, settings, customAgents: custom.agents, stack });
  session.extraAllow = Array.isArray(saved.allow) ? saved.allow : [];
  let docs = scanDocs(cwd);
  session.docs = docs;
  const CONTEXT_LABEL = 'Leer MDs (contexto)';
  const drift = new DriftTracker(settings.userName);
  const actions = [...ACTIONS, ...custom.actions];
  const queue = new TaskQueue(Array.isArray(saved.queue) ? saved.queue : [], (items) => setProject(cwd, { queue: items }));
  let repo = gitx.isRepo(cwd);
  let ckptCount = 0; // fotos 'antes:' guardadas (se cachea: contarlas lanza git)
  const updateCkpt = () => { ckptCount = repo ? gitx.listCheckpoints(cwd).filter((c) => c.label.startsWith('antes:')).length : 0; };
  updateCkpt();

  let auth = { loggedIn: false, installed: true, method: null };
  let active = null;
  let lastLabel = '';
  let thinking = false; // Haiku está leyendo tu petición para elegir flujos
  let thinkStart = 0;
  let routeSkipped = false;
  const nextQ = []; // «A continuación»: instrucciones ya preparadas que empiezan solas cuando termina la actual
  let nextSeq = 0;
  const backlog = []; // lo que escribes mientras Haiku aún está creando el plan de la anterior
  let qPaused = false; // la cola espera porque la tarea anterior se canceló o falló
  let warnedRouter = false;
  let planState = null; // plan previo esperando que lo confirmes: { plan, text, general, label, ... }
  let runMeta = null; // instrucción en curso: { start, label, est, steps, done, delegations }
  const stepInfo = new Map(); // id de herramienta/subagente -> { start, name, agent, kind }
  let tray = []; // acciones pulsadas que se enviarán juntas (más lo que escribas) al pulsar Enviar
  let pending = null; // acción a medias: { main, wrap, label, queue } — se aplica a lo que escribas a continuación
  let currentLabel = null; // etiqueta de la instrucción en curso (para historial)
  let ckptNote = null;
  let queueRunning = false;
  let warnedBig = false;
  let lastRunInfo = null;
  let updateInfo = null;
  let updating = false;
  let permAsk = null; // el guardia bloqueó sobrescribir archivos: esperando tu Permitir / Denegar
  const notify = (kind, title, body, ms) => { if (settings.notify !== false && ui.notify) { try { ui.notify({ kind, title, body: String(body || '').slice(0, 180), ms: ms || 0 }); } catch { /* nada */ } } };
  let ctxWarned = false; // ya avisé de que el contexto se acerca al límite
  const afterIdle = []; // tareas que se ejecutan cuando termine la actual (p. ej. compactar)

  const persist = () => saveSettings({ ...settings, profile: session.profile, permission: session.permission });
  const log = (t = ' ') => ui.log(t);
  const focusInput = () => ui.focusInput && ui.focusInput();
  const refresh = () => ui.changed && ui.changed();
  const spawnChild = (file, args, opts) => (ui.spawn || nodeSpawn)(file, args, opts);

  function refreshAuth() {
    auth = authStatus();
    refresh();
    return auth;
  }

  // ---------- Enviar instrucciones ----------
  function send(prompt, { display, label, main, skipEcho, specialists, keepPlan } = {}) {
    if (session.busy) { log('{yellow-fg}Hay una tarea en curso. Cancélala primero.{/}'); return false; }
    if (!keepPlan) planState = null;
    // Especialistas: los que decidas/detecte el enrutador; si no, solo los 2 del proyecto y solo en trabajos de verdad
    const specs = specialists ?? (isQuick(prompt) ? [] : stack.hints.slice(0, 2));
    lastLabel = '';
    active = null;
    currentLabel = label || null;
    if (!skipEcho) log(`\n{bold}› ${esc(display || label || prompt)}{/bold}`);
    const t = history.typicalCost(label);
    if (t) log(`{gray-fg}≈ $${t.cost.toFixed(2)} suele costar esto (media de ${t.n} veces){/}`);
    if (specs.length) log(`{gray-fg}🧩 Especialistas para esta tarea: ${esc(specs.map((k) => SPECIALISTS[k].tag).join(', '))} (aparecen solo ahora){/}`);
    session.run(prompt, { label, specialists: specs, ...(main ? { main } : {}) }).catch((e) => log(`{red-fg}${esc(e.message)}{/}`));
    return true;
  }

  const isStackable = (a) => !a.main && !!(a.prompt || a.wrap || a.input);
  const findAction = (cmd) => actions.find((x) => x.cmd === cmd);
  const trayActions = () => tray.map(findAction).filter(Boolean);

  // Acciones que fuerzan el modelo (Haiku/Opus a mano) o no se apilan: se ejecutan solas, como antes
  function runAction(a) {
    pending = null;
    if (a.input) {
      tray = [];
      pending = { main: a.main || null, wrap: a.wrap || null, label: a.label };
      ui.setInput(a.prefill || '');
      log(`{gray-fg}${esc(a.hint || a.label + ': completa la frase en la caja de abajo y pulsa Enter.')}{/}`);
      refresh();
    } else {
      send(a.prompt, { label: a.label, main: a.main });
    }
    focusInput();
  }

  // Clic (o comando escrito) en una acción apilable: entra o sale de la bandeja
  function toggleTray(a) {
    if (!isStackable(a)) return runAction(a);
    pending = null;
    const i = tray.indexOf(a.cmd);
    if (i >= 0) tray.splice(i, 1);
    else {
      tray.push(a.cmd);
      if (a.input && ui.usePrefill && a.prefill) ui.setInput(a.prefill);
      if (ui.verboseTray) log(`{gray-fg}➕ ${esc(a.label)} en la bandeja${a.input ? ': escribe qué quieres' : ''}. Enter lo envía todo junto con lo que escribas; clic otra vez lo quita.{/}`);
    }
    refresh();
    focusInput();
  }
  function removeFromTray(cmd) { tray = tray.filter((c) => c !== cmd); refresh(); }
  function clearTray() { tray = []; refresh(); }

  // Haiku lee tu petición (barato y tolera faltas); si no responde, palabras clave
  async function route(text, allowed) {
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < 3) return { ...localRoute(text), how: 'palabras' };
    thinking = true;
    thinkStart = Date.now();
    routeSkipped = false;
    refresh();
    let out = null;
    try { out = await session.classify(routerPrompt(text, allowed)); } finally { thinking = false; refresh(); }
    const r = out ? parseRouter(out, allowed.map((a) => a.cmd)) : null;
    if (r) return { ...r, how: 'haiku' };
    if (routeSkipped) return { ...localRoute(text), how: 'palabras' };
    if (!warnedRouter) {
      warnedRouter = true;
      log('{gray-fg}(No pude consultar a Haiku para entender tu frase; uso el reconocimiento por palabras clave.){/}');
    }
    return { ...localRoute(text), how: 'palabras' };
  }

  // «Saltar»: no esperar a Haiku y seguir con el reconocimiento por palabras clave
  function skipRouting() {
    if (!thinking) return;
    routeSkipped = true;
    session.skipClassify();
  }

  // Bandeja + texto → Haiku elige flujos → UNA instrucción (con método general si no encaja ninguno pero es trabajo)
  async function sendTray(raw) {
    if (thinking) { backlog.push(raw); return log('{gray-fg}⏳ Estoy creando el plan de la anterior; esta va justo detrás.{/}'); }
    let text = String(raw || '').trim();
    let literal = false;
    if (text.startsWith('!')) { literal = true; text = text.slice(1).trim(); }
    const chosen = trayActions();
    if (!chosen.length && !text) return;
    const need = chosen.find((a) => needsText(a));
    if (need && !text) return log(`{yellow-fg}«${esc(need.label)}» necesita que escribas qué quieres (la caja de abajo).{/}`);

    // Se ve tu mensaje enseguida; Haiku tarda un par de segundos
    const chosenLabel = chosen.map((a) => a.label).join(' + ');
    log(`\n{bold}› ${esc(chosenLabel ? (text ? `${chosenLabel}: ${text}` : chosenLabel) : text)}{/bold}`);
    tray = [];
    ui.setInput('');
    const willQueue = session.busy || queueRunning || nextQ.length > 0;
    if (willQueue) log('{gray-fg}⏳ Hay una tarea en marcha: esto se pone a continuación en la cola (te enseño igualmente el plan).{/}');

    let auto = [];
    let general = false;
    let note = '';
    let techs = [];
    if (!literal && settings.autoFlows !== false && text) {
      const allowed = actions.filter((a) => isStackable(a) && a.cmd !== '/bug');
      if (ui.routingInLog !== false) log('{gray-fg}⏳ Creando el plan… Haiku está leyendo tu frase.{/}');
      const r = await route(text, allowed);
      auto = r.cmds.map(findAction).filter((a) => a && !chosen.includes(a));
      techs = r.kind === 'tarea' || chosen.length ? r.techs || [] : [];
      const who = r.how === 'haiku' ? 'Haiku leyó tu petición' : 'Reconozco lo que pides';
      if (auto.length) note = `${who} y usa ${auto.map((a) => a.label).join(' + ')} (ya existe como flujo).`;
      else if (!chosen.length && r.kind === 'tarea') { general = true; note = `${who}: no encaja con un flujo concreto, pero es un trabajo de verdad → método general (explorar → planificar → hacer → comprobar → optimizar → verificar, con subagentes).`; }
      else if (!chosen.length && r.kind === 'pequeno') note = `${who}: cambio pequeño, lo hago directo (delegando solo si hace falta).`;
    }
    if (!techs.length && !literal && text && (settings.autoFlows === false || !text)) techs = specialistsFor(text);
    let all = general ? [GENERAL] : [...chosen, ...auto];
    if (all.length > MAX_FLOWS) all = all.slice(0, MAX_FLOWS);
    all.sort((a, b) => rank(a.cmd) - rank(b.cmd));

    // Especialistas: los que nombra tu frase (Haiku, o palabras clave) y, si es un trabajo y no dices nada, los del proyecto
    let specs = literal ? [] : techs.slice(0, 3);
    if (!literal && !specs.length && all.length) specs = stack.hints.slice(0, 2);

    if (!literal && all.length && settings.planPreview !== false) {
      showPlan({ plan: newPlan({ flows: all, specs, text }), text, note });
      return;
    }
    launch(all, text, specs, note, literal);
    processBacklog();
  }
  function processBacklog() {
    if (thinking || planState || !backlog.length) return;
    sendTray(backlog.shift()).catch((e) => log(`{red-fg}${esc(e.message)}{/}`));
  }

  function launch(all, text, specs, note, literal, extra = '') {
    const label = all.length ? all.map((a) => a.label).join(' + ') : undefined;
    const prompt = composePrompt(all, text) + extra;
    if (session.busy || queueRunning || nextQ.length) return enqueue({ label, text, prompt, specs, note });
    const ok = send(prompt, { label, skipEcho: true, specialists: specs });
    if (ok && note) log(`{gray-fg}↪ ${esc(note)}${literal ? '' : ' Para que vaya literal, empieza con «!».'}{/}`);
    refresh();
  }

  // ---------- A continuación (cola de instrucciones preparadas) ----------
  const nextName = (q) => q.label || q.text.replace(/\s+/g, ' ').slice(0, 60) || 'Instrucción';
  function enqueue({ label, text, prompt, specs, note }) {
    const it = { id: ++nextSeq, label: label || null, text: text || '', prompt, specs: specs || [], note: note || '' };
    nextQ.push(it);
    log(`{green-fg}➕ A continuación (#${nextQ.length}):{/} ${esc(nextName(it))}${it.text && it.label ? ' {gray-fg}— ' + esc(it.text.replace(/\s+/g, ' ').slice(0, 70)) + '{/}' : ''}`);
    refresh();
    setTimeout(drainNext, 60); // si ya no hay nada en marcha, arranca enseguida
    focusInput();
  }
  function drainNext() {
    if (session.busy || queueRunning || qPaused || !nextQ.length) return;
    if (afterIdle.length) return setTimeout(drainNext, 150); // primero la compactación pendiente, luego la siguiente de la cola
    const it = nextQ.shift();
    const ok = send(it.prompt, { label: it.label || undefined, display: `▶ De la cola · ${nextName(it)}${it.text && it.label ? ': ' + it.text : ''}`, specialists: it.specs, keepPlan: true });
    if (!ok) nextQ.unshift(it);
    refresh();
  }
  function nextRemove(id) {
    const i = nextQ.findIndex((q) => q.id === Number(id));
    if (i < 0) return false;
    const [it] = nextQ.splice(i, 1);
    log(`{gray-fg}Quitada de «a continuación»: ${esc(nextName(it))}{/}`);
    refresh();
    return true;
  }
  function nextUp(id) {
    const i = nextQ.findIndex((q) => q.id === Number(id));
    if (i <= 0) return false;
    const [it] = nextQ.splice(i, 1);
    nextQ.splice(i - 1, 0, it);
    refresh();
    return true;
  }
  function nextClear() {
    const n = nextQ.length;
    nextQ.length = 0;
    qPaused = false;
    if (n) log(`{gray-fg}Cola «a continuación» vaciada (${n}).{/}`);
    refresh();
  }
  function nextResume() {
    if (!qPaused) return;
    qPaused = false;
    log('{green-fg}▶ Sigo con la cola.{/}');
    refresh();
    setTimeout(drainNext, 30);
  }
  function showNext(arg) {
    if (!nextQ.length) return log('{gray-fg}No hay nada a continuación. Mientras trabajo, lo que me escribas se pone aquí.{/}');
    log(`\n{bold}A continuación (${nextQ.length}){/bold}${qPaused ? ' {yellow-fg}⏸ en pausa (/seguir){/}' : ''}\n${nextQ.map((q, i) => `  ${i + 1}. ${esc(nextName(q))}${q.text && q.label ? ' {gray-fg}— ' + esc(q.text.replace(/\s+/g, ' ').slice(0, 60)) + '{/}' : ''}`).join('\n')}\n  {gray-fg}/siguiente-quitar N · /siguientes-limpiar · /seguir{/}`);
    return undefined;
  }

  // ---------- Plan previo con checks ----------
  function printPlan() {
    const { text } = planLines(planState.plan);
    log(`\n{bold}Plan{/bold} {gray-fg}(todo marcado; desmarca lo que no quieras)${planState.note ? ' — ' + esc(planState.note) : ''}{/}\n${text}\n{gray-fg}Escribe los números para marcar/desmarcar (ej. «3 5») · Enter ejecuta · «x» cancela${ui.planHint ? ' · ' + ui.planHint : ''}{/}`);
  }
  function showPlan(st) {
    planState = st;
    notify('plan', 'Plan listo', 'Revisa los checks y pulsa Ejecutar plan.');
    if (ui.planInLog !== false) printPlan();
    refresh();
    focusInput();
  }
  function planToggleId(id) {
    if (!planState) return false;
    const ok = togglePlan(planState.plan, id);
    if (ok) refresh();
    return ok;
  }
  function planRun() {
    if (!planState) return;
    const { plan, text, note } = planState;
    const r = resolvePlan(plan);
    planState = null;
    if (!r.flows.length && !text) { log('{gray-fg}Plan vacío: no queda nada marcado. Cancelado.{/}'); return refresh(); }
    const off = r.skipped.length ? `${r.skipped.length} paso(s) desmarcado(s)` : '';
    log(`{gray-fg}✔ Plan confirmado: ${esc(r.flows.map((f) => f.label).join(' + ') || 'tu texto')}${r.skipped.length ? ' · sin: ' + esc(r.skipped.map((x) => x.label).join(', ')) : ''}${r.specs.length ? ' · con: ' + esc(r.specs.map((k) => SPECIALISTS[k].tag).join(', ')) : ''}{/}`);
    launch(r.flows, text, r.specs, [note, off].filter(Boolean).join(' · '), true, skipNote(r.skipped));
    processBacklog();
  }
  function planCancel() {
    if (!planState) return;
    planState = null;
    log('{gray-fg}Plan cancelado: no se ha hecho nada.{/}');
    refresh();
    focusInput();
    processBacklog();
  }
  // Tecleado: números marcan/desmarcan, Enter ejecuta, x cancela
  function planInput(text) {
    const t = text.trim().toLowerCase();
    if (!t || ['ok', 'si', 'sí', 'ejecutar', 'dale', 'vale', 'go'].includes(t)) return planRun();
    if (['x', 'no', 'cancelar', 'cancela', '/cancelar'].includes(t)) return planCancel();
    if (/^[\d\s,]+$/.test(t)) {
      const items = planItems(planState.plan);
      for (const n of t.split(/[\s,]+/).filter(Boolean).map(Number)) if (items[n - 1]) togglePlan(planState.plan, items[n - 1].id);
      printPlan();
      return refresh();
    }
    return log('{yellow-fg}Hay un plan esperando: números para marcar/desmarcar, Enter para ejecutar, «x» para cancelar.{/}');
  }

  function togglePlanPreview(arg) {
    const a = String(arg || '').trim().toLowerCase();
    settings.planPreview = ['on', 'si', 'sí'].includes(a) ? true : ['off', 'no'].includes(a) ? false : settings.planPreview === false;
    log(settings.planPreview
      ? '{green-fg}Plan previo: sí.{/} Antes de ejecutar te enseño la lista de pasos con checks (todo marcado); desmarcas lo que no quieras.'
      : '{bold}Plan previo: no.{/} Se ejecuta directamente lo que pidas.');
    persist();
    refresh();
  }

  function cancelPending() {
    if (!pending) return;
    pending = null;
    ui.setInput('');
    refresh();
  }

  // ---------- Ajustes rápidos ----------
  function cycleProfile() {
    const next = PROFILE_KEYS[(PROFILE_KEYS.indexOf(session.profile) + 1) % PROFILE_KEYS.length];
    session.profile = next;
    const p = PROFILES[next];
    log(`{bold}Perfil → ${p.label}{/bold}: ${p.desc} {gray-fg}(principal: ${MODELS[p.main]}; verificación: ${effectiveVerify(settings.verify, next)}){/}`);
    persist();
    refresh();
    focusInput();
  }

  function cyclePerm() {
    const i = PERMS.findIndex((p) => p[0] === session.permission);
    const [mode, desc] = PERMS[(i + 1) % PERMS.length];
    session.permission = mode;
    log(`{bold}Permisos → ${mode}{/bold}: ${desc}`);
    persist();
    refresh();
    focusInput();
  }

  function setVerify(arg) {
    const a = String(arg || '').trim().toLowerCase();
    settings.verify = VERIFY_MODES.includes(a) ? a : VERIFY_MODES[(VERIFY_MODES.indexOf(settings.verify) + 1) % VERIFY_MODES.length];
    const eff = effectiveVerify(settings.verify, session.profile);
    log(`{bold}Verificación → ${settings.verify}{/bold}${settings.verify === 'auto' ? ` (según perfil: ${eff})` : ''}: ${{
      siempre: 'cada instrucción termina con verificador (+ probador). Más calidad, más tokens.',
      auto: 'verificador cuando el cambio toca más de 2 archivos o es arriesgado.',
      nunca: 'sin verificación final salvo que la pidas (máximo ahorro).',
    }[eff]}`);
    persist();
    refresh();
    focusInput();
  }

  function toggleAutoCompact() {
    settings.autoCompact = !settings.autoCompact;
    log(settings.autoCompact
      ? `{bold}Auto-compactar: sí{/bold}. Compactaré solo cuando el contexto pase de ${kfmt(settings.compactAt)} tokens o Claude se vaya (deje de empezar con «${esc(settings.userName)}»).`
      : '{bold}Auto-compactar: no{/bold}. Te avisaré, pero compactas tú con /compactar.');
    persist();
    refresh();
    focusInput();
  }

  function toggleAutoFlows(arg) {
    const a = String(arg || '').trim().toLowerCase();
    settings.autoFlows = ['on', 'si', 'sí'].includes(a) ? true : ['off', 'no'].includes(a) ? false : settings.autoFlows === false;
    log(settings.autoFlows
      ? '{green-fg}Reconocer flujos: sí.{/} Si escribes «optimiza el código» o «créame X y optimízalo», uso los flujos que ya existen (y te lo digo). Con «!» al principio va literal.'
      : '{bold}Reconocer flujos: no.{/} Lo que escribas va tal cual; solo se aplican los botones que pulses.');
    persist();
    refresh();
  }

  function setPush(arg) {
    const a = String(arg || '').trim().toLowerCase();
    if (!['on', 'off', 'si', 'sí', 'no'].includes(a)) return log(`git push desde Claude: ${settings.blockPush !== false ? 'BLOQUEADO' : 'permitido'}. Usa /push on (permitir) o /push off (bloquear).`);
    settings.blockPush = !(a === 'on' || a === 'si' || a === 'sí');
    persist();
    log(settings.blockPush ? '{green-fg}git push / reset --hard / clean bloqueados dentro de Claude.{/}' : '{yellow-fg}Ojo: Claude podrá hacer git push, reset --hard y clean.{/}');
  }

  function setRemind(arg) {
    const n = parseInt(arg, 10);
    if (Number.isNaN(n) || n < 0) return log(`Recordatorio automático de reglas cada ${settings.remindEvery || 'nunca'} instrucciones. Usa /recordatorio 5  (0 = nunca).`);
    settings.remindEvery = n;
    persist();
    refresh();
    log(n ? `{green-fg}Antepondré el recordatorio de reglas cada ${n} instrucciones.{/}` : 'Recordatorio automático desactivado (seguirá el detector de deriva).');
  }

  // ---------- Login ----------
  function doLogin() {
    const a = refreshAuth();
    if (a.loggedIn) {
      log(`{green-fg}Ya tienes sesión{/} (${esc(a.method || 'activa')}${a.email ? ', ' + esc(a.email) : ''}). Para cambiar de cuenta escribe /logout y luego pulsa Login.`);
      return focusInput();
    }
    log('{yellow-fg}Abriendo el login de Claude (se abre el navegador)…{/}');
    const c = claudeCmd(['auth', 'login']);
    const child = spawnChild(c.file, c.args, { shell: c.shell, stdio: 'inherit' });
    child.on('error', (e) => log(`{red-fg}No pude lanzar el login: ${esc(e.message)}{/}`));
    child.on('exit', () => {
      refreshAuth();
      log(auth.loggedIn ? '{green-fg}Login correcto.{/}' : '{red-fg}No detecto sesión todavía. Reinténtalo con el botón Login.{/}');
      focusInput();
    });
  }

  function doLogout() {
    authLogout();
    refreshAuth();
    log('Sesión cerrada. Pulsa Login para entrar de nuevo.');
  }

  // ---------- Actualizaciones ----------
  async function doUpdate() {
    if (updating) return log('{gray-fg}Ya se está actualizando…{/}');
    if (session.busy) return log('{yellow-fg}Espera a que termine la tarea en curso antes de actualizar.{/}');
    updating = true;
    log('{yellow-fg}Actualizando claude-router desde GitHub…{/}');
    refresh();
    const r = await runUpdate((l) => log(`{gray-fg}  ${esc(l)}{/}`));
    updating = false;
    if (r.ok) {
      updateInfo = null;
      log('{green-fg}✔ Actualizado.{/} Cierra y vuelve a abrir {bold}cla{/bold} para usar la versión nueva.');
    } else {
      log(`{red-fg}No pude actualizar: ${esc(r.error || 'error desconocido')}{/}\n  Prueba a mano:  {bold}npm i -g https://github.com/Ivankirito22/ClaudeOP/tarball/main{/bold}`);
    }
    refresh();
  }

  async function doCheckUpdate() {
    log('{gray-fg}Buscando actualizaciones…{/}');
    updateInfo = await checkUpdate({ force: true });
    if (updateInfo?.newer) log(`{yellow-fg}Hay versión nueva: ${esc(updateInfo.latest)} (tienes ${esc(currentVersion())}). Pulsa «Actualizar» o escribe /actualizar.{/}`);
    else log(`{green-fg}Estás al día{/} (v${esc(currentVersion())}).`);
    refresh();
  }

  // ---------- Informes ----------
  function showCost() {
    const st = session.stats;
    const total = TIERS.reduce((a, t) => a + st.tiers[t].out, 0) || 1;
    const rows = TIERS.map((t) => {
      const s = st.tiers[t];
      return `  {${COLOR[t]}-fg}${t.padEnd(7)}{/} ${String(s.msgs).padStart(3)} mensajes · entrada ${kfmt(s.inp).padStart(6)} · salida ${kfmt(s.out).padStart(6)} (${Math.round((s.out / total) * 100)}%)`;
    });
    log(`\n{bold}Uso de esta sesión{/bold}\n${rows.join('\n')}\n  coste estimado ~$${st.cost.toFixed(2)} · caché ${Math.round(st.cacheRatio * 100)}% · compactaciones: ${session.compactions}\n  {gray-fg}Estimación local; con suscripción no es lo que pagas. Si Opus/Sonnet pesan mucho y la tarea era mecánica, prueba el perfil Económico.{/}`);
  }

  function showReport(arg) {
    const days = Math.min(90, Math.max(1, parseInt(arg, 10) || 7));
    const all = history.summarize(history.load({ days }));
    if (!all.runs) return log(`{gray-fg}Aún no hay historial de los últimos ${days} días. Se va rellenando con cada instrucción.{/}`);
    const mine = history.summarize(history.load({ days, cwd }));
    const projects = Object.entries(all.byProject).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${esc(n)} $${c.toFixed(2)}`).join(' · ');
    const labels = Object.entries(all.byLabel).sort((a, b) => b[1].cost - a[1].cost).slice(0, 5).map(([n, o]) => `  ${esc(n.padEnd(26))} ×${String(o.n).padEnd(3)} ~$${o.cost.toFixed(2)}`).join('\n');
    const sh = all.share;
    log(`
{bold}Informe de los últimos ${days} días{/bold}  (${all.runs} instrucciones, ${mine.runs} en este proyecto)
  coste estimado ~$${all.cost.toFixed(2)} · tiempo ${(all.ms / 60000).toFixed(0)} min · con error: ${all.errors}
  salida por modelo:  {green-fg}haiku ${bar(sh.haiku, 8)} ${pct(sh.haiku)}{/}  {cyan-fg}sonnet ${bar(sh.sonnet, 8)} ${pct(sh.sonnet)}{/}  {magenta-fg}opus ${bar(sh.opus, 8)} ${pct(sh.opus)}{/}
  delegado medio a subagentes: ${all.delegated === null ? 'sin datos' : pct(all.delegated)}
  por proyecto: ${projects || '—'}
  lo que más gasta:
${labels}
${all.tips.length ? all.tips.map((t) => `  {yellow-fg}→ ${esc(t)}{/}`).join('\n') : '  {green-fg}Reparto sano: nada que corregir.{/}'}
  {gray-fg}Son estimaciones locales de Claude Code; con suscripción cuentan como uso del plan, no como factura.{/}`);
  }

  // ---------- Sesión y memoria ----------
  function newSession() {
    if (session.busy) return log('{yellow-fg}Cancela la tarea en curso primero.{/}');
    session.newSession();
    drift.reset();
    log('{gray-fg}Sesión nueva: contexto vacío.{/}');
    refresh();
    focusInput();
  }

  function continueLast() {
    if (session.busy) return log('{yellow-fg}Espera a que termine la tarea en curso.{/}');
    const s = getProject(cwd);
    if (!s.sessionId) return log('{gray-fg}No hay sesión anterior guardada para esta carpeta.{/}');
    session.sessionId = s.sessionId;
    session.reinforce = true;
    log(`{green-fg}Continuando la última sesión de esta carpeta{/} {gray-fg}(${esc(String(s.sessionId).slice(0, 8))}…){/}. Refuerzo las reglas en la próxima instrucción.`);
    focusInput();
  }

  function doRules() {
    try {
      const r = installRules(cwd, settings.userName, { lessons: settings.lessons !== false, context: settings.contextDocs !== false });
      log(`{green-fg}✔ Reglas ${r.action} en CLAUDE.md{/}${r.changed ? '' : ' (ya estaba igual)'}: empezar cada respuesta con «${esc(settings.userName)}», delegación, calidad y ahorro de tokens. Tu contenido existente no se toca.${r.lessonsCreated ? `\n  Creado {bold}${esc(LESSONS_REL)}{/bold}: Claude apuntará ahí las lecciones de cada bug.` : ''}`);
    } catch (e) {
      log(`{red-fg}No pude escribir CLAUDE.md: ${esc(e.message)}{/}`);
    }
    refresh();
    focusInput();
  }

  function doRemind() {
    session.reinforce = true;
    log('{gray-fg}Vale: antepondré un recordatorio de reglas a tu próxima instrucción.{/}');
    focusInput();
  }

  async function doCompact(reason) {
    if (session.busy) return log('{yellow-fg}Hay una tarea en curso; compacto cuando termine (o cancela).{/}');
    if (!session.sessionId) return log('{gray-fg}No hay sesión que compactar todavía.{/}');
    const before = session.lastCtx || 0;
    log(`{yellow-fg}🗜 Compactando el contexto (${reason || 'manual'})${before ? ' · ' + kfmt(before) + ' tokens' : ''} con Haiku, sin herramientas…{/}`);
    ctxWarned = false;
    const s = await session.compact().catch((e) => { log(`{red-fg}${esc(e.message)}{/}`); return null; });
    if (s) {
      drift.reset();
      log(`{green-fg}✔ Contexto compactado{/}${before ? ' (de ' + kfmt(before) + ' tokens a un resumen de ' + kfmt(Math.round(s.length / 4)) + ')' : ''}. La próxima instrucción arranca limpia con ese resumen y las reglas reforzadas.`);
    }
    refresh();
    setTimeout(drainNext, 60);
    focusInput();
  }

  function showLessons() {
    const l = lessonsInfo(cwd);
    if (!l.exists) return log(`{gray-fg}Aún no hay lecciones. Pulsa «Instalar reglas» y Claude irá apuntando en ${esc(lessonsRel(cwd))} lo que aprenda al arreglar bugs.{/}`);
    log(`\n{bold}Lecciones del proyecto{/bold} (${l.count})${l.count > 40 ? ' {yellow-fg}— son muchas: pulsa «Condensar lecciones» para ahorrar tokens{/}' : ''}\n${l.lines.slice(-12).map((x) => '  ' + esc(x)).join('\n') || '  {gray-fg}(vacío){/}'}`);
  }

  function setName(arg) {
    const n = String(arg || '').trim();
    if (!n) return log(`Tu nombre actual es «${esc(settings.userName)}». Cámbialo con /nombre TuNombre`);
    settings.userName = n;
    drift.name = n;
    drift.reset();
    persist();
    refresh();
    log(`{green-fg}Nombre → ${esc(n)}{/}. Pulsa «Instalar reglas» para actualizar CLAUDE.md.`);
  }

  function setBudget(arg) {
    const a = String(arg || '').trim().toLowerCase();
    if (!a) return log(`Presupuesto por instrucción: ${settings.maxBudget ? '$' + settings.maxBudget : 'sin límite'}. Usa /presupuesto 2  o  /presupuesto off`);
    if (a === 'off') settings.maxBudget = null;
    else if (Number(a) > 0) settings.maxBudget = Number(a);
    else return log('{red-fg}Usa un número de dólares o "off".{/}');
    persist();
    log(settings.maxBudget ? `{green-fg}Cada instrucción parará al llegar a ~$${settings.maxBudget} (estimado).{/}` : '{green-fg}Sin límite de presupuesto.{/}');
  }

  // ---------- Documentación (MDs) ----------
  function rescanDocs() {
    docs = scanDocs(cwd);
    session.docs = docs;
    return docs;
  }
  function docsStatusText() {
    const ds = digestState(cwd, docs);
    if (!readable(docs).length) return 'sin MDs que resumir';
    return ds.fresh ? '{green-fg}resumen al día{/}' : ds.exists ? '{yellow-fg}resumen desactualizado{/}' : '{yellow-fg}sin resumen{/}';
  }
  function showDocs(arg) {
    const a = String(arg || '').trim().toLowerCase();
    if (a === 'off' || a === 'on') {
      settings.contextDocs = a === 'on';
      persist();
      return log(settings.contextDocs ? '{green-fg}Contexto de MDs activado: índice en la política + lectura inicial barata.{/}' : 'Contexto de MDs desactivado (Claude seguirá leyendo CLAUDE.md por su cuenta).');
    }
    rescanDocs();
    const extras = contextFiles(cwd);
    if (!docs.length) return log(`{gray-fg}No encuentro MDs en esta carpeta (README, docs/…). Si los creas, aparecerán aquí. Puedes generar el contexto igualmente con «${CONTEXT_LABEL}» a partir del código y la configuración.{/}`);
    log(`\n{bold}Documentación del proyecto{/bold} (${docs.length} MDs) · ${docsStatusText()} · contexto: ${settings.contextDocs !== false ? 'activo' : 'desactivado'}\n${docs.slice(0, 20).map((d) => `  ${esc(d.rel)}${d.title ? ' {gray-fg}— ' + esc(d.title) + '{/}' : ''}`).join('\n')}${docs.length > 20 ? `\n  {gray-fg}… y ${docs.length - 20} más{/}` : ''}\n  Configuración que cuenta: ${extras.length ? extras.map(esc).join(', ') : '—'}\n  {gray-fg}«${CONTEXT_LABEL}» (/contexto) los condensa en ${esc(CONTEXT_REL)}, que CLAUDE.md importa: las sesiones siguientes entran en contexto casi gratis.{/}`);
  }
  function doContext() {
    rescanDocs();
    pending = null;
    send(contextPrompt(docs, contextFiles(cwd), contextRel(cwd)), { label: CONTEXT_LABEL, main: 'haiku' });
    focusInput();
  }


  // ---------- Guardia de archivos y avisos ----------
  function toggleSetting(key, arg, name, onText, offText) {
    const a = String(arg || '').trim().toLowerCase();
    settings[key] = ['on', 'si', 'sí'].includes(a) ? true : ['off', 'no'].includes(a) ? false : settings[key] === false;
    log(settings[key] ? `{green-fg}${name}: sí.{/} ${onText}` : `{bold}${name}: no.{/} ${offText}`);
    persist();
    refresh();
  }
  const relOf = (p) => { const r = path.relative(cwd, p); return r && !r.startsWith('..') ? r : p; };
  function askOverwrite(files) {
    permAsk = { files, ts: Date.now() };
    const list = files.map((f) => '  • ' + esc(relOf(f))).join('\n');
    log(`\n{yellow-fg}🛡 Claude quiso reescribir entero ${files.length > 1 ? 'estos archivos, que ya existían' : 'un archivo que ya existía'} y lo he bloqueado:{/}\n${list}\n  {bold}¿Le dejo sobrescribir?{/} Pulsa «Permitir» (vale solo para la próxima tarea) o «Denegar». En terminal: /sobrescribir o /no-sobrescribir.`);
    notify('ask', 'Claude necesita tu permiso', `Quiere sobrescribir ${files.length > 1 ? files.length + ' archivos' : relOf(files[0])}.`);
    refresh();
  }
  function permAllow() {
    if (!permAsk) return log('{gray-fg}No hay nada pendiente de permiso.{/}');
    const files = permAsk.files;
    permAsk = null;
    session.approveFiles(files);
    log(`{green-fg}✔ Permitido sobrescribir:{/} ${esc(files.map(relOf).join(', '))} {gray-fg}(solo en la próxima tarea){/}`);
    launch([], `Antes intentaste reescribir entero ${files.map(relOf).join(', ')} y se bloqueó. Ahora el usuario te lo permite SOLO para ${files.length > 1 ? 'esos archivos' : 'ese archivo'}: repite lo que estabas haciendo.`, [], '', true);
    refresh();
  }
  function permDeny() {
    if (!permAsk) return log('{gray-fg}No hay nada pendiente de permiso.{/}');
    permAsk = null;
    log('{gray-fg}Vale: esos archivos no se tocan.{/}');
    refresh();
  }

  // ---------- Plugins y servidores MCP (Blender, Godot…) ----------
  const IS_WIN = process.platform === 'win32';
  const MCP_PRESETS = {
    blender: {
      label: 'Blender', name: 'blender', cmd: ['uvx', 'blender-mcp'], needs: 'uv',
      allow: ['mcp__blender', 'Bash(blender:*)'],
      after: 'Falta una cosa en Blender: instala su addon (addon.py del repo https://github.com/ahujasid/blender-mcp: Edit > Preferences > Add-ons > Install…) y pulsa «Connect» en la pestaña BlenderMCP del panel lateral (tecla N). Con Blender abierto y conectado, Claude ya puede crear y modificar la escena.',
    },
    godot: {
      label: 'Godot', name: 'godot', cmd: ['npx', '@coding-solo/godot-mcp'], needs: 'npx',
      allow: ['mcp__godot', 'Bash(godot:*)'],
      after: 'Necesita Godot instalado. Si no lo encuentra solo, vuelve a instalarlo con la ruta: /mcp-instalar godot C:\\ruta\\a\\Godot.exe',
    },
  };
  const hasBin = (b) => { if (process.env.CR_NO_BIN_CHECK) return true; try { return spawnSync(IS_WIN ? 'where' : 'which', [b], { encoding: 'utf8' }).status === 0; } catch { return false; } };
  // En Windows nativo, npx hay que lanzarlo con cmd /c (si no, Claude Code no lo arranca)
  const winWrap = (cmd) => (IS_WIN && /^npx(\.cmd)?$/i.test(cmd[0]) ? ['cmd', '/c', ...cmd] : cmd);
  function runClaude(args, label) {
    return new Promise((resolve) => {
      const c = claudeCmd(args);
      let out = '';
      const child = nodeSpawn(c.file, c.args, { shell: c.shell, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const t = setTimeout(() => { try { child.kill(); } catch { /* nada */ } }, 90000);
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (out += d));
      child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
      child.on('exit', (code) => { clearTimeout(t); resolve({ code, out: out.trim() }); });
      if (label) log(`{gray-fg}$ claude ${esc(args.join(' '))}{/}`);
    });
  }
  const showOut = (r) => { if (r.out) log(r.out.split('\n').slice(0, 25).map((l) => '  {gray-fg}' + esc(l) + '{/}').join('\n')); };

  async function mcpAdd(name, cmdArgs, { env = {}, allow = [], after = '' } = {}) {
    if (!/^[\w-]+$/.test(name)) return log('{red-fg}El nombre del MCP solo puede llevar letras, números, - y _.{/}');
    if (!cmdArgs.length) return log('{red-fg}Falta el comando del servidor, p. ej. /mcp-añadir miweb npx -y paquete{/}');
    if (session.busy) return log('{yellow-fg}Hay una tarea en curso; instala el MCP cuando termine.{/}');
    const args = ['mcp', 'add', '--scope', 'user'];
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push(name, '--', ...winWrap(cmdArgs));
    log(`{yellow-fg}Instalando el MCP «${esc(name)}» en tu Claude (para todos tus proyectos)…{/}`);
    const r = await runClaude(args, true);
    if (r.code !== 0 && !/already exists/i.test(r.out)) {
      showOut(r);
      log(`{red-fg}No se pudo instalar el MCP «${esc(name)}».{/} {gray-fg}Comprueba que tienes Claude Code actualizado (/actualizar) y que el comando existe.{/}`);
      return refresh();
    }
    if (/already exists/i.test(r.out)) log(`{gray-fg}«${esc(name)}» ya estaba instalado; lo dejo como está.{/}`);
    const rules = allow.filter((x) => !session.extraAllow.includes(x));
    if (rules.length) {
      session.extraAllow = [...session.extraAllow, ...rules];
      setProject(cwd, { allow: session.extraAllow });
    }
    log(`{green-fg}✔ MCP «${esc(name)}» instalado.{/} Desde tu próxima instrucción Claude ve sus herramientas.${rules.length ? `\n  {gray-fg}Permitido sin preguntar en este proyecto: ${esc(rules.join(', '))} (quítalo cuando quieras con tu configuración).{/}` : ''}${after ? '\n  ' + esc(after) : ''}`);
    refresh();
    focusInput();
  }

  async function mcpInstallPreset(arg) {
    const [key, ...rest] = String(arg || '').trim().split(/\s+/);
    const p = MCP_PRESETS[String(key || '').toLowerCase()];
    if (!p) return log(`Uso: /mcp-instalar ${Object.keys(MCP_PRESETS).join('|')}   (o /mcp-añadir nombre comando… para cualquier otro)`);
    if (!hasBin(p.needs)) {
      return log(p.needs === 'uv'
        ? `{yellow-fg}Para el MCP de ${p.label} hace falta «uv» (uvx) y no lo encuentro.{/} Instálalo y reinicia cla:\n  Windows (PowerShell): powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"\n  Mac/Linux: curl -LsSf https://astral.sh/uv/install.sh | sh`
        : `{yellow-fg}Para el MCP de ${p.label} hace falta Node.js (npx) y no lo encuentro.{/}`);
    }
    const env = {};
    const gp = rest.join(' ').replace(/^["']|["']$/g, '');
    if (key.toLowerCase() === 'godot' && gp) env.GODOT_PATH = gp;
    return mcpAdd(p.name, p.cmd, { env, allow: p.allow, after: p.after });
  }

  function mcpAddCustom(arg) {
    const t = String(arg || '').trim().split(/\s+/).filter(Boolean);
    if (t.length < 2) return log('Uso: /mcp-añadir nombre comando [args…]   p. ej.  /mcp-añadir docs npx -y @upstash/context7-mcp\n{gray-fg}Se instala en tu Claude para todos los proyectos y se permite solo ese MCP (mcp__nombre).{/}');
    const [name, ...cmd] = t;
    return mcpAdd(name, cmd, { allow: [`mcp__${name}`] });
  }

  async function mcpList() {
    log('{gray-fg}Consultando los MCP de tu Claude…{/}');
    const r = await runClaude(['mcp', 'list']);
    if (!r.out) log('{gray-fg}No hay MCP instalados. Prueba «Conectar Blender» o «Conectar Godot».{/}');
    else log(`\n{bold}MCP instalados{/bold}`), showOut(r);
  }

  async function mcpRemove(arg) {
    const name = String(arg || '').trim();
    if (!/^[\w-]+$/.test(name)) return log('Uso: /mcp-quitar nombre   (mira los nombres con /mcp)');
    const r = await runClaude(['mcp', 'remove', '--scope', 'user', name], true);
    showOut(r);
    if (r.code === 0) {
      session.extraAllow = session.extraAllow.filter((x) => x !== `mcp__${name}`);
      setProject(cwd, { allow: session.extraAllow });
      log(`{green-fg}MCP «${esc(name)}» quitado.{/}`);
    }
  }

  async function pluginInstall(arg) {
    const spec = String(arg || '').trim();
    if (!spec || /\s/.test(spec)) return log('Uso: /plugin-instalar nombre@mercado   p. ej.  /plugin-instalar engineering@claude-plugins-official\n{gray-fg}Si el mercado es nuevo, antes: /plugin-mercado usuario/repositorio{/}');
    log(`{yellow-fg}Instalando el plugin ${esc(spec)}…{/}`);
    const r = await runClaude(['plugin', 'install', spec], true);
    showOut(r);
    log(r.code === 0 ? '{green-fg}✔ Plugin instalado.{/} Se carga desde tu próxima instrucción.' : '{red-fg}No se pudo instalar el plugin (¿nombre o mercado incorrectos? Mira /plugin-lista).{/}');
  }
  async function pluginMarket(arg) {
    const src = String(arg || '').trim();
    if (!src || /\s/.test(src)) return log('Uso: /plugin-mercado usuario/repositorio   (añade un mercado de plugins de GitHub)');
    const r = await runClaude(['plugin', 'marketplace', 'add', src], true);
    showOut(r);
    log(r.code === 0 ? '{green-fg}✔ Mercado añadido.{/} Ahora /plugin-instalar nombre@mercado.' : '{red-fg}No se pudo añadir el mercado.{/}');
  }
  async function pluginList() {
    const r = await runClaude(['plugin', 'list']);
    log(r.out ? '\n{bold}Plugins{/bold}' : '{gray-fg}No hay plugins instalados.{/}');
    showOut(r);
  }

  // ¿Hace falta administrador? Si una herramienta falla por permisos del sistema, lo decimos claro
  const ADMIN_RE = /requires? elevation|run as administrator|administrator privileges|acceso denegado|access is denied|EACCES|EPERM|operation not permitted/i;
  let adminHinted = false;
  function adminHint(text) {
    if (adminHinted || !ADMIN_RE.test(String(text || ''))) return;
    adminHinted = true;
    notify('admin', 'Hace falta administrador', 'Escribe /admin para reabrir cla con permisos de administrador.');
    log(`{yellow-fg}🛡 Parece que esa acción necesita permisos de administrador del sistema.{/} Escribe {bold}/admin{/bold} para reabrir cla como administrador (Windows te pedirá confirmar), o ábrelo tú con clic derecho → Ejecutar como administrador.`);
  }
  function relaunchAdmin() {
    if (!IS_WIN) return log('{gray-fg}/admin es para Windows. En Mac/Linux abre cla con sudo solo si es imprescindible (no se recomienda).{/}');
    if (session.busy) return log('{yellow-fg}Espera a que termine la tarea en curso.{/}');
    const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
    const argList = [process.argv[1], ...process.argv.slice(2)].map(q).join(',');
    log('{yellow-fg}Reabriendo cla como administrador… Windows te pedirá permiso; esta ventana se cerrará.{/}');
    const ps = `Start-Process -FilePath ${q(process.execPath)} -ArgumentList ${argList} -WorkingDirectory ${q(cwd)} -Verb RunAs`;
    const child = nodeSpawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => log(`{red-fg}No pude pedir administrador: ${esc(e.message)}{/}`));
    child.on('exit', (code) => {
      if (code === 0) setTimeout(() => ui.quit(), 800);
      else log('{red-fg}No se concedió el permiso de administrador (¿cancelaste el aviso?).{/}');
    });
  }

  // ---------- Permisos ----------
  function addAllow(arg) {
    const rule = String(arg || '').trim();
    if (!rule) return log('Uso: /permitir Bash(blender:*)   ·   /permitir Bash(npm run dev:*)   ·   /permitidos para ver la lista');
    if (!/^[A-Za-z0-9_-]+(\(.+\))?$/.test(rule)) return log('{red-fg}Formato: Herramienta o Herramienta(patrón), p. ej. Bash(blender:*){/}');
    session.extraAllow = [...new Set([...session.extraAllow, rule])];
    setProject(cwd, { allow: session.extraAllow });
    log(`{green-fg}Permitido en este proyecto: ${esc(rule)}{/} {gray-fg}(se aplica desde la próxima instrucción){/}`);
  }
  function showAllow() {
    log(`\n{bold}Permitido sin preguntar{/bold} (en modo acceptEdits Claude no puede pedirte permiso, así que lo que no esté aquí se deniega)\n  de serie: ${DEFAULT_ALLOW.length} reglas (git de lectura, ls/cat/grep, npm/pytest/dotnet/mvn/gradle test y build, web)\n  tuyas: ${session.extraAllow.concat(settings.allow || []).map(esc).join(', ') || '—'}\n  Bloqueado: git push / reset --hard / clean ${settings.blockPush !== false ? '(activo)' : '(desactivado con /push on)'}\n  {gray-fg}Añade con /permitir Bash(blender:*){/}`);
  }

  // ---------- Git: ver cambios, deshacer, rehacer ----------
  function showChanges() {
    const c = gitx.changes(cwd);
    if (!c.ok) return log(`{yellow-fg}${esc(c.error)}{/}`);
    if (c.empty) return log('{gray-fg}Sin cambios desde la última instrucción.{/}');
    const colored = c.diff.split('\n').map((l) => {
      if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ')) return `{bold}${esc(l)}{/bold}`;
      if (l.startsWith('@@')) return `{cyan-fg}${esc(l)}{/}`;
      if (l.startsWith('+')) return `{green-fg}${esc(l)}{/}`;
      if (l.startsWith('-')) return `{red-fg}${esc(l)}{/}`;
      return `{gray-fg}${esc(l)}{/}`;
    });
    log(`\n{bold}Cambios desde «${esc(c.from)}»{/bold}\n${esc(c.stat)}\n${colored.join('\n')}${c.truncated ? `\n{gray-fg}… y ${c.truncated} líneas más (usa git diff para verlas){/}` : ''}`);
  }
  function doUndo() {
    if (session.busy) return log('{yellow-fg}Espera a que termine la tarea (o cancélala) antes de deshacer.{/}');
    const r = gitx.undo(cwd);
    if (!r.ok) return log(`{yellow-fg}${esc(r.error)}{/}`);
    updateCkpt();
    log(`{green-fg}↶ Deshecho: la carpeta vuelve a como estaba antes de «${esc(r.label)}».{/} {gray-fg}(${r.removed} archivos nuevos quitados). /rehacer lo recupera.{/}`);
    refresh();
    focusInput();
  }
  function doRedo() {
    if (session.busy) return log('{yellow-fg}Espera a que termine la tarea (o cancélala).{/}');
    const r = gitx.redo(cwd);
    if (!r.ok) return log(`{yellow-fg}${esc(r.error)}{/}`);
    updateCkpt();
    log('{green-fg}↷ Rehecho: recuperado lo que habías deshecho.{/}');
    refresh();
    focusInput();
  }
  function doGitInit() {
    const r = gitx.gitInit(cwd);
    if (!r.ok) return log(`{red-fg}No pude iniciar git: ${esc(r.err || 'git no está instalado')}{/}`);
    repo = true;
    updateCkpt();
    log(r.already ? '{gray-fg}Ya es un repositorio git.{/}' : '{green-fg}✔ Repositorio git iniciado: desde ahora hay foto antes de cada instrucción y puedes /deshacer.{/}');
    refresh();
    focusInput();
  }

  // ---------- Cola de tareas ----------
  function resolveQueueItem(text) {
    const t = text.trim();
    if (t.startsWith('/')) {
      const a = actions.find((x) => x.cmd === t.split(/\s+/)[0]);
      if (a && a.prompt) return { text: a.prompt, label: a.label, main: a.main };
      if (a) return null;
    }
    return { text: t, label: null, main: null };
  }
  function queueAdd(text) {
    const t = String(text || '').trim();
    if (!t) { pending = { queue: true, label: 'Añadir a la cola' }; ui.setInput(''); log('{gray-fg}Escribe la tarea para la cola (o un comando como /auditoria) y pulsa Enter.{/}'); refresh(); return focusInput(); }
    const item = resolveQueueItem(t);
    if (!item) return log('{red-fg}Ese comando necesita que escribas algo; escribe la instrucción completa.{/}');
    queue.add(item.text, { label: item.label, main: item.main });
    log(`{green-fg}➕ En la cola (${queue.items.length}):{/} ${esc(item.label || item.text.slice(0, 70))}`);
    refresh();
  }
  function queueShow() {
    if (!queue.items.length) return log('{gray-fg}La cola está vacía. Añade con «Añadir a la cola» o /cola texto.{/}');
    log(`\n{bold}Cola (${queue.items.length}){/bold}\n${queue.items.map((q, i) => `  ${i + 1}. ${esc(q.label || q.text.replace(/\s+/g, ' ').slice(0, 80))}${q.main ? ' {gray-fg}[' + q.main + ']{/}' : ''}`).join('\n')}\n  {gray-fg}/cola-run [tope$] ejecuta · /cola-quitar N · /cola-limpiar{/}`);
  }
  async function queueRun(arg) {
    if (queueRunning) return log('{yellow-fg}La cola ya se está ejecutando (cancela para pararla).{/}');
    if (session.busy) return log('{yellow-fg}Hay una tarea en curso.{/}');
    if (!queue.items.length) return log('{gray-fg}La cola está vacía.{/}');
    const limit = Number(String(arg || '').replace('$', '')) || null;
    queueRunning = true;
    log(`\n{bold}▶ Ejecutando cola: ${queue.items.length} tareas{/bold}${limit ? ` {gray-fg}(parará al llegar a ~$${limit}){/}` : ''}. Cancela para pararla.`);
    refresh();
    const res = await queue.runAll(session, {
      limitUsd: limit,
      before: (it, i, n) => { lastLabel = ''; currentLabel = it.label || null; log(`\n{bold}› [${i}/${n}] ${esc(it.label || it.text.replace(/\s+/g, ' ').slice(0, 70))}{/bold}`); },
      between: async () => { const q = afterIdle.splice(0); for (const fn of q) await fn(); },
    }).catch((e) => ({ done: 0, total: 0, remaining: queue.items.length, cost: 0, stopReason: e.message }));
    queueRunning = false;
    setTimeout(drainNext, 80);
    log(`\n{bold}■ Cola ${res.stopReason ? 'detenida' : 'terminada'}{/bold}: ${res.done}/${res.total} hechas · quedan ${res.remaining} · ~$${res.cost.toFixed(2)}${res.stopReason ? ' · ' + esc(res.stopReason) : ''}${repo ? '\n  {gray-fg}Mira /cambios y, si algo no te gusta, /deshacer.{/}' : ''}`);
    refresh();
    focusInput();
  }

  // ---------- Estado y ayuda ----------
  function status() {
    const v = session.version;
    const agents = Object.entries(session.agents).map(([n, a]) => `${n}→${tierOf(a.model)}`).join('  ');
    const l = lessonsInfo(cwd);
    log(`
{bold}Estado{/bold}
  claude-router: v${esc(currentVersion())}   Claude Code: ${v.installed ? v.text || 'instalado' : '{red-fg}no encontrado{/}'}   sesión: ${auth.loggedIn ? '{green-fg}' + esc(auth.method || 'activa') + '{/}' : '{red-fg}sin login{/}'}
  Carpeta: ${esc(cwd)}
  Stack detectado: ${stack.summary ? esc(stack.summary) : '{gray-fg}genérico{/}'}
  Perfil: ${PROFILES[session.profile].label}   permisos: ${session.permission}   principal: ${MODELS[PROFILES[session.profile].main]}
  Reglas en CLAUDE.md: ${hasRules(cwd) ? '{green-fg}instaladas{/}' : '{yellow-fg}no (pulsa «Instalar reglas»){/}'}   nombre: «${esc(settings.userName)}»   lecciones: ${l.count}
  MDs del proyecto: ${docs.length} · ${docsStatusText()} · contexto ${settings.contextDocs !== false ? 'activo' : 'desactivado'}
  Auto-compactar: ${settings.autoCompact ? 'sí' : 'no'} (a partir de ${kfmt(settings.compactAt)} tokens)   presupuesto: ${settings.maxBudget ? '$' + settings.maxBudget : 'sin límite'}
  Verificación: ${settings.verify} (efectiva: ${effectiveVerify(settings.verify, session.profile)})   recordatorio de reglas cada ${settings.remindEvery || '—'} instrucciones
  Git: ${repo ? `{green-fg}sí{/}, ${ckptCount} fotos guardadas (/deshacer)` : '{yellow-fg}no es repositorio: sin red de seguridad (/git-init){/}'}   push bloqueado: ${settings.blockPush !== false ? 'sí' : 'no'}
  Subagentes base (${Object.keys(session.agents).length}): ${agents}   plan previo: ${settings.planPreview !== false ? 'sí' : 'no'}
  ${process.env.ANTHROPIC_API_KEY ? '{yellow-fg}ANTHROPIC_API_KEY definida: puede usarse la API de pago.{/}' : '{gray-fg}Sin ANTHROPIC_API_KEY: se usa tu suscripción.{/}'}`);
  }

  function showStack() {
    log(`\n{bold}Stack{/bold}: ${stack.summary || 'no reconozco nada concreto (genérico)'}\n  Especialistas del proyecto (los que aparecen si no dices otra cosa): ${stack.hints.length ? stack.hints.join(', ') : 'ninguno'}\n  Subagentes base: explorador, limpiador, probador, documentador, investigador, revisor, depurador, verificador, arquitecto\n  Propios: ${Object.keys(custom.agents).join(', ') || '—'} {gray-fg}(.claude-router.json){/}\n  {gray-fg}/especialistas lista los que existen. Solo se cargan cuando la tarea toca su tecnología: cada subagente listado cuesta tokens.{/}`);
  }

  function showSpecialists() {
    log(`\n{bold}Especialistas bajo demanda{/bold} {gray-fg}(no están siempre activos: aparecen solo cuando la tarea toca su tecnología){/}\n${SPEC_KEYS.map((k) => `  ${esc(SPECIALISTS[k].tag.padEnd(12))} {gray-fg}${esc(SPECIALISTS[k].description.replace(/ \(mid-tier\)\./, ' —').slice(0, 110))}{/}`).join('\n')}\n  {gray-fg}Detectados en este proyecto: ${stack.hints.length ? stack.hints.map((k) => SPECIALISTS[k].tag).join(', ') : 'ninguno'}{/}`);
  }

  function help() {
    log(`
{bold}Cómo funciona{/bold}
  Escribes UNA instrucción, o pulsas uno o VARIOS botones (se van sumando en la bandeja) y le añades lo que quieras: al enviar se hace todo junto en una sola instrucción. Si lo escribes con tus palabras («optimiza el código», «créame X y optimízalo») reconozco los flujos que ya existen y los uso (/autoflujos on|off; «!» al principio = literal). Dentro de ella, el modelo principal reparte el trabajo:
    {green-fg}● Haiku{/}   explorar, borrar líneas muertas, tests, docs, buscar en la web
    {cyan-fg}● Sonnet{/}  implementar, coordinar, depurar, revisar y verificar
    {magenta-fg}● Opus{/}    decisiones difíciles (arquitectura, bugs rebeldes)
  Los FLUJOS encadenan agentes (explorar → diseñar → implementar → probar+revisar → verificar), con los pasos independientes en paralelo.
  Antes de ejecutar te enseño el PLAN con checks (todo marcado): desmarcas lo que no quieras y Enter lo ejecuta (/plan on|off). Los ESPECIALISTAS (Python, C++, C#, Java, Node, HTML/CSS, SQL, Blender…) solo aparecen cuando la tarea toca su tecnología (/especialistas).

{bold}Seguridad{/bold}
  Antes de cada instrucción se guarda una foto de la carpeta (si hay git): /cambios ver · /deshacer · /rehacer.
  git push / reset --hard / clean están bloqueados dentro de Claude (/push on para permitir).

{bold}Memoria (que no se le vaya la olla){/bold}
  Regla «empieza siempre con «${esc(settings.userName)}»» en el prompt Y en CLAUDE.md, con recordatorio automático cada ${settings.remindEvery || '—'} instrucciones.
  Si una respuesta no empieza con tu nombre → aviso ⚠, refuerzo; a la 2ª seguida compacto solo (Haiku resume).
  Lecciones: Claude apunta en ${esc(LESSONS_REL)} lo que aprende al arreglar bugs y lo reutiliza.
  Contexto: los MDs del proyecto se indexan; «Leer MDs (contexto)» los condensa en ${esc(CONTEXT_REL)} (Haiku) y CLAUDE.md lo importa. /docs los lista.

{bold}Cola de tareas{/bold}  /cola texto (o /auditoria…) · /cola-ver · /cola-run [tope$] · /cola-quitar N · /cola-limpiar

{bold}Comandos{/bold}
  ${actions.map((a) => a.cmd).join('  ')}
  /cambios /deshacer /rehacer /git-init /informe [días] /lecciones /docs /contexto /stack /verificar /permitir X /permitidos /push /recordatorio N
  /reglas /recordar /sobrescribir /no-sobrescribir /proteger /avisos /mcp /mcp-instalar blender|godot /mcp-añadir /mcp-quitar /plugin-instalar /plugin-mercado /plugin-lista /admin /info X /compactar /compactar-en N /auto-compactar /continuar /nombre X /presupuesto N|off /autoflujos /plan /especialistas /siguientes /seguir /actualizar
  /perfil /permisos /login /logout /nuevo /gasto /estado /cancelar /ayuda /salir
${ui.shortcuts ? '\n{bold}Atajos{/bold}  ' + ui.shortcuts : ''}`);
  }

  function quit() {
    session.cancel();
    queue.stop();
    ui.quit();
  }

  const SYSTEM = {
    '/perfil': cycleProfile,
    '/permisos': cyclePerm,
    '/verificar': setVerify,
    '/login': doLogin,
    '/logout': doLogout,
    '/nuevo': newSession,
    '/continuar': continueLast,
    '/gasto': showCost,
    '/informe': showReport,
    '/estado': status,
    '/stack': showStack,
    '/reglas': doRules,
    '/recordar': doRemind,
    '/recordatorio': setRemind,
    '/lecciones': showLessons,
    '/docs': showDocs,
    '/contexto': doContext,
    '/compactar': () => doCompact('manual'),
    '/sobrescribir': permAllow,
    '/no-sobrescribir': permDeny,
    '/proteger': (a) => toggleSetting('guard', a, 'Protección de archivos', 'Claude NO puede sobrescribir un archivo que ya existía sin tu permiso (te avisa y eliges Permitir o Denegar).', 'Claude puede reescribir archivos existentes sin preguntar.'),
    '/avisos': (a) => toggleSetting('notify', a, 'Avisos del sistema', 'Te aviso con una notificación cuando necesite algo de ti, termine una tarea larga o falle algo.', 'Sin notificaciones del sistema.'),
    '/mcp': mcpList,
    '/mcp-instalar': mcpInstallPreset,
    '/mcp-añadir': mcpAddCustom,
    '/mcp-quitar': mcpRemove,
    '/plugin-instalar': pluginInstall,
    '/plugin-mercado': pluginMarket,
    '/plugin-lista': pluginList,
    '/admin': relaunchAdmin,
    '/info': (arg) => {
      const q = String(arg || '').trim().toLowerCase().replace(/^\//, '');
      const a = actions.find((x) => x.cmd.slice(1) === q || x.label.toLowerCase().includes(q));
      if (!q || !a) return log('{gray-fg}Escribe /info y el nombre de una etiqueta, p. ej. /info optimizar. Las etiquetas: ' + esc(actions.map((x) => x.cmd.slice(1)).join(', ')) + '{/}');
      const i = actionInfo(a);
      const TN = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
      log(`\n{bold}${esc(a.label)}{/bold}  {gray-fg}${esc(a.cmd)}{/}\n${esc(i.what)}\n  {gray-fg}${esc(i.main)}{/}` +
        (i.agents.length ? `\n  {bold}Usa ${i.agents.length} agente${i.agents.length > 1 ? 's' : ''}:{/bold}\n${i.agents.map((g) => `    ● ${g.who} · ${TN[g.tier]} — ${esc(g.does.join(' · '))}`).join('\n')}` : '\n  {gray-fg}No llama a subagentes.{/}') +
        (i.flow && i.steps.length > 1 ? `\n  {bold}Pasos:{/bold} ${esc(i.steps.map((x) => x.label).join(' → '))}` : ''));
    },
    '/compactar-en': (n) => {
      const k = parseInt(String(n || '').replace(/k$/i, ''), 10);
      if (!Number.isInteger(k) || k < 20 || k > 900) return log(`{gray-fg}Compacto a partir de ${kfmt(settings.compactAt)} tokens. Cámbialo con /compactar-en 120 (en miles de tokens, entre 20 y 900).{/}`);
      settings.compactAt = k * 1000;
      ctxWarned = false;
      persist();
      log(`{bold}Compactación automática a partir de ${kfmt(settings.compactAt)} tokens.{/}`);
      refresh();
    },
    '/auto-compactar': toggleAutoCompact,
    '/nombre': setName,
    '/presupuesto': setBudget,
    '/permitir': addAllow,
    '/permitidos': showAllow,
    '/push': setPush,
    '/autoflujos': toggleAutoFlows,
    '/plan': togglePlanPreview,
    '/siguientes': showNext,
    '/siguiente-quitar': (n) => { log(nextRemove(nextQ[parseInt(n, 10) - 1]?.id) ? '' : '{red-fg}Número no válido (mira /siguientes){/}'); },
    '/siguientes-limpiar': nextClear,
    '/seguir': nextResume,
    '/especialistas': showSpecialists,
    '/cambios': showChanges,
    '/deshacer': doUndo,
    '/rehacer': doRedo,
    '/git-init': doGitInit,
    '/cola': queueAdd,
    '/cola-ver': queueShow,
    '/cola-run': queueRun,
    '/cola-quitar': (n) => { const it = queue.remove(parseInt(n, 10)); log(it ? `Quitada de la cola: ${esc(it.label || it.text.slice(0, 60))}` : '{red-fg}Número de tarea no válido (mira /cola-ver){/}'); refresh(); },
    '/cola-limpiar': () => { log(`Cola vaciada (${queue.clear()} tareas).`); refresh(); },
    '/actualizar': doUpdate,
    '/ayuda': help,
    '/cancelar': () => {
      if (queueRunning) queue.stop();
      log(session.cancel() ? '{yellow-fg}Cancelando…{/}' : '{gray-fg}No hay nada en curso.{/}');
    },
    '/salir': quit,
  };

  function handleInner(raw) {
    const text = (raw || '').trim();
    if (planState && (!text.startsWith('/') || text === '/cancelar')) return planInput(text);
    if (!text && !tray.length) return;
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/);
      if (SYSTEM[cmd]) return SYSTEM[cmd](rest.join(' '));
      const a = findAction(cmd);
      if (a) {
        if (!isStackable(a)) return runAction(a);
        if (!tray.includes(a.cmd)) tray.push(a.cmd);
        if (trayActions().some(needsText)) {
          refresh();
          log(`{gray-fg}«${esc(a.label)}» en la bandeja: escribe qué quieres y pulsa Enviar.{/}`);
          return focusInput();
        }
        return sendTray('');
      }
      return log(`{red-fg}Comando desconocido: ${esc(cmd)}{/} (escribe /ayuda)`);
    }
    const p = pending;
    if (p) {
      pending = null;
      if (!text) return undefined;
      if (p.queue) return queueAdd(text);
      return send(p.wrap ? p.wrap(text) : text, { display: p.label ? `${p.label}: ${text}` : text, label: p.label, main: p.main });
    }
    return sendTray(text);
  }

  // Los comandos pueden ser asíncronos (Haiku lee la frase): un error nunca debe tumbar la app
  function handle(raw) {
    try {
      const r = handleInner(raw);
      if (r && typeof r.catch === 'function') r.catch((e) => log(`{red-fg}${esc(e.message)}{/}`));
      return r;
    } catch (e) {
      log(`{red-fg}${esc(e.message)}{/}`);
      return undefined;
    }
  }

  // ---------- Menú (lo pintan la web y la terminal) ----------
  const byGroup = (g) => actions.filter((x) => (x.custom ? 'TUYAS' : x.group || (x.main ? 'MODELO A MANO' : 'PROYECTO')) === g);
  const actionItems = (g) => byGroup(g).map((a) => ({ id: a.cmd, label: a.label, desc: a.hint || '', info: actionInfo(a), stack: isStackable(a), run: () => toggleTray(a) }));
  const prof = () => PROFILES[session.profile];

  function menuDef() {
    const g = [];
    g.push({ name: 'FLUJOS', title: 'Flujos completos', items: actionItems('FLUJOS') });
    g.push({ name: 'PROYECTO', title: 'Proyecto', items: actionItems('PROYECTO') });
    g.push({
      name: 'SEGURIDAD', title: 'Deshacer y cambios',
      items: [
        { id: 'changes', label: 'Ver cambios', desc: 'Qué tocó Claude desde la última foto', run: showChanges },
        { id: 'undo', label: 'Deshacer última', desc: 'Vuelve a como estaba antes de la última instrucción', run: doUndo },
        { id: 'redo', label: 'Rehacer', desc: 'Recupera lo que deshiciste', run: doRedo },
        { id: 'gitinit', label: 'Iniciar git aquí', desc: 'Necesario para las fotos y deshacer', run: doGitInit },
      ],
    });
    g.push({
      name: 'MCP', title: 'Plugins y MCP',
      items: [
        { id: 'mcp-blender', label: 'Conectar Blender (MCP)', desc: 'Instala el MCP de Blender en tu Claude', info: { what: 'Instala el servidor MCP de Blender (blender-mcp) en tu Claude para todos tus proyectos: Claude podrá crear y modificar objetos, materiales y escenas en un Blender abierto. Necesita «uv» instalado y el addon de Blender (te explico el paso al terminar). Permite sin preguntar las herramientas de ese MCP y abrir blender desde la consola en este proyecto.' }, run: () => mcpInstallPreset('blender') },
        { id: 'mcp-godot', label: 'Conectar Godot (MCP)', desc: 'Instala el MCP de Godot en tu Claude', info: { what: 'Instala el servidor MCP de Godot (@coding-solo/godot-mcp) en tu Claude para todos tus proyectos: lanzar el editor, ejecutar proyectos, leer la salida de depuración y crear o editar escenas. Necesita Node.js y Godot instalado; si no lo encuentra, escribe /mcp-instalar godot y la ruta del ejecutable.' }, run: () => mcpInstallPreset('godot') },
        { id: 'mcp-list', label: 'Ver MCP instalados', desc: 'Lista los servidores MCP de tu Claude', info: { what: 'Muestra los servidores MCP que tiene tu Claude y si están conectados.' }, run: mcpList },
        { id: 'mcp-add', label: 'Añadir otro MCP…', desc: 'Cualquier servidor MCP por su comando', info: { what: 'Instala cualquier servidor MCP. Escribe /mcp-añadir nombre comando…, por ejemplo: /mcp-añadir docs npx -y @upstash/context7-mcp. Se instala para todos tus proyectos y solo se permite ese MCP.' }, run: () => { ui.setInput('/mcp-añadir '); focusInput(); } },
        { id: 'plug-add', label: 'Instalar un plugin…', desc: 'Plugins de Claude Code por nombre@mercado', info: { what: 'Instala un plugin de Claude Code (skills, agentes, comandos). Escribe /plugin-instalar nombre@mercado. Si el mercado es nuevo, añádelo antes con /plugin-mercado usuario/repositorio. /plugin-lista muestra los que tienes.' }, run: () => { ui.setInput('/plugin-instalar '); focusInput(); } },
        { id: 'admin', label: 'Reabrir como administrador', desc: 'Para acciones que piden permisos de Windows', info: { what: 'Reabre cla con permisos de administrador de Windows (te saldrá el aviso de confirmación). Úsalo solo si una acción falla por permisos, por ejemplo al controlar aplicaciones del sistema. Con administrador, Claude puede hacer más cosas en tu PC: úsalo solo cuando haga falta.' }, run: relaunchAdmin },
      ],
    });
    g.push({
      name: 'MEMORIA', title: 'Memoria y contexto',
      items: [
        { id: 'rules', label: 'Instalar reglas (CLAUDE.md)', desc: 'Tu nombre al empezar, delegación, lecciones', run: doRules },
        { id: 'remind', label: 'Recordar reglas ya', desc: 'Las antepone a tu próxima instrucción', run: doRemind },
        { id: 'compact', label: 'Compactar ahora', desc: 'Resume la conversación con Haiku', run: () => doCompact('manual') },
        { id: 'auto', label: `Auto-compactar: ${settings.autoCompact ? 'sí' : 'no'}`, desc: 'Compacta solo al crecer el contexto o si se va', run: toggleAutoCompact },
        { id: 'cont', label: 'Continuar última sesión', run: continueLast },
        { id: 'context', label: CONTEXT_LABEL, desc: 'Resume los MDs del proyecto en .claude/contexto.md', run: doContext },
        { id: 'docs', label: 'Ver MDs del proyecto', run: () => showDocs('') },
        { id: 'lessons', label: 'Ver lecciones', run: showLessons },
        ...actionItems('MEMORIA'),
      ],
    });
    g.push({
      name: 'COLA', title: 'Cola (modo noche)',
      items: [
        { id: 'nextshow', label: `A continuación${nextQ.length ? ' (' + nextQ.length + ')' : ''}`, desc: 'Lo que escribes mientras trabajo se pone aquí y empieza solo', run: () => showNext('') },
        { id: 'qadd', label: 'Añadir a la cola', run: () => queueAdd('') },
        { id: 'qrun', label: `Ejecutar cola${queue.items.length ? ' (' + queue.items.length + ')' : ''}`, run: () => queueRun('') },
        { id: 'qshow', label: 'Ver cola', run: queueShow },
        { id: 'qclear', label: 'Vaciar cola', run: SYSTEM['/cola-limpiar'] },
      ],
    });
    g.push({ name: 'MODELO A MANO', title: 'Elegir modelo a mano', items: actionItems('MODELO A MANO') });
    if (byGroup('TUYAS').length) g.push({ name: 'TUYAS', title: 'Tuyas', items: actionItems('TUYAS') });
    g.push({
      name: 'INFORMES', title: 'Informes',
      items: [
        { id: 'report', label: 'Informe de uso (7 días)', run: () => showReport('') },
        { id: 'cost', label: 'Gasto de la sesión', run: showCost },
      ],
    });
    g.push({
      name: 'CLAUDE', title: 'Ajustes y ayuda',
      items: [
        { id: 'profile', label: `Perfil: ${prof().label}`, desc: prof().desc, run: cycleProfile },
        { id: 'perm', label: `Permisos: ${session.permission}`, run: cyclePerm },
        { id: 'autoflows', label: `Reconocer flujos: ${settings.autoFlows !== false ? 'sí' : 'no'}`, desc: 'Si escribes con tus palabras, usa los flujos que ya existen', run: () => toggleAutoFlows('') },
        { id: 'guard', label: `Proteger archivos: ${settings.guard !== false ? 'sí' : 'no'}`, desc: 'Claude no sobrescribe archivos existentes sin tu permiso', info: { what: 'Un guardia revisa cada vez que Claude intenta reescribir ENTERO un archivo que ya existía (los archivos nuevos y los que él creó en la misma tarea pasan sin más). Si pasa, lo bloquea, te avisa con una notificación y eliges Permitir (vale solo para la tarea siguiente) o Denegar. Editar solo una parte con Edit no se bloquea.' }, run: () => SYSTEM['/proteger']('') },
        { id: 'notify', label: `Avisos del sistema: ${settings.notify !== false ? 'sí' : 'no'}`, desc: 'Notificación de Windows cuando necesite algo de ti', info: { what: 'Te avisa con una notificación del sistema (en Windows, el aviso de siempre abajo a la derecha) cuando Claude necesita tu permiso, el plan espera tu OK, termina una tarea larga, falla algo o la cola se pausa, aunque estés en otra ventana. En la web, pulsa la campana para dar permiso al navegador.' }, run: () => SYSTEM['/avisos']('') },
        { id: 'planprev', label: `Plan previo: ${settings.planPreview !== false ? 'sí' : 'no'}`, desc: 'Lista con checks antes de ejecutar', run: () => togglePlanPreview('') },
        { id: 'verify', label: `Verificación: ${settings.verify}`, run: () => setVerify('') },
        { id: 'login', label: 'Login / estado', run: doLogin },
        { id: 'status', label: 'Ver estado completo', run: status },
        { id: 'stack', label: 'Stack y subagentes', run: showStack },
        { id: 'new', label: 'Nueva sesión', run: newSession },
        { id: 'cancel', label: 'Cancelar tarea', run: SYSTEM['/cancelar'] },
        { id: 'update', label: updateInfo?.newer ? `Actualizar a v${updateInfo.latest}` : 'Buscar actualización', run: () => (updateInfo?.newer ? doUpdate() : doCheckUpdate()) },
        { id: 'help', label: 'Ayuda', run: help },
        { id: 'quit', label: 'Salir', run: quit },
      ],
    });
    return g;
  }

  function menu() {
    return menuDef().map((g) => ({
      name: g.name,
      title: g.title,
      open: !settings.collapsed.includes(g.name),
      items: g.items.map((i) => ({ id: i.id, label: i.label, desc: i.desc || '', info: i.info || (i.desc ? { what: i.desc } : null), primary: PRIMARY.has(i.id), stack: !!i.stack, inTray: !!i.stack && tray.includes(i.id) })),
    }));
  }

  function press(id) {
    for (const g of menuDef()) {
      const it = g.items.find((x) => x.id === id);
      if (it) { it.run(); return true; }
    }
    return false;
  }

  // El estado de plegado de los grupos lo guarda quien los pinta
  function setCollapsed(names) {
    settings.collapsed = names;
    persist();
  }

  function snapshot() {
    const st = session.stats;
    const total = TIERS.reduce((a, t) => a + st.tiers[t].out, 0) || 1;
    const pf = prof();
    return {
      cwd,
      project: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd,
      stack: stack.summary || '',
      version: currentVersion(),
      update: updateInfo?.newer ? updateInfo.latest : null,
      updating,
      profile: { key: session.profile, label: pf.label, desc: pf.desc, main: pf.main },
      permission: session.permission,
      auth: { installed: auth.installed !== false, loggedIn: !!auth.loggedIn, method: auth.method || null },
      busy: !!session.busy,
      active: active ? { tier: active.tier, agent: active.agent || null } : null,
      pending: pending ? { label: pending.label || null, main: pending.main || null, queue: !!pending.queue } : null,
      queueRunning,
      routing: thinking ? { start: thinkStart, now: Date.now() } : null,
      next: nextQ.map((q) => ({ id: q.id, label: nextName(q), text: q.text.replace(/\s+/g, ' ').slice(0, 160), specs: q.specs.map((k) => SPECIALISTS[k]?.tag || k) })),
      nextPaused: qPaused,
      perm: permAsk ? { files: permAsk.files.map((f) => ({ path: f, rel: relOf(f) })) } : null,
      guard: settings.guard !== false,
      notify: settings.notify !== false,
      queueLen: queue.items.length,
      tray: trayActions().map((a) => ({ id: a.cmd, label: a.label, needsText: needsText(a) })),
      autoFlows: settings.autoFlows !== false,
      run: session.busy && runMeta ? { start: runMeta.start, now: Date.now(), label: runMeta.label || null, steps: runMeta.steps, done: runMeta.done, delegations: runMeta.delegations, expectedMs: runMeta.est ? runMeta.est.ms : null, basis: runMeta.est ? runMeta.est.basis : null, basisN: runMeta.est ? runMeta.est.n : 0 } : null,
      planPreview: settings.planPreview !== false,
      plan: planState ? { queued: session.busy || queueRunning || nextQ.length > 0, note: planState.note || '', text: planState.text || '', items: planItems(planState.plan) } : null,
      tiers: TIERS.map((t) => ({ tier: t, msgs: st.tiers[t].msgs, inp: st.tiers[t].inp, out: st.tiers[t].out, share: st.tiers[t].out / total })),
      cost: st.cost,
      cacheRatio: st.cacheRatio,
      ctx: st.ctx,
      compactAt: settings.compactAt,
      delegated: lastRunInfo ? { pct: lastRunInfo.delegated, n: lastRunInfo.delegations } : null,
      drift: { total: drift.total, level: drift.level, strikes: drift.strikes },
      userName: settings.userName,
      repo,
      ckptCount,
      verify: effectiveVerify(settings.verify, session.profile),
      remindEvery: settings.remindEvery || 0,
      autoCompact: !!settings.autoCompact,
      docsCount: docs.length,
    };
  }

  // ---------- Detección de deriva ----------
  function checkDrift(text) {
    if (!text || !String(text).trim()) return;
    const d = drift.record(text);
    if (d.ok) return;
    if (settings.autoRecover) session.reinforce = true;
    if (d.level === 1) {
      log(`{yellow-fg}⚠ La respuesta no empezó con «${esc(settings.userName)}». ${settings.autoRecover ? 'Refuerzo las reglas en tu próxima instrucción.' : 'Usa /recordar.'}{/}`);
    } else {
      log(`{red-fg}✖ Claude se está yendo: ${d.strikes} respuestas seguidas sin «${esc(settings.userName)}».{/}`);
      if (settings.autoCompact) afterIdle.push(() => doCompact('deriva detectada'));
      else log('{yellow-fg}Escribe /compactar (o activa Auto-compactar) para que recupere el hilo.{/}');
    }
  }

  // ---------- Eventos de la sesión ----------
  const heading = (tier, agent) => {
    const l = `${tier}${agent ? ' · ' + agent : ''}`;
    if (l !== lastLabel) {
      lastLabel = l;
      log(`{${COLOR[tier]}-fg}● ${esc(l)}{/}`);
    }
  };

  session.on('busy', (b) => {
    if (b && !runMeta) runMeta = { start: Date.now(), label: currentLabel, est: session.silent ? null : history.estimateMs(currentLabel), steps: 0, done: 0, delegations: 0 };
    if (!b) {
      runMeta = null;
      if (ui.stepsClose) ui.stepsClose(Date.now());
      stepInfo.clear();
      active = null;
      if (!queueRunning) {
        const q = afterIdle.splice(0);
        setImmediate(() => q.forEach((fn) => fn()));
      }
      setTimeout(drainNext, 80);
    }
    refresh();
  });
  session.on('checkpoint', (c) => {
    ckptNote = c && c.created ? 'foto guardada' : null;
    if (c && c.skipped && !warnedBig) {
      warnedBig = true;
      log(`{yellow-fg}La carpeta pesa ~${c.mb} MB (tope de fotos: ${c.maxMb} MB): sin foto ni /deshacer. Mete los assets pesados en .gitignore (los archivos de más de 8 MB ya se saltan solos).{/}`);
    }
    if (c === null && repo) repo = gitx.isRepo(cwd);
    updateCkpt();
  });
  session.on('route', ({ main, why, notes, changed }) => {
    const bits = [];
    if (ckptNote) bits.push(ckptNote);
    if (changed) bits.push(`principal: ${main}${why ? ' (' + why + ')' : ''}`);
    bits.push(...notes);
    if (bits.length) log(`{gray-fg}↪ ${esc(bits.join(' · '))}{/}`);
  });
  session.on('active', (a) => { active = a; refresh(); });
  session.on('text', ({ tier, agent, text }) => {
    heading(tier, agent);
    log(esc(text).split('\n').map((l) => '  ' + l).join('\n'));
  });
  session.on('tool', ({ id, tier, agent, name, detail, full }) => {
    if (runMeta) runMeta.steps++;
    if (id) stepInfo.set(id, { start: Date.now(), name, agent, kind: 'tool' });
    if (ui.step) return ui.step({ id: id || 's' + Date.now(), kind: 'tool', tier, agent: agent || null, name, detail, full, start: Date.now() });
    heading(tier, agent);
    log(`  {gray-fg}⚙ ${esc(name)} ${esc(detail)}{/}`);
  });
  session.on('delegate', ({ id, agentType, description, expectedTier, full }) => {
    if (runMeta) { runMeta.steps++; runMeta.delegations++; }
    if (id) stepInfo.set(id, { start: Date.now(), name: agentType, kind: 'agent' });
    if (ui.step) return ui.step({ id: id || 'd' + Date.now(), kind: 'agent', tier: expectedTier, agent: agentType, name: agentType, detail: description, full, start: Date.now() });
    log(`  {${COLOR[expectedTier]}-fg}↳ delegando en {bold}${esc(agentType)}{/bold} (${expectedTier}){/}${description ? ' {gray-fg}' + esc(description) + '{/}' : ''}`);
  });
  session.on('tool-end', ({ id, error, text }) => {
    if (error) adminHint(text);
    const st = stepInfo.get(id);
    if (!st) return;
    stepInfo.delete(id);
    if (runMeta) runMeta.done++;
    const now = Date.now();
    if (ui.stepEnd) return ui.stepEnd({ id, end: now, error });
    if (st.kind === 'agent') log(`  {gray-fg}✓ ${esc(st.name)} terminó en ${fmtDur(now - st.start)}${error ? ' (con error)' : ''}{/}`);
  });
  session.on('stats', () => refresh());
  session.on('result', (r) => {
    const run = r.run;
    const secs = r.ms ? ` · ${(r.ms / 1000).toFixed(0)}s` : '';
    log(`{gray-fg}── ${r.isError ? 'terminó con error' : 'terminado'} · ${r.turns ?? '?'} turnos${secs} · ~$${(run ? run.cost : r.cost).toFixed(2)} esta instrucción · ~$${r.cost.toFixed(2)} sesión ──{/}`);
    if (r.isError && r.text) log(`{red-fg}${esc(String(r.text))}{/}`);
    if (run) {
      lastRunInfo = run;
      const o = run.out;
      const tot = o.haiku + o.sonnet + o.opus || 1;
      const who = [...new Set(run.delegList)].map((n) => `${n}×${run.delegList.filter((x) => x === n).length}`).join(', ');
      log(`{gray-fg}   reparto: {green-fg}haiku ${pct(o.haiku / tot)}{/} {cyan-fg}sonnet ${pct(o.sonnet / tot)}{/} {magenta-fg}opus ${pct(o.opus / tot)}{/} · delegado ${pct(run.delegated)}${who ? ' (' + esc(who) + ')' : ''}{/}`);
      if (run.delegations === 0 && run.mainEdits >= 4) {
        log(`{yellow-fg}   Sonnet editó ${run.mainEdits} veces él solo, sin subagentes. Si era trabajo mecánico, pídele "delega en limpiador" o usa /limpiar; para tareas grandes, los FLUJOS.{/}`);
      }
      history.record({
        cwd, label: currentLabel, cost: run.cost, out: run.out, delegated: run.delegated, delegations: run.delegations,
        mainEdits: run.mainEdits, subEdits: run.subEdits, ms: r.ms, error: r.isError, profile: session.profile,
      });
    }
    if (session.sessionId) setProject(cwd, { sessionId: session.sessionId, ts: Date.now() });
    if (currentLabel === CONTEXT_LABEL && !r.isError) {
      rescanDocs();
      log(`{green-fg}📄 Contexto ${digestState(cwd, docs).fresh ? 'guardado' : 'revisado'} en ${esc(contextRel(cwd))}.{/} {gray-fg}Las próximas sesiones lo cargan solas (Instalar reglas añade el import a CLAUDE.md).{/}`);
    }
    if (r.asks && r.asks.length) askOverwrite(r.asks);
    notify(r.isError ? 'fail' : 'done', r.isError ? 'La tarea falló' : 'Tarea terminada', `${currentLabel || 'Instrucción'}${r.ms ? ' · ' + fmtDur(r.ms) : ''}`, r.ms);
    if (!r.isError) { checkDrift(r.text); qPaused = false; } else if (nextQ.length) { qPaused = true; log('{yellow-fg}⏸ La tarea terminó con error: la cola «a continuación» queda en pausa (/seguir para continuar).{/}'); }
    if (!r.bigContext && session.lastCtx >= settings.compactAt * 0.8 && !ctxWarned) {
      ctxWarned = true;
      log(`{yellow-fg}🗜 El contexto va por el ${Math.round(session.lastCtx / settings.compactAt * 100)}% (${kfmt(session.lastCtx)} de ${kfmt(settings.compactAt)}).${settings.autoCompact ? ' Compactaré solo al pasar del límite.' : ' Con /compactar lo resumo cuando quieras.'}{/}`);
    }
    if (r.bigContext) {
      if (settings.autoCompact) { if (!afterIdle.length) afterIdle.push(() => doCompact(`contexto > ${kfmt(settings.compactAt)}`)); }
      else log('{yellow-fg}El contexto ya es grande: /compactar (o "Nueva sesión") te ahorra tokens.{/}');
    }
    if (repo && run && (run.mainEdits + run.subEdits) > 0) log('{gray-fg}   /cambios para ver qué tocó · /deshacer para volver atrás{/}');
    refresh();
  });
  session.on('cancelled', () => {
    log('{yellow-fg}Tarea cancelada.{/}');
    if (nextQ.length) { qPaused = true; notify('queue', 'Cola en pausa', 'Pulsa Seguir para continuar con lo siguiente.'); log('{yellow-fg}⏸ La cola «a continuación» queda en pausa. Pulsa «Seguir» (o /seguir) cuando quieras, o vacíala.{/}'); }
  });
  session.on('failure', (msg) => {
    log(`{red-fg}${esc(msg)}{/}`);
    if (nextQ.length) { qPaused = true; notify('queue', 'Cola en pausa', 'Falló la tarea; la cola espera.'); }
    notify('fail', 'Algo falló', msg);
    if (/auth|login|credential|unauthor|sign in/i.test(msg)) log('{yellow-fg}Parece un problema de sesión: pulsa "Login / estado".{/}');
    if (/unknown option|unknown argument|unrecognized/i.test(msg)) log('{yellow-fg}Tu versión de Claude Code no conoce un flag: ejecuta `claude update` y reintenta.{/}');
  });

  // ---------- Arranque: mensajes iniciales y comprobaciones ----------
  function boot() {
    log('{bold}claude-router{/bold}: el modelo principal coordina, Haiku hace lo mecánico y Opus solo lo difícil, todo dentro de cada instrucción.');
    log(`{gray-fg}Carpeta: ${esc(cwd)}  ·  Pulsa una acción o escribe tu instrucción. /ayuda para más.{/}`);
    if (!session.version.installed) {
      log('{red-fg}No encuentro el comando "claude". Instala Claude Code (npm i -g @anthropic-ai/claude-code) y vuelve a abrir esto.{/}');
    } else {
      if (session.version.text) log(`{gray-fg}Claude Code ${session.version.text}{/}`);
      if (!session.supports([2, 1, 281])) log('{yellow-fg}Tu Claude Code es antiguo para --agents con fichero: ejecuta `claude update`.{/}');
    }
    if (stack.summary) log(`{gray-fg}Stack detectado: ${esc(stack.summary)} → los especialistas (/especialistas) aparecen solos cuando la tarea toca su tecnología.{/}`);
    if (process.env.ANTHROPIC_API_KEY) {
      log('{yellow-fg}Ojo: tienes ANTHROPIC_API_KEY definida; Claude Code puede usar la API (de pago) en vez de tu suscripción. Bórrala si quieres usar solo el login.{/}');
    }
    if (docs.length) {
      const ds = digestState(cwd, docs);
      log(`{gray-fg}📄 ${docs.length} MDs en el proyecto (${esc(docs.slice(0, 3).map((d) => d.rel).join(', '))}${docs.length > 3 ? '…' : ''}). ${ds.fresh ? 'Resumen de contexto al día.' : ds.exists ? 'El resumen de contexto está desactualizado: pulsa «Leer MDs (contexto)».' : 'En tu primera instrucción los leerá explorador (Haiku); «Leer MDs (contexto)» los deja resumidos para siempre.'}{/}`);
    } else {
      log('{gray-fg}📄 No hay MDs en el proyecto: «Crear/actualizar CLAUDE.md» y «Leer MDs (contexto)» parten del código.{/}');
    }
    if (!repo) log('{yellow-fg}Esta carpeta no es un repositorio git: sin fotos ni /deshacer. Pulsa «Iniciar git aquí» (recomendado antes de dejar a Claude editar).{/}');
    if (!hasRules(cwd)) {
      log(`{yellow-fg}Tip: pulsa «Instalar reglas» para que Claude empiece siempre con «${esc(settings.userName)}» (así ves cuándo se le va la olla), apunte lecciones y gaste menos tokens.{/}`);
    }
    const les = lessonsInfo(cwd);
    if (les.count > 40) log(`{yellow-fg}Tienes ${les.count} lecciones: «Condensar lecciones» (Haiku) las deja en 30 y ahorras tokens en cada sesión.{/}`);
    if (queue.items.length) log(`{gray-fg}Hay ${queue.items.length} tareas en la cola de la vez anterior: «Ver cola» / «Ejecutar cola».{/}`);
    if (saved.sessionId) log('{gray-fg}Hay una sesión anterior en esta carpeta: «Continuar última sesión» o /continuar.{/}');
    refresh();
    setTimeout(() => {
      const a = refreshAuth();
      if (a.installed && !a.loggedIn) log('{yellow-fg}No detecto sesión de Claude: pulsa "Login / estado" (se abre el navegador, sin API key).{/}');
    }, 50);
    // Aviso de versión nueva (una vez al día, con tope de 2,5 s y sin molestar si no hay red)
    checkUpdate().then((u) => {
      updateInfo = u;
      if (u?.newer) {
        log(`{yellow-fg}⬆ Hay una versión nueva de claude-router (${esc(u.latest)}, tienes ${esc(currentVersion())}). Pulsa «Actualizar» o escribe /actualizar.{/}`);
        refresh();
      }
    }).catch(() => {});
    focusInput();
  }

  return {
    handle, menu, press, snapshot, boot, planToggle: planToggleId, planRun, planCancel, permAllow, permDeny, skipRouting, nextRemove, nextUp, nextClear, nextResume, cancelPending, setCollapsed, quit, removeFromTray, clearTray,
    cancel: () => SYSTEM['/cancelar'](),
    cwd, session, settings,
    get queueRunning() { return queueRunning; },
    dispose: () => { session.cancel(); queue.stop(); },
  };
}
