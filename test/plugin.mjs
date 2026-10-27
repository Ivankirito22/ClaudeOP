// Prueba los hooks del plugin con un HOME/config falsos (no toca tu Claude Code ni gasta nada).
//   node test/plugin.mjs          → comprueba
//   node test/plugin.mjs --show   → además imprime lo que Claude recibiría para cada frase
//   CLAUDEOP_REAL=1 node test/plugin.mjs --show → usa tu configuración real (tus plugins y MCP)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { riskOf } from '../plugin/scripts/guard.mjs';
import { usageByModel } from '../plugin/scripts/track.mjs';
import { fmt as fmtTime, range as rangeTime } from '../plugin/scripts/eta.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(REPO, 'plugin');
const SHOW = process.argv.includes('--show');
const REAL = !!process.env.CLAUDEOP_REAL;

const agents = fs.readdirSync(path.join(PLUGIN, 'agents')).filter((f) => f.endsWith('.md'));
assert.equal(agents.length, 12, 'deben ser 12 agentes: 9 base + especialista + blender + juego');
const descTokens = agents.reduce((n, f) => n + /^description:.*$/m.exec(fs.readFileSync(path.join(PLUGIN, 'agents', f), 'utf8'))[0].length, 0) / 3.6;
assert.ok(descTokens < 450, `las descripciones de los agentes cuestan ${Math.round(descTokens)} tokens en cada turno`);
// Cada hook apunta a un script que existe
const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
for (const g of Object.values(hooks).flat()) for (const h of g.hooks) {
  const f = /scripts\/([\w.-]+)/.exec(h.command)?.[1];
  assert.ok(f && fs.existsSync(path.join(PLUGIN, 'scripts', f)), `hook sin script: ${h.command}`);
}

// Entorno falso: un plugin con un agente y una skill, un MCP "blender" y un flujo propio
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeop-test-'));
const cfg = path.join(tmp, 'cfg');
const proj = path.join(tmp, 'proyecto');
const w = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
if (!REAL) {
  w(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: { blender: { command: 'uvx', args: ['blender-mcp'] } } }));
  w(path.join(cfg, 'agents', 'cocinero.md'), '---\nname: cocinero\ndescription: Chef agent that writes recipes and meal plans\n---\nCocina.');
  w(path.join(cfg, 'skills', 'informe-ventas', 'SKILL.md'), '---\nname: informe-ventas\ndescription: Builds quarterly sales reports and spreadsheets from revenue data\n---\nInforme.');
  w(path.join(cfg, 'flows', 'lanzamiento.md'), '---\nname: Lanzamiento de juego\ndescription: Prepara el lanzamiento de un juego\ntriggers: lanzar el juego, publicar el juego\n---\n1. Comprueba el build.\n2. Sube a la tienda.');
  w(path.join(proj, 'requirements.txt'), 'fastapi\n');
  w(path.join(proj, 'app.py'), 'print(1)\n');
}
const cwd = REAL ? process.cwd() : proj;
const env = {
  ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN,
  ...(REAL ? {} : { CLAUDE_CONFIG_DIR: cfg, CLAUDE_PLUGIN_DATA: path.join(tmp, 'data'), PATH: path.dirname(process.execPath) }), // sin PATH a «claude» → plan B de escaneo
};
delete env.CLAUDEOP;
env.CLAUDEOP_NO_TOOLS = '1'; // los tests nunca instalan rtk ni tocan la barra de estado real

const run = (script, input, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', script)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...env, ...extraEnv } });
  assert.equal(r.status, 0, `${script} salió con ${r.status}: ${r.stderr}`);
  const out = r.stdout.trim();
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
};
const route = (prompt, extraEnv) => run('route.mjs', { cwd, prompt }, extraEnv);
const tok = (s) => Math.round(s.length / 3.6);
const show = (title, t) => { if (SHOW) console.log(`\n=== ${title}\n${t == null ? '(no añade nada)' : `[${tok(t)} tokens aprox.]\n${t.split('\n').filter((l) => !/^(\d[.)]|- (?!MCP|Skill|Agente)|Termina|Sigue)/.test(l)).join('\n').slice(0, 1600)}`}`); };

// ---- Sesión ----
const session = run('session-start.mjs', { cwd, source: 'startup' });
show('SessionStart', session);
assert.ok(session.includes('claudeop:<nombre>'), 'la sesión debe explicar cómo llamar a los agentes');
assert.ok(/haiku \(barato\) [^·]*explorador/.test(session) && /opus \(caro\) arquitecto/.test(session), 'reparto por modelo');
assert.ok(tok(session) < 2200, `la sesión pesa demasiado (${tok(session)} tokens)`);
if (!REAL) {
  assert.ok(session.includes('mcp__blender__'), 'debe conocer el MCP de Blender del usuario');
  assert.ok(session.includes('Lanzamiento de juego'), 'debe conocer los flujos propios');
  assert.ok(/Stack: .*Python/.test(session), 'debe detectar el stack');
}

