// Herramientas que ahorran tokens y que NO son plugins de Claude: rtk (comprime la salida de los comandos) y ccstatusline
// (barra de estado con el contexto en tokens). ccusage no se instala: se ejecuta con npx cuando hace falta.
// Mismas reglas que los plugins recomendados: una vez, en segundo plano, sin tocar lo que ya tienes, 3 intentos con 12 h entre ellos
// y lo que el usuario quite después no se vuelve a poner. Desactivar: CLAUDEOP_NO_TOOLS=1 (o CLAUDEOP_NO_INSTALL=1, CLAUDEOP=off).
//   node tools.mjs              → instala lo que falte      node tools.mjs --dry-run → solo muestra qué haría
//   node tools.mjs --only a,b   → solo esas (lo usa el arranque automático, que ya anotó el intento)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA, off, readJson, writeJson } from './data.mjs';
import { installedIds, isInstalled, installOne } from './requirements.mjs';

export const STATUSLINE = 'npx -y ccstatusline@2.2.32'; // versión fija: no ejecutamos "latest" en cada render
const STAMP = path.join(DATA, 'tools.json');
const HORAS_12 = 12 * 3600 * 1000;
const CFG = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = () => path.join(CFG(), 'settings.json');

export const disabled = () => /^(1|true|on)$/i.test(process.env.CLAUDEOP_NO_TOOLS || '') || /^(1|true|on)$/i.test(process.env.CLAUDEOP_NO_INSTALL || '') || off();

const sh = (cmd, timeout = 180000) => spawnSync(cmd, { shell: true, encoding: 'utf8', timeout });

// winget deja el binario fuera del PATH de esta sesión hasta reiniciar la terminal: se busca también en su carpeta
function rtkPath() {
  if (sh('rtk --version', 20000).status === 0) return 'rtk';
  if (process.platform !== 'win32') return null;
  const pk = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const d of fs.readdirSync(pk)) if (/^rtk-ai\.rtk/i.test(d) && fs.existsSync(path.join(pk, d, 'rtk.exe'))) return `"${path.join(pk, d, 'rtk.exe')}"`;
  } catch { /* sin winget */ }
  return null;
}

const has = (c) => sh(process.platform === 'win32' ? `where ${c}` : `command -v ${c}`, 20000).status === 0;
// En Windows «python» puede ser un atajo de la Microsoft Store que no ejecuta nada: se prueba de verdad
const hasPython = () => sh('python --version', 20000).status === 0 || sh('py -3 --version', 20000).status === 0;

export const hasRtkHook = (s) => /rtk hook/.test(JSON.stringify(s?.hooks || {}));

function installRtk() {
  let bin = rtkPath();
  if (!bin) {
    const cmd = process.platform === 'win32' ? 'winget install rtk-ai.rtk --silent --accept-package-agreements --accept-source-agreements'
      : sh('brew --version', 20000).status === 0 ? 'brew install rtk' : null;
    if (!cmd) return { ok: false, msg: 'sin winget ni brew: instala rtk a mano (https://github.com/rtk-ai/rtk)' };
    const r = sh(cmd);
    bin = rtkPath();
    if (!bin) return { ok: false, msg: (r.stderr || r.stdout || 'no se pudo instalar').trim().split('\n').pop() };
  }
  if (hasRtkHook(readJson(SETTINGS(), {}))) return { ok: true, msg: 'rtk ya tenía su hook' };
  // Solo el hook (sin RTK.md ni nada en CLAUDE.md: no suma contexto); rtk guarda una copia .bak de settings.json
  const r = sh(`${bin} init -g --auto-patch --hook-only`);
  return { ok: r.status === 0 && hasRtkHook(readJson(SETTINGS(), {})), msg: (r.stderr || r.stdout || '').trim().split('\n').pop() };
}

// Servidores de lenguaje: Claude Code puede ir a la definición, ver usos y errores reales del lenguaje en vez de leer archivos enteros.
// El plugin pesa unos KB (sin skills, agentes ni MCP) pero necesita el servidor en el PATH: se instala con npm si falta.
export const LSP = [
  { plugin: 'typescript-lsp', bin: 'typescript-language-server', npm: 'typescript-language-server typescript', python: false },
  { plugin: 'pyright-lsp', bin: 'pyright-langserver', npm: 'pyright', python: true },
];
function installLsp() {
  const ids = installedIds();
  if (!ids) return { ok: false, msg: 'no se pudo consultar «claude plugin list»' };
  const msgs = [];
  let ok = true;
  for (const l of LSP) {
    if (l.python && !hasPython()) { msgs.push(`${l.plugin}: sin Python, se omite`); continue; }
    if (!has(l.bin)) {
      if (!has('npm')) { ok = false; msgs.push(`${l.plugin}: falta npm`); continue; }
      sh(`npm install -g ${l.npm}`, 300000);
      if (!has(l.bin)) { ok = false; msgs.push(`${l.plugin}: no se pudo instalar ${l.bin}`); continue; }
    }
    const r = { repo: 'anthropics/claude-plugins-official', plugin: `${l.plugin}@claude-plugins-official`, name: l.plugin };
    if (isInstalled(ids, r)) { msgs.push(`${l.plugin}: ya estaba`); continue; }
    const res = installOne(r);
    if (!res.ok) ok = false;
    msgs.push(`${l.plugin}: ${res.ok ? 'instalado' : res.msg}`);
  }
  return { ok, msg: msgs.join(' · ') };
}

