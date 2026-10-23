// Controlador de claude-router, independiente de la interfaz: lo usan la web (por defecto) y la terminal (--terminal).
// La vista solo implementa `ui`: { log(texto), setInput(texto), focusInput(), changed(), quit(), shortcuts }.
// Los textos usan etiquetas estilo blessed ({green-fg}, {bold}, {/}); cada vista las pinta a su manera.
import { spawn as nodeSpawn } from 'node:child_process';
import { Session, PROFILES, MODELS, TIERS, tierOf, authStatus, authLogout, claudeCmd, effectiveVerify, DEFAULT_ALLOW } from './core.mjs';
import { ACTIONS } from './actions.mjs';
import { loadSettings, saveSettings, getProject, setProject, loadCustom } from './config.mjs';
import { DriftTracker, installRules, hasRules, lessonsInfo, LESSONS_REL } from './rules.mjs';
import * as gitx from './git.mjs';
import * as history from './history.mjs';
import { detectStack } from './stack.mjs';
import { TaskQueue } from './queue.mjs';
import { scanDocs, digestState, contextFiles, contextPrompt, readable, CONTEXT_REL } from './docs.mjs';
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
  let warnedRouter = false;
  let tray = []; // acciones pulsadas que se enviarán juntas (más lo que escribas) al pulsar Enviar
  let pending = null; // acción a medias: { main, wrap, label, queue } — se aplica a lo que escribas a continuación
  let currentLabel = null; // etiqueta de la instrucción en curso (para historial)
  let ckptNote = null;
  let queueRunning = false;
  let warnedBig = false;
  let lastRunInfo = null;
  let updateInfo = null;
  let updating = false;
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
  function send(prompt, { display, label, main, skipEcho } = {}) {
    if (session.busy) { log('{yellow-fg}Hay una tarea en curso. Cancélala primero.{/}'); return false; }
    lastLabel = '';
    active = null;
    currentLabel = label || null;
    if (!skipEcho) log(`\n{bold}› ${esc(display || label || prompt)}{/bold}`);
    const t = history.typicalCost(label);
    if (t) log(`{gray-fg}≈ $${t.cost.toFixed(2)} suele costar esto (media de ${t.n} veces){/}`);
    session.run(prompt, { label, ...(main ? { main } : {}) }).catch((e) => log(`{red-fg}${esc(e.message)}{/}`));
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
    refresh();
    let out = null;
    try { out = await session.classify(routerPrompt(text, allowed)); } finally { thinking = false; refresh(); }
    const r = out ? parseRouter(out, allowed.map((a) => a.cmd)) : null;
    if (r) return { ...r, how: 'haiku' };
    if (!warnedRouter) {
      warnedRouter = true;
      log('{gray-fg}(No pude consultar a Haiku para entender tu frase; uso el reconocimiento por palabras clave.){/}');
    }
    return { ...localRoute(text), how: 'palabras' };
  }

  // Bandeja + texto → Haiku elige flujos → UNA instrucción (con método general si no encaja ninguno pero es trabajo)
  async function sendTray(raw) {
    if (thinking) return log('{gray-fg}Un segundo, estoy leyendo tu petición…{/}');
    if (session.busy) return log('{yellow-fg}Hay una tarea en curso. Cancélala primero.{/}');
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

    let auto = [];
    let general = false;
    let note = '';
    if (!literal && settings.autoFlows !== false && text) {
      const allowed = actions.filter((a) => isStackable(a) && a.cmd !== '/bug');
      const r = await route(text, allowed);
      if (session.busy) return log('{yellow-fg}Mientras tanto empezó otra tarea; vuelve a enviarlo cuando termine.{/}');
      auto = r.cmds.map(findAction).filter((a) => a && !chosen.includes(a));
      const who = r.how === 'haiku' ? 'Haiku leyó tu petición' : 'Reconozco lo que pides';
      if (auto.length) note = `${who} y usa ${auto.map((a) => a.label).join(' + ')} (ya existe como flujo).`;
      else if (!chosen.length && r.kind === 'tarea') { general = true; note = `${who}: no encaja con un flujo concreto, pero es un trabajo de verdad → método general (explorar → planificar → hacer → comprobar → optimizar → verificar, con subagentes).`; }
      else if (!chosen.length && r.kind === 'pequeno') note = `${who}: cambio pequeño, lo hago directo (delegando solo si hace falta).`;
    }
    let all = general ? [GENERAL] : [...chosen, ...auto];
    if (all.length > MAX_FLOWS) all = all.slice(0, MAX_FLOWS);
    all.sort((a, b) => rank(a.cmd) - rank(b.cmd));
    const label = all.length ? all.map((a) => a.label).join(' + ') : undefined;
    const ok = send(composePrompt(all, text), { label, skipEcho: true });
    if (ok && note) log(`{gray-fg}↪ ${esc(note)} Para que vaya literal, empieza con «!».{/}`);
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
    log(`{yellow-fg}Compactando (${reason || 'manual'}) con Haiku, sin herramientas…{/}`);
    const s = await session.compact().catch((e) => { log(`{red-fg}${esc(e.message)}{/}`); return null; });
    if (s) {
      drift.reset();
      log(`{green-fg}✔ Contexto compactado{/} en ${s.length} caracteres. La próxima instrucción arranca limpia con ese resumen y las reglas reforzadas.`);
    }
    refresh();
    focusInput();
  }

  function showLessons() {
    const l = lessonsInfo(cwd);
    if (!l.exists) return log(`{gray-fg}Aún no hay lecciones. Pulsa «Instalar reglas» y Claude irá apuntando en ${esc(LESSONS_REL)} lo que aprenda al arreglar bugs.{/}`);
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
    send(contextPrompt(docs, contextFiles(cwd)), { label: CONTEXT_LABEL, main: 'haiku' });
    focusInput();
  }

  // ---------- Permisos ----------
  function addAllow(arg) {
    const rule = String(arg || '').trim();
    if (!rule) return log('Uso: /permitir Bash(blender:*)   ·   /permitir Bash(npm run dev:*)   ·   /permitidos para ver la lista');
    if (!/^[A-Za-z]+(\(.+\))?$/.test(rule)) return log('{red-fg}Formato: Herramienta o Herramienta(patrón), p. ej. Bash(blender:*){/}');
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
  Subagentes (${Object.keys(session.agents).length}): ${agents}
  ${process.env.ANTHROPIC_API_KEY ? '{yellow-fg}ANTHROPIC_API_KEY definida: puede usarse la API de pago.{/}' : '{gray-fg}Sin ANTHROPIC_API_KEY: se usa tu suscripción.{/}'}`);
  }

  function showStack() {
    const spec = Object.keys(stack.agents);
    log(`\n{bold}Stack{/bold}: ${stack.summary || 'no reconozco nada concreto (genérico)'}\n  Especialistas activados: ${spec.length ? spec.join(', ') : 'ninguno'} {gray-fg}(solo se cargan los que encajan: cada subagente listado cuesta tokens){/}\n  Subagentes base: explorador, limpiador, probador, documentador, investigador, revisor, depurador, verificador, arquitecto\n  Propios: ${Object.keys(custom.agents).join(', ') || '—'} {gray-fg}(.claude-router.json){/}`);
  }

  function help() {
    log(`
{bold}Cómo funciona{/bold}
  Escribes UNA instrucción, o pulsas uno o VARIOS botones (se van sumando en la bandeja) y le añades lo que quieras: al enviar se hace todo junto en una sola instrucción. Si lo escribes con tus palabras («optimiza el código», «créame X y optimízalo») reconozco los flujos que ya existen y los uso (/autoflujos on|off; «!» al principio = literal). Dentro de ella, el modelo principal reparte el trabajo:
    {green-fg}● Haiku{/}   explorar, borrar líneas muertas, tests, docs, buscar en la web
    {cyan-fg}● Sonnet{/}  implementar, coordinar, depurar, revisar y verificar
    {magenta-fg}● Opus{/}    decisiones difíciles (arquitectura, bugs rebeldes)
  Los FLUJOS encadenan agentes (explorar → diseñar → implementar → probar+revisar → verificar), con los pasos independientes en paralelo.

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
  /reglas /recordar /compactar /auto-compactar /continuar /nombre X /presupuesto N|off /autoflujos /actualizar
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
    '/auto-compactar': toggleAutoCompact,
    '/nombre': setName,
    '/presupuesto': setBudget,
    '/permitir': addAllow,
    '/permitidos': showAllow,
    '/push': setPush,
    '/autoflujos': toggleAutoFlows,
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
  const actionItems = (g) => byGroup(g).map((a) => ({ id: a.cmd, label: a.label, desc: a.hint || '', stack: isStackable(a), run: () => toggleTray(a) }));
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
      items: g.items.map((i) => ({ id: i.id, label: i.label, desc: i.desc || '', primary: PRIMARY.has(i.id), stack: !!i.stack, inTray: !!i.stack && tray.includes(i.id) })),
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
      routing: thinking,
      queueLen: queue.items.length,
      tray: trayActions().map((a) => ({ id: a.cmd, label: a.label, needsText: needsText(a) })),
      autoFlows: settings.autoFlows !== false,
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
    if (!b) {
      active = null;
      if (!queueRunning) {
        const q = afterIdle.splice(0);
        setImmediate(() => q.forEach((fn) => fn()));
      }
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
  session.on('tool', ({ tier, agent, name, detail }) => {
    heading(tier, agent);
    log(`  {gray-fg}⚙ ${esc(name)} ${esc(detail)}{/}`);
  });
  session.on('delegate', ({ agentType, description, expectedTier }) => {
    log(`  {${COLOR[expectedTier]}-fg}↳ delegando en {bold}${esc(agentType)}{/bold} (${expectedTier}){/}${description ? ' {gray-fg}' + esc(description) + '{/}' : ''}`);
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
      log(`{green-fg}📄 Contexto ${digestState(cwd, docs).fresh ? 'guardado' : 'revisado'} en ${esc(CONTEXT_REL)}.{/} {gray-fg}Las próximas sesiones lo cargan solas (Instalar reglas añade el import a CLAUDE.md).{/}`);
    }
    if (!r.isError) checkDrift(r.text);
    if (r.bigContext) {
      if (settings.autoCompact) { if (!afterIdle.length) afterIdle.push(() => doCompact(`contexto > ${kfmt(settings.compactAt)}`)); }
      else log('{yellow-fg}El contexto ya es grande: /compactar (o "Nueva sesión") te ahorra tokens.{/}');
    }
    if (repo && run && (run.mainEdits + run.subEdits) > 0) log('{gray-fg}   /cambios para ver qué tocó · /deshacer para volver atrás{/}');
    refresh();
  });
  session.on('cancelled', () => log('{yellow-fg}Tarea cancelada.{/}'));
  session.on('failure', (msg) => {
    log(`{red-fg}${esc(msg)}{/}`);
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
    if (stack.summary) log(`{gray-fg}Stack detectado: ${esc(stack.summary)}${Object.keys(stack.agents).length ? ' → especialistas activados: ' + Object.keys(stack.agents).join(', ') : ''}{/}`);
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
    handle, menu, press, snapshot, boot, cancelPending, setCollapsed, quit, removeFromTray, clearTray,
    cancel: () => SYSTEM['/cancelar'](),
    cwd, session, settings,
    get queueRunning() { return queueRunning; },
    dispose: () => { session.cancel(); queue.stop(); },
  };
}