// ---- Mensajes que NO deben gastar nada ----
for (const p of ['ok', 'gracias', 'qué hace este proyecto?', '¿cómo funciona el login?', '¿cómo se modela un cubo en blender?', '/help', 'sí, dale', '  ']) {
  const t = route(p);
  show(`«${p}»`, t);
  assert.equal(t, null, `«${p}» no debe inyectar nada`);
}
assert.equal(route('optimiza el proyecto sin delegar'), null, '«sin delegar» desactiva la nota');
assert.equal(route('optimiza el proyecto', { CLAUDEOP: 'off' }), null, 'CLAUDEOP=off desactiva el plugin');

// ---- Tu caso: faltas de ortografía + 3D ----
let t = route('opotiza mi proyecto y modela x cosa en 3d');
show('opotiza mi proyecto y modela x cosa en 3d', t);
assert.ok(t.includes('Feature completa'), '«modela» → Feature completa');
assert.ok(t.includes('claudeop:blender'), 'especialista blender');
assert.ok(/aunque tenga faltas de ortografía/.test(t), 'Claude completa los flujos que la regla no pilla (typo)');
if (!REAL) assert.ok(t.includes('mcp__blender__*'), 'sugiere el MCP de Blender');

// ---- Flujos y recursos ----
t = route('arregla el login que falla en la app');
show('arregla el login que falla en la app', t);
assert.ok(t.includes('Bug a fondo') && t.includes('depurador'), 'bug → Bug a fondo');

t = route('optimiza el rendimiento y limpia el código muerto del proyecto');
show('optimiza el rendimiento…', t);
assert.ok(t.includes('Cazar cuellos de botella') && t.includes('UN solo trabajo'), 'varios flujos se combinan');

t = route('hazme una hoja de calculo con el informe de ventas del trimestre');
show('hoja de cálculo / informe de ventas', t);
if (!REAL) assert.ok(t.includes('informe-ventas'), 'encuentra la skill instalada por contexto');

t = route('quiero lanzar el juego la semana que viene');
show('flujo propio', t);
if (!REAL) assert.ok(t.includes('Lanzamiento de juego (flujo propio)') && t.includes('Sube a la tienda'), 'reconoce el flujo propio');

t = route('necesito algo para mejorar la organización de mi equipo y planificar la semana de trabajo');
show('sin flujo concreto', t);
assert.ok(t.includes('método general') || t.includes('Flujos:'), 'tarea sin flujo → método general');

// ---- Requisitos: se instalan solos, una vez, y sin tocar tu Claude Code (usa un «claude» falso) ----
const block = (kind) => fs.readFileSync(path.join(PLUGIN, 'REQUIREMENTS.md'), 'utf8').match(new RegExp('```' + kind + '\\r?\\n([\\s\\S]*?)```'))[1].split('\n').filter((l) => l.trim());
const reqs = block('requirements');
assert.equal(reqs.length, 2, 'REQUIREMENTS.md: 2 plugins automáticos (memoria y flujo)');
assert.equal(block('optional').length, 6, 'REQUIREMENTS.md: 6 opcionales');

const fake = path.join(tmp, 'fakebin');
const calls = path.join(tmp, 'claude-calls.log');
w(path.join(fake, 'claude.mjs'), `import fs from 'node:fs';
const a = process.argv.slice(2).join(' ');
if (a === 'plugin list --json') process.stdout.write(JSON.stringify([{ id: 'claude-mem@thedotmack' }]));
else fs.appendFileSync(${JSON.stringify(calls)}, a + '\\n');`);
w(path.join(fake, 'claude.cmd'), '@node "%~dp0claude.mjs" %*\r\n');
w(path.join(fake, 'claude'), '#!/bin/sh\nexec node "$(dirname "$0")/claude.mjs" "$@"\n');
try { fs.chmodSync(path.join(fake, 'claude'), 0o755); } catch { /* Windows */ }

const boot = { PATH: `${fake}${path.delimiter}${path.dirname(process.execPath)}`, CLAUDE_PLUGIN_DATA: path.join(tmp, 'data-boot') };
const wait = async (cond) => { for (let i = 0; i < 60 && !cond(); i++) await new Promise((r) => setTimeout(r, 250)); };
const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');

