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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(REPO, 'plugin');
const SHOW = process.argv.includes('--show');
const REAL = !!process.env.CLAUDEOP_REAL;

assert.equal(fs.readdirSync(path.join(PLUGIN, 'agents')).filter((f) => f.endsWith('.md')).length, 25, 'faltan agentes');
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
assert.ok(/haiku \(barato\): .*explorador/.test(session) && /opus \(caro\): arquitecto/.test(session), 'reparto por modelo');
assert.ok(tok(session) < 2200, `la sesión pesa demasiado (${tok(session)} tokens)`);
if (!REAL) {
  assert.ok(session.includes('mcp__blender__'), 'debe conocer el MCP de Blender del usuario');
  assert.ok(session.includes('Lanzamiento de juego'), 'debe conocer los flujos propios');
  assert.ok(/Stack del proyecto: .*Python/.test(session), 'debe detectar el stack');
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
assert.ok(t.includes('claudeop:<nombre>') && /blender/.test(t), 'especialista blender');
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
assert.ok(t.includes('MÉTODO GENERAL') || t.includes('Flujos que encajan'), 'tarea sin flujo → método general');

// ---- Requisitos: se instalan solos, una vez, y sin tocar tu Claude Code (usa un «claude» falso) ----
const reqs = fs.readFileSync(path.join(PLUGIN, 'REQUIREMENTS.md'), 'utf8').match(/```requirements\r?\n([\s\S]*?)```/)[1].split('\n').filter((l) => l.trim());
assert.equal(reqs.length, 4, 'REQUIREMENTS.md debe listar 4 plugins');

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
assert.ok(t && t.includes('pro-workflow') && t.includes('auto-harness') && t.includes('arscontexta'), 'avisa de lo que instala');
assert.ok(!t.includes('claude-mem'), 'no menciona lo que ya estaba instalado');
await wait(() => log().includes('install arscontexta@agenticnotetaking'));
for (const r of reqs.slice(1)) {
  const [repo, plugin] = r.trim().split(/\s+/);
  assert.ok(log().includes(`plugin marketplace add ${repo}`) && log().includes(`plugin install ${plugin}`), `no instaló ${plugin}`);
}
assert.ok(!log().includes('claude-mem'), 'no debe reinstalar lo que ya está');
await wait(() => Object.values(JSON.parse(fs.readFileSync(path.join(boot.CLAUDE_PLUGIN_DATA, 'bootstrap.json'), 'utf8'))).every((s) => s.ok));
assert.equal(run('bootstrap.mjs', {}, boot), null, 'no vuelve a instalar lo que ya instaló una vez (aunque el usuario lo quite)');
assert.equal(run('bootstrap.mjs', {}, { ...boot, CLAUDE_PLUGIN_DATA: path.join(tmp, 'data-off'), CLAUDEOP_NO_INSTALL: '1' }), null, 'CLAUDEOP_NO_INSTALL=1 lo desactiva');
assert.equal(run('bootstrap.mjs', {}, { CLAUDE_PLUGIN_DATA: path.join(tmp, 'data-noclaude') }), null, 'sin «claude» en el PATH no hace nada');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('plugin: todo OK');
