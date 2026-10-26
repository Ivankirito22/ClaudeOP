// Carpeta de datos del plugin (registro de uso, estado de arranque, contadores por sesión) y lectura/escritura segura de JSON.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(CFG, 'plugins', 'data', 'claudeop');
export const USAGE = path.join(DATA, 'usage.jsonl');

export const off = () => /^(off|0|false)$/i.test(process.env.CLAUDEOP || '');
export const tierOf = (model) => (/haiku/i.test(model) ? 'haiku' : /sonnet/i.test(model) ? 'sonnet' : /opus/i.test(model) ? 'opus' : 'otro');

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

// Estado pequeño por sesión (se limpia solo: ver track.mjs)
export const sessionFile = (id) => path.join(DATA, `sess-${String(id || 'x').replace(/[^\w-]/g, '')}.json`);