t = run('bootstrap.mjs', {}, boot);
assert.ok(t && t.includes('context7'), 'avisa de lo que instala');
assert.ok(!t.includes('claude-mem'), 'no menciona lo que ya estaba instalado');
assert.ok(!t.includes('auto-harness') && !t.includes('arscontexta'), 'los opcionales no se instalan solos');
await wait(() => log().includes('install context7@claude-plugins-official'));
for (const r of reqs.slice(1)) {
  const [repo, plugin] = r.trim().split(/\s+/);
  assert.ok(log().includes(`plugin marketplace add ${repo}`) && log().includes(`plugin install ${plugin}`), `no instaló ${plugin}`);
}
assert.ok(!log().includes('claude-mem'), 'no debe reinstalar lo que ya está');
await wait(() => Object.values(JSON.parse(fs.readFileSync(path.join(boot.CLAUDE_PLUGIN_DATA, 'bootstrap.json'), 'utf8'))).every((s) => s.ok));
assert.equal(run('bootstrap.mjs', {}, boot), null, 'no vuelve a instalar lo que ya instaló una vez (aunque el usuario lo quite)');
assert.equal(run('bootstrap.mjs', {}, { ...boot, CLAUDE_PLUGIN_DATA: path.join(tmp, 'data-off'), CLAUDEOP_NO_INSTALL: '1' }), null, 'CLAUDEOP_NO_INSTALL=1 lo desactiva');
assert.equal(run('bootstrap.mjs', {}, { CLAUDE_PLUGIN_DATA: path.join(tmp, 'data-noclaude') }), null, 'sin «claude» en el PATH no hace nada');
const dry = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'install-requirements.mjs'), '--dry-run', '--optional'], { encoding: 'utf8', env: { ...env, ...boot } });
assert.equal((dry.stdout.match(/instalaría/g) || []).length, 7, '--optional suma los 6 opcionales a lo que falta (context7 + 6)');

// ---- Protección: confirmación antes de lo que no se deshace ----
for (const c of ['git push', 'git push origin main --force', 'git -C ../otro push', 'git reset --hard HEAD~1', 'git clean -fd', 'git branch -D viejo', 'cd x && git push', 'rm -rf ~', 'rm -rf /', 'rm -rf *']) {
  assert.ok(riskOf(c), `«${c}» debe pedir confirmación`);
}
for (const c of ['git status', 'git commit -m "arregla push de datos"', 'git log --grep push', 'git reset --soft HEAD~1', 'git clean -n', 'git branch -d hecha', 'rm -rf node_modules', 'rm fichero.txt', 'npm run build', 'echo "git push"']) {
  assert.equal(riskOf(c), null, `«${c}» no debe molestar`);
}
const guardHook = (tool, ti, extra = {}, e = {}) => {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'guard.mjs')], { input: JSON.stringify({ session_id: 's1', prompt_id: 'p1', tool_name: tool, tool_input: ti, ...extra }), encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_DATA: path.join(tmp, 'data-guard'), ...e } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
assert.equal(guardHook('Bash', { command: 'git push origin main' }).permissionDecision, 'ask', 'git push pide confirmación');
assert.equal(guardHook('PowerShell', { command: 'git reset --hard' }).permissionDecision, 'ask', 'también en PowerShell');
assert.equal(guardHook('Bash', { command: 'git push' }, {}, { CLAUDEOP_GUARD: 'off' }), null, 'CLAUDEOP_GUARD=off lo desactiva');
assert.equal(guardHook('Bash', { command: 'ls' }), null, 'un comando normal pasa sin decir nada');

// Muchas lecturas seguidas del hilo principal → un único recordatorio de delegar; los subagentes no cuentan
const outs = Array.from({ length: 10 }, () => guardHook('Read', { file_path: 'a.js' }, { prompt_id: 'p2' }));
assert.equal(outs.filter(Boolean).length, 1, 'un solo recordatorio por petición');
assert.ok(outs[7]?.additionalContext.includes('claudeop:explorador'), 'salta a la 8ª lectura');
assert.equal(Array.from({ length: 12 }, () => guardHook('Read', { file_path: 'a.js' }, { prompt_id: 'p3', agent_id: 'sub1' })).filter(Boolean).length, 0, 'las lecturas de un subagente no cuentan');
run('route.mjs', { cwd, prompt: 'optimiza el proyecto sin delegar', prompt_id: 'p4', session_id: 's1' }, { CLAUDE_PLUGIN_DATA: path.join(tmp, 'data-guard') });
assert.equal(Array.from({ length: 12 }, () => guardHook('Read', { file_path: 'a.js' }, { prompt_id: 'p4' })).filter(Boolean).length, 0, '«sin delegar» también silencia el recordatorio');

