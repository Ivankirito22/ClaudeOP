// Lectura de REQUIREMENTS.md y operaciones con la CLI de Claude Code (`claude plugin ...`), comunes al instalador y al arranque.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FILE = path.join(HERE, '..', 'REQUIREMENTS.md');
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(CFG, 'plugins', 'data', 'claudeop');
export const STAMP = path.join(DATA, 'bootstrap.json');
export const LOG = path.join(DATA, 'bootstrap.log');

export function readRequirements() {
  const block = /```requirements\r?\n([\s\S]*?)```/.exec(fs.readFileSync(FILE, 'utf8'));
  if (!block) throw new Error('REQUIREMENTS.md: falta el bloque ```requirements');
  return block[1].split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [repo, plugin] = l.split(/\s+/); return { repo, plugin, name: plugin.split('@')[0] }; });
}

export const claude = (args) => spawnSync(`claude plugin ${args}`, { shell: true, encoding: 'utf8', timeout: 120000 });

// null = no se pudo consultar (claude no está en el PATH, etc.): en ese caso nadie debe instalar a ciegas
export function installedIds() {
  const r = claude('list --json');
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout || '[]').map((p) => String(p.id || p.name || '')); } catch { return null; }
}
export const isInstalled = (ids, r) => ids.some((id) => id === r.plugin || id.split('@')[0] === r.name);

export function installOne(r) {
  claude(`marketplace add ${r.repo}`); // si ya estaba añadido puede dar error: da igual, lo que cuenta es el install
  const inst = claude(`install ${r.plugin}`);
  return { ok: inst.status === 0, msg: (inst.stderr || inst.stdout || '').trim().split('\n').pop() };
}

export function readStamp() { try { return JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch { return {}; } }
export function writeStamp(s) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STAMP, JSON.stringify(s, null, 2)); }
