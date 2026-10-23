// Versión instalada, aviso de versión nueva en GitHub y actualización con un clic (npm desde el tarball del repo).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const REPO = 'Ivankirito22/ClaudeOP';
export const RAW_PKG = `https://raw.githubusercontent.com/${REPO}/main/package.json`;
export const TARBALL = `https://github.com/${REPO}/tarball/main`;

const stateDir = () => (process.env.CR_STATE_FILE ? path.dirname(process.env.CR_STATE_FILE) : path.join(os.homedir(), '.claude-router'));
const cacheFile = () => path.join(stateDir(), 'update.json');

export function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function isNewer(a, b) { // ¿a > b?
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// Una consulta al día (o siempre con force). Nunca lanza: sin red devuelve null.
export async function checkUpdate({ force = false } = {}) {
  if (process.env.CR_NO_UPDATE_CHECK === '1') return null;
  const cur = currentVersion();
  try {
    if (!force) {
      const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
      if (c.latest && Date.now() - c.ts < 24 * 3600 * 1000) return { latest: c.latest, newer: isNewer(c.latest, cur) };
    }
  } catch { /* sin caché */ }
  try {
    const url = process.env.CR_UPDATE_URL || RAW_PKG;
    const res = await fetch(url, { signal: AbortSignal.timeout(2500), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) return null;
    const latest = JSON.parse(await res.text()).version;
    if (!latest) return null;
    try {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(cacheFile(), JSON.stringify({ latest, ts: Date.now() }));
    } catch { /* no pasa nada */ }
    return { latest, newer: isNewer(latest, cur) };
  } catch {
    return null;
  }
}

// npm i -g <tarball>: no necesita git, solo Node/npm. onLine recibe cada línea de salida.
export function runUpdate(onLine = () => {}) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const custom = process.env.CR_UPDATE_CMD; // para tests
    const cmd = custom || 'npm';
    const args = custom ? [] : ['install', '-g', TARBALL];
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { shell: win || !!custom, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    const feed = (b) => {
      const s = b.toString();
      out += s;
      for (const l of s.split(/\r?\n/)) if (l.trim()) onLine(l.trim());
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `npm terminó con código ${code}${/EACCES|EPERM/.test(out) ? ' (permisos: abre la consola como administrador o configura un prefijo de npm propio)' : ''}` }));
  });
}