// Herramientas externas (rtk, barra de estado): reglas de instalación sin ejecutar nada real
const tools = await import('../plugin/scripts/tools.mjs');
const sl = path.join(tmp, 'sl', 'settings.json');
w(sl, JSON.stringify({ model: 'sonnet' }));
assert.equal(tools.setStatusLine(sl).ok, true);
const slJson = JSON.parse(fs.readFileSync(sl, 'utf8'));
assert.equal(slJson.model, 'sonnet', 'conserva el resto de la configuración');
assert.equal(slJson.statusLine.command, tools.STATUSLINE, 'pone la barra de estado');
assert.ok(fs.existsSync(sl + '.claudeop.bak'), 'deja copia de seguridad');
w(sl, JSON.stringify({ statusLine: { type: 'command', command: 'mi-barra' } }));
tools.setStatusLine(sl);
assert.equal(JSON.parse(fs.readFileSync(sl, 'utf8')).statusLine.command, 'mi-barra', 'nunca pisa la barra del usuario');
w(sl, '{roto');
assert.equal(tools.setStatusLine(sl).ok, false, 'un settings.json ilegible no se toca');
assert.equal(fs.readFileSync(sl, 'utf8'), '{roto');
assert.ok(tools.hasRtkHook({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'rtk hook claude' }] }] } }), 'detecta el hook de rtk');
assert.ok(!tools.hasRtkHook({ hooks: { PreToolUse: [{ hooks: [{ command: 'node guard.mjs' }] }] } }), 'sin hook de rtk');
assert.deepEqual(tools.pending({}).map((x) => x.key), ['rtk', 'ccstatusline', 'autocompact', 'autoupdate', 'lsp'], 'al principio toca instalar las 5');
assert.equal(tools.pending({ rtk: { ok: true }, ccstatusline: { ok: true }, autocompact: { ok: true }, autoupdate: { ok: true }, lsp: { ok: true } }).length, 0, 'lo ya hecho no se repite (aunque el usuario lo quite)');
assert.equal(tools.pending({ rtk: { ok: false, tries: 3, ts: 0 }, ccstatusline: { ok: false, tries: 1, ts: Date.now() }, autocompact: { ok: true }, autoupdate: { ok: true }, lsp: { ok: true } }).length, 0, 'máx. 3 intentos y 12 h entre ellos');
assert.equal(tools.pending({ rtk: { ok: false, tries: 1, ts: 0 }, ccstatusline: { ok: true }, autocompact: { ok: true }, autoupdate: { ok: true }, lsp: { ok: true } }).length, 1, 'un fallo se reintenta pasadas 12 h');
const dryTools = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'tools.mjs'), '--dry-run'], { encoding: 'utf8', env });
assert.equal((dryTools.stdout.match(/instalaría/g) || []).length, 5, '--dry-run solo muestra');
assert.equal(tools.disabled(), false);
assert.deepEqual(tools.LSP.map((l) => l.bin), ['typescript-language-server', 'pyright-langserver'], 'los servidores de lenguaje que se instalan');
// Autocompactado: pone el tope solo si no hay uno, y conserva el resto
const ac = path.join(tmp, 'ac', 'settings.json');
w(ac, JSON.stringify({ model: 'sonnet' }));
tools.setAutoCompact(ac);
assert.deepEqual([JSON.parse(fs.readFileSync(ac, 'utf8')).autoCompactWindow, JSON.parse(fs.readFileSync(ac, 'utf8')).model], [200000, 'sonnet'], 'autocompactado a 200k, sin tocar lo demás');
w(ac, JSON.stringify({ autoCompactWindow: 500000 }));
tools.setAutoCompact(ac);
assert.equal(JSON.parse(fs.readFileSync(ac, 'utf8')).autoCompactWindow, 500000, 'nunca pisa el valor del usuario');

// Tope de subagentes por petición: el 7.º se bloquea; en otra petición vuelve a empezar; los subagentes no cuentan; CLAUDEOP_MAX_AGENTS lo cambia
const spawns = Array.from({ length: 8 }, () => guardHook('Agent', { subagent_type: 'claudeop:explorador' }, { prompt_id: 'pa1', session_id: 'sa' }));
assert.equal(spawns.filter((o) => o?.permissionDecision === 'deny').length, 2, 'bloquea del 7.º en adelante');
assert.equal(spawns[5], null, 'el 6.º pasa');
assert.equal(guardHook('Agent', {}, { prompt_id: 'pa2', session_id: 'sa' }), null, 'petición nueva: contador a cero');
assert.equal(guardHook('Agent', {}, { prompt_id: 'pa3', session_id: 'sa', agent_id: 'sub1' }), null, 'un subagente no cuenta');
assert.equal(Array.from({ length: 3 }, () => guardHook('Agent', {}, { prompt_id: 'pa4', session_id: 'sa' }, { CLAUDEOP_MAX_AGENTS: '2' })).filter((o) => o?.permissionDecision === 'deny').length, 1, 'el tope se puede cambiar');
assert.match(hooks.PreToolUse[0].matcher, /Agent/, 'el guard está registrado para Agent');