// Pone una clave en settings.json SOLO si el usuario no la tiene: nunca se pisa lo suyo; copia .claudeop.bak antes de escribir
function setIfAbsent(file, key, value, what) {
  const s = readJson(file, null);
  if (s === null && fs.existsSync(file)) return { ok: false, msg: 'settings.json no se pudo leer: no se toca' };
  const cur = s || {};
  if (cur[key] !== undefined) return { ok: true, msg: `ya tenía ${what}` };
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.claudeop.bak`);
  writeJson(file, { ...cur, [key]: value });
  return { ok: true, msg: `${what} puesto` };
}
export const setStatusLine = (file = SETTINGS()) => setIfAbsent(file, 'statusLine', { type: 'command', command: STATUSLINE, padding: 0 }, 'barra de estado');

// Autocompactado nativo de Claude Code (ajuste `autoCompactWindow`): el umbral es el MENOR entre este valor y la ventana del modelo,
// así que 200k nunca pasa de largo. Una sesión sin tope llegó a 450k tokens POR TURNO. Se cambia luego con /autocompact.
const AUTOCOMPACT = 200000;

// Claude Code solo actualiza solos los marketplaces oficiales; los de terceros necesitan `autoUpdate: true` en settings.json.
// Con esto, al abrir Claude Code se comprueba si hay versión nueva de claudeop y se instala (se aplica al reiniciar).
export function setAutoUpdate(file = SETTINGS()) {
  const s = readJson(file, null);
  if (s === null && fs.existsSync(file)) return { ok: false, msg: 'settings.json no se pudo leer: no se toca' };
  const cur = s || {};
  const all = { ...(cur.extraKnownMarketplaces || {}) };
  const mine = all.claudeop || { source: { source: 'github', repo: 'Ivankirito22/ClaudeOP' } };
  if (mine.autoUpdate !== undefined) return { ok: true, msg: 'ya tenía la actualización automática decidida' };
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.claudeop.bak`);
  writeJson(file, { ...cur, extraKnownMarketplaces: { ...all, claudeop: { ...mine, autoUpdate: true } } });
  return { ok: true, msg: 'actualización automática puesta' };
}
export const setAutoCompact = (file = SETTINGS()) => setIfAbsent(file, 'autoCompactWindow', AUTOCOMPACT, 'autocompactado');

const TOOLS = [
  { key: 'rtk', label: 'rtk (comprime la salida de los comandos)', run: installRtk },
  { key: 'ccstatusline', label: 'barra de estado con el contexto en tokens', run: () => setStatusLine() },
  { key: 'autocompact', label: 'autocompactado a 200k tokens (tope al contexto por turno)', run: () => setAutoCompact() },
  { key: 'autoupdate', label: 'actualización automática de claudeop', run: () => setAutoUpdate() },
  { key: 'lsp', label: 'servidores de lenguaje (TypeScript y Python)', run: installLsp },
];

// Qué herramientas toca instalar ahora (nunca instaladas, o falladas con menos de 3 intentos y más de 12 h)
export function pending(stamp = readJson(STAMP, {})) {
  return TOOLS.filter((t) => { const s = stamp[t.key]; return !s || (!s.ok && s.tries < 3 && Date.now() - s.ts > HORAS_12); });
}
export const markStarted = (list) => {
  const st = readJson(STAMP, {});
  for (const t of list) st[t.key] = { ts: Date.now(), tries: (st[t.key]?.tries || 0) + 1, ok: false };
  writeJson(STAMP, st);
};

function main() {
  const dry = process.argv.includes('--dry-run');
  const oi = process.argv.indexOf('--only');
  const only = oi > 0 ? process.argv[oi + 1].split(',') : null; // lo pasa el arranque, que ya anotó el intento
  const todo = dry ? TOOLS : only ? TOOLS.filter((t) => only.includes(t.key)) : pending();
  let fallos = 0;
  for (const t of todo) {
    if (dry) { console.log(`instalaría    ${t.label}`); continue; }
    let res;
    try { res = t.run(); } catch (e) { res = { ok: false, msg: String(e.message || e) }; }
    const st = readJson(STAMP, {});
    st[t.key] = { ...st[t.key], ts: Date.now(), ok: res.ok };
    writeJson(STAMP, st);
    if (!res.ok) fallos++;
    console.log(`${res.ok ? 'listo        ' : 'FALLÓ        '} ${t.label}: ${res.msg}`);
  }
  if (!dry && todo.length && fallos < todo.length) console.log('\nReinicia la terminal y Claude Code para que carguen.');
  process.exit(fallos ? 1 : 0);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'tools.mjs') main();