// Actualización automática: marketplace de claudeop con autoUpdate, sin pisar lo que el usuario ya decidió
const au = path.join(tmp, 'au', 'settings.json');
w(au, JSON.stringify({ extraKnownMarketplaces: { otro: { source: { source: 'github', repo: 'a/b' } }, claudeop: { source: { source: 'github', repo: 'Ivankirito22/ClaudeOP' } } } }));
tools.setAutoUpdate(au);
const auJson = JSON.parse(fs.readFileSync(au, 'utf8')).extraKnownMarketplaces;
assert.deepEqual([auJson.claudeop.autoUpdate, auJson.claudeop.source.repo, Object.keys(auJson).length], [true, 'Ivankirito22/ClaudeOP', 2], 'activa autoUpdate sin tocar el resto');
w(au, JSON.stringify({ extraKnownMarketplaces: { claudeop: { source: { source: 'github', repo: 'x/y' }, autoUpdate: false } } }));
tools.setAutoUpdate(au);
assert.equal(JSON.parse(fs.readFileSync(au, 'utf8')).extraKnownMarketplaces.claudeop.autoUpdate, false, 'respeta que el usuario lo desactive');
w(au, '{}');
tools.setAutoUpdate(au);
assert.equal(JSON.parse(fs.readFileSync(au, 'utf8')).extraKnownMarketplaces.claudeop.source.repo, 'Ivankirito22/ClaudeOP', 'si no estaba el marketplace, lo declara');

// Lectura entera de un archivo grande: se frena UNA vez por archivo; con offset/limit, archivos pequeños y binarios pasa
const bigf = path.join(tmp, 'grande.txt');
fs.writeFileSync(bigf, 'x'.repeat(60 * 1024));
const smallf = path.join(tmp, 'pequeno.txt');
fs.writeFileSync(smallf, 'hola');
const rd = (p, extra = {}, ti = {}) => guardHook('Read', { file_path: p, ...ti }, { prompt_id: 'pb1', session_id: 'sb', ...extra });
assert.equal(rd(bigf)?.permissionDecision, 'deny', 'frena la lectura entera de un archivo grande');
assert.equal(rd(bigf), null, 'la segunda petición del mismo archivo pasa');
assert.equal(rd(bigf, { prompt_id: 'pb2' }, { limit: 50 }), null, 'con limit pasa');
assert.equal(rd(smallf, { prompt_id: 'pb3' }), null, 'un archivo pequeño pasa');
assert.equal(rd(path.join(tmp, 'foto.png'), { prompt_id: 'pb4' }), null, 'un binario no se frena');
assert.equal(rd(bigf, { prompt_id: 'pb5', agent_id: 'sub1' }), null, 'los subagentes leen lo que necesiten');
assert.equal(rd(bigf, { prompt_id: 'pb6', session_id: 'sb2' }, {})?.permissionDecision, 'deny', 'otra petición vuelve a frenar');
assert.equal(guardHook('Read', { file_path: bigf }, { prompt_id: 'pb7', session_id: 'sb3' }, { CLAUDEOP_BIG_READ_KB: '0' }), null, 'CLAUDEOP_BIG_READ_KB=0 lo desactiva');

// La receta de un flujo se da una vez por sesión; tras compactar se vuelve a dar
const recData = path.join(tmp, 'data-recipe');
const recipe = (pid) => run('route.mjs', { cwd, prompt: 'optimiza el proyecto', prompt_id: pid, session_id: 'sr' }, { CLAUDE_PLUGIN_DATA: recData });
const first = recipe('r1');
const second = recipe('r2');
assert.ok(first.includes('Optimizar') && second.includes('receta ya dada'), 'la 2.ª vez solo el nombre del flujo');
assert.ok(second.length < first.length - 200, 'y la nota es bastante más corta');
run('session-start.mjs', { cwd, source: 'compact', session_id: 'sr' }, { CLAUDE_PLUGIN_DATA: recData });
assert.ok(!recipe('r3').includes('receta ya dada'), 'tras compactar se vuelve a dar la receta');

// Aviso de contexto grande: lee solo el final del transcript, avisa una vez por tramo y sale aunque la petición no tenga trabajo
const um = (id, r) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: r, cache_creation_input_tokens: 5000 } } });
const big = path.join(tmp, 'big.jsonl');
fs.writeFileSync(big, ['{"type":"user"}', um('b1', 150000)].join('\n'));
const ctxData = path.join(tmp, 'data-ctx');
const warnOf = (pid, tp) => { const o = run('route.mjs', { cwd, prompt: 'gracias', prompt_id: pid, session_id: 'sc', transcript_path: tp }, { CLAUDE_PLUGIN_DATA: ctxData }); return o || ''; };
assert.match(warnOf('c1', big), /155k tokens/, 'avisa con el tamaño del contexto');
assert.equal(warnOf('c2', big), '', 'no repite el aviso en el mismo tramo');
fs.appendFileSync(big, '\n' + um('b2', 230000));
assert.match(warnOf('c3', big), /235k tokens/, 'avisa otra vez al subir de tramo');
// Al terminar cada respuesta se anota el tamaño del contexto; stats saca mediana y máximo
const ctxRun = path.join(tmp, 'data-ctxrec');
const trkMain = (tp) => spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'track.mjs'), 'main'], { input: JSON.stringify({ session_id: 'st', transcript_path: tp }), encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_DATA: ctxRun } });
trkMain(big);
const st1 = JSON.parse(spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'stats.mjs'), '--json'], { encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_DATA: ctxRun } }).stdout);
assert.deepEqual([st1.contexto.turnos, st1.contexto.maximo], [1, 235010], 'stats muestra el contexto por turno');
const small = path.join(tmp, 'small.jsonl');
fs.writeFileSync(small, um('s1', 20000));
assert.equal(warnOf('c4', small), '', 'contexto pequeño: sin aviso');

// ---- Medición: lee el transcript (con mensajes repetidos) y anota por modelo; stats lo resume ----
const msg = (id, model, i, o, r, c) => JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: c } } });
const tr = path.join(tmp, 'sub.jsonl');
fs.writeFileSync(tr, [msg('m1', 'claude-haiku-5-5', 10, 200, 1000, 500), msg('m1', 'claude-haiku-5-5', 10, 200, 1000, 500), msg('m2', 'claude-haiku-5-5', 5, 100, 2000, 0), '{roto', JSON.stringify({ type: 'user' })].join('\n'));
assert.deepEqual(usageByModel(tr), { 'claude-haiku-5-5': { i: 15, o: 300, r: 3000, c: 500 } }, 'cuenta cada mensaje una vez');

const dataT = path.join(tmp, 'data-track');
const trk = (kind, input) => assert.equal(spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'track.mjs'), kind], { input: JSON.stringify(input), encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_DATA: dataT } }).status, 0);
const mainTr = path.join(tmp, 'main.jsonl');
fs.writeFileSync(mainTr, msg('a1', 'claude-sonnet-5-5', 100, 400, 5000, 1000));
trk('sub', { session_id: 's9', agent_type: 'claudeop:explorador', agent_transcript_path: tr });
trk('main', { session_id: 's9', transcript_path: mainTr });
fs.appendFileSync(mainTr, '\n' + msg('a2', 'claude-sonnet-5-5', 50, 100, 6000, 0));
trk('main', { session_id: 's9', transcript_path: mainTr });
trk('main', { session_id: 's9', transcript_path: mainTr }); // sin novedades: no duplica
const usage = fs.readFileSync(path.join(dataT, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.equal(usage.length, 3, 'una fila del subagente y dos del hilo principal (la tercera llamada no añade)');
assert.equal(usage.filter((u) => u.k === 'main').reduce((n, u) => n + u.o, 0), 500, 'el hilo principal suma el delta, no el acumulado');
assert.equal(usage.find((u) => u.k === 'sub').a, 'explorador', 'quita el prefijo claudeop:');
const stats = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'stats.mjs'), '--precios', 'haiku=1,sonnet=3'], { encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_DATA: dataT } }).stdout;
assert.ok(/haiku\s+.*\d+%/.test(stats) && /sonnet\s+.*\d+%/.test(stats) && stats.includes('explorador') && /Coste relativo/.test(stats), `stats incompleto:\n${stats}`);
assert.ok(spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'stats.mjs')], { encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_DATA: path.join(tmp, 'vacio') } }).stdout.includes('sin datos todavía'), 'sin registro lo dice claro');

// ---- Tiempo estimado: «⏱ ~X–Y min» en cada tarea, calculado con lo que tardó de verdad ----
assert.deepEqual([30, 300, 3900, 7200].map(fmtTime), ['30 s', '5 min', '1 h 5 min', '2 h']);
assert.equal(rangeTime({ lo: 540, hi: 1665 }), '~9–28 min');
assert.equal(rangeTime({ lo: 300, hi: 300 }), '~5 min');
assert.ok(/⏱ Estimado ~\d+(–\d+)? min \(estimación inicial/.test(route('arregla el login que falla en la app')), 'sin historial: estimación inicial');
assert.ok(/⏱ Estimado ~\d+–\d+ min/.test(route('refactoriza el módulo de pagos y añade tests')), 'varios flujos también');

const dataE = path.join(tmp, 'data-eta');
w(path.join(dataE, 'durations.jsonl'), [600, 700, 800, 900, 1000].map((sec) => JSON.stringify({ t: Date.now(), k: '/feature', sec })).join('\n') + '\n');
t = run('route.mjs', { cwd, prompt: 'añade un endpoint nuevo en python con fastapi y pytest', prompt_id: 'e1', session_id: 'se' }, { CLAUDE_PLUGIN_DATA: dataE });
assert.ok(t.includes('~12–15 min (con 5 tareas parecidas tuyas)'), `debe usar el historial (p25–p75):\n${t.split('\n').find((l) => l.includes('⏱'))}`);

// Al terminar (Stop) se anota cuánto tardó: simulamos que la petición empezó hace 2 minutos
const stFile = fs.readdirSync(dataE).find((f) => f.startsWith('sess-se'));
const st = JSON.parse(fs.readFileSync(path.join(dataE, stFile), 'utf8'));
assert.equal(st.kind, '/feature', 'la petición queda anotada con su tipo');
fs.writeFileSync(path.join(dataE, stFile), JSON.stringify({ ...st, t0: Date.now() - 120000 }));
const stopMain = path.join(tmp, 'stop.jsonl');
fs.writeFileSync(stopMain, msg('z1', 'claude-sonnet-5-5', 1, 1, 1, 1));
const stop = () => spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'track.mjs'), 'main'], { input: JSON.stringify({ session_id: 'se', prompt_id: 'e1', transcript_path: stopMain }), encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_DATA: dataE } });
stop(); stop(); // un segundo Stop de la misma petición no duplica
const durs = fs.readFileSync(path.join(dataE, 'durations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.equal(durs.length, 6, 'una duración nueva (y solo una)');
assert.ok(durs[5].k === '/feature' && durs[5].sec >= 119 && durs[5].sec <= 125, 'duración ≈ 2 min');
const st2 = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'stats.mjs')], { encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_DATA: dataE } }).stdout;
assert.ok(/Feature completa\s+6×/.test(st2) && st2.includes('Tiempo real por tipo de tarea'), `stats debe mostrar los tiempos:\n${st2}`);
assert.ok(run('session-start.mjs', { cwd, source: 'startup' }).includes('⏱ ~X–Y min'), 'la regla del tiempo está en la sesión');

// Subagente en segundo plano: su aviso de vuelta no es una petición nueva, y el tiempo cuenta hasta que termina todo
const dataF = path.join(tmp, 'data-bg');
const envF = { CLAUDE_PLUGIN_DATA: dataF };
assert.ok(run('route.mjs', { cwd, prompt: 'limpia el código muerto de este proyecto', prompt_id: 'f1', session_id: 'sf' }, envF), 'la petición real sí lleva nota');
const fFile = path.join(dataF, fs.readdirSync(dataF).find((f) => f.startsWith('sess-sf')));
fs.writeFileSync(fFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(fFile, 'utf8')), t0: Date.now() - 90000 }));
const handback = 'Another Claude session sent a message: <agent-message from="a1"> [Subagent hand-back] El bug del error está en el login </agent-message>';
assert.equal(run('route.mjs', { cwd, prompt: handback, prompt_id: 'f2', session_id: 'sf' }, envF), null, 'el aviso de un subagente no recibe nota ni estimación');
assert.equal(JSON.parse(fs.readFileSync(fFile, 'utf8')).kind, '/limpiar', 'ni reinicia el cronómetro de la petición real');
const stopBg = (extra) => spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'track.mjs'), 'main'], { input: JSON.stringify({ session_id: 'sf', transcript_path: stopMain, ...extra }), encoding: 'utf8', env: { ...env, ...envF } });
stopBg({ prompt_id: 'f1', background_tasks: [{ id: 'a1' }] });
assert.ok(!fs.existsSync(path.join(dataF, 'durations.jsonl')), 'con un subagente aún en marcha no se cierra la medición');
guardHook('Read', { file_path: 'x' }, { session_id: 'sf', prompt_id: 'f2' }, { CLAUDE_PLUGIN_DATA: dataF }); // la continuación no borra el cronómetro
stopBg({ prompt_id: 'f2', background_tasks: [] });
const bg = fs.readFileSync(path.join(dataF, 'durations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.ok(bg.length === 1 && bg[0].k === '/limpiar' && bg[0].sec >= 89, 'una sola medición, con el tiempo total desde que el usuario pidió');

// ---- Estado de un trabajo largo: se retoma al abrir la sesión ----
w(path.join(proj, '.claude', 'claudeop', 'estado.md'), 'Hecho: modelo de usuarios\nPendiente: endpoint /login');
assert.ok(run('session-start.mjs', { cwd, source: 'resume' }).includes('Pendiente: endpoint /login'), 'retoma el estado guardado');

// ---- Especialistas: solo la guía de las tecnologías que tocan ----
t = route('añade un endpoint nuevo en python con fastapi y pytest');
assert.ok(t.includes('claudeop:especialista') && /Python:/.test(t) && !/Go:|Rust:/.test(t), 'guía de Python en la nota, sin cargar las demás');
assert.ok(t.includes('estado.md') || !/Feature completa/.test(t), 'trabajo largo → archivo de estado');

// ---- Diagnóstico: un entorno sano sale en verde ----
const doc = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'doctor.mjs')], { encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_DATA: path.join(tmp, 'data-doctor') } });
assert.equal(doc.status, 0, `doctor debe salir en verde:\n${doc.stdout}`);
assert.ok(doc.stdout.includes('12 agentes') && doc.stdout.includes('9 hooks en 7 eventos') && doc.stdout.includes('Todo correcto'), 'doctor resume el plugin');

// ---- Flujos: todo lo que detecta la intención tiene su receta, y cada receta es corta ----
const { FLOWS } = await import('../plugin/scripts/flows.mjs');
const { detectCmds } = await import('../plugin/scripts/intent.mjs');
for (const p of ['optimiza el proyecto', 'arregla el login', 'refactoriza esto', 'revisa la seguridad', 'prepara la release', 'audita todo', 'documenta el código', 'investiga qué framework usar', 'cuellos de botella', 'limpia el código muerto', 'genera tests', 'explícame el proyecto', 'pule lo último']) {
  for (const c of detectCmds(p)) assert.ok(FLOWS.some((f) => f.cmd === c), `«${p}» detecta ${c}, que no tiene receta`);
}
assert.ok(FLOWS.every((f) => f.body.length < 900), 'las recetas deben ser cortas: se pagan en tokens cada vez que se usan');

// ---- Avisos del sistema: solo cuando Claude te necesita o termina algo largo (el log sustituye al toast real) ----
const nlog = path.join(tmp, 'notify.log');
const dataN = path.join(tmp, 'data-notify');
const notify = (kind, input, e = {}) => {
  fs.rmSync(nlog, { force: true });
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'notify.mjs'), kind], { input: JSON.stringify({ session_id: 'sn', cwd: 'C:\\trabajo\\mi-app', ...input }), encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_DATA: dataN, CLAUDEOP_NOTIFY_LOG: nlog, ...e } });
  assert.equal(r.status, 0, r.stderr);
  return fs.existsSync(nlog) ? fs.readFileSync(nlog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const setT0 = (secAgo) => w(path.join(dataN, 'sess-sn.json'), JSON.stringify({ prompt: 'n1', t0: Date.now() - secAgo * 1000 }));

let n = notify('notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
assert.ok(n.length === 1 && n[0].title.includes('permiso') && n[0].body.includes('mi-app') && n[0].body.includes('quiere usar Bash'), 'permiso: dice qué herramienta y de qué proyecto');
n = notify('notification', { notification_type: 'elicitation_dialog', message: 'Elige una opción' });
assert.ok(n.length === 1 && n[0].title.includes('respuesta'), 'una pregunta de un servidor MCP también avisa');
for (const type of ['auth_success', 'elicitation_complete']) assert.equal(notify('notification', { notification_type: type }).length, 0, `${type} no avisa`);

setT0(5);
assert.equal(notify('stop', {}).length, 0, 'una respuesta corta no avisa (estás mirando la terminal)');
setT0(125);
n = notify('stop', {});
assert.ok(n.length === 1 && n[0].title.includes('terminado') && /mi-app · 2 min/.test(n[0].body), `una petición larga avisa con proyecto y duración: ${JSON.stringify(n)}`);
assert.equal(notify('stop', { background_tasks: [{ id: 'a' }] }).length, 0, 'con subagentes aún trabajando no avisa de que terminó');
assert.equal(notify('notification', { notification_type: 'idle_prompt' }).length, 0, 'ya avisó de que terminó: no repite 1 min después');
fs.rmSync(path.join(dataN, 'notify-sn.json'), { force: true });
assert.ok(notify('notification', { notification_type: 'idle_prompt' })[0].title.includes('esperando'), 'si no avisó antes, el «te espero» sí sale');
assert.equal(notify('stop', {}, { CLAUDEOP_NOTIFY: 'off' }).length, 0, 'CLAUDEOP_NOTIFY=off lo desactiva');
setT0(40);
assert.equal(notify('stop', {}, { CLAUDEOP_NOTIFY_MIN_SEC: '60' }).length, 0, 'el umbral se puede cambiar');
assert.ok(notify('error', {})[0].title.includes('error'), 'un error también avisa');
assert.ok(JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks.Notification, 'el hook Notification está registrado');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('plugin: todo OK');
