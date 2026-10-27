// Hook SessionStart (startup): instala en segundo plano los plugins de REQUIREMENTS.md que falten.
// Reglas para no ser pesado: un plugin que ya se instaló una vez y luego falta (lo quitó el usuario) no se reinstala;
// uno que falló se reintenta como mucho 3 veces, con 12 h entre intentos. Desactivar: CLAUDEOP=off o CLAUDEOP_NO_INSTALL=1.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { disabled as toolsOff, pending as pendingTools, markStarted as markTools } from './tools.mjs';
import { readRequirements, installedIds, isInstalled, readStamp, writeStamp, DATA, LOG } from './requirements.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const emit = (text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
const HORAS_12 = 12 * 3600 * 1000;

// Herramientas externas (rtk, barra de estado): se lanzan aparte, también en segundo plano. Devuelve cuáles empezaron.
function startTools() {
  if (toolsOff()) return [];
  const todo = pendingTools();
  if (!todo.length) return [];
  markTools(todo);
  fs.mkdirSync(DATA, { recursive: true });
  const log = fs.openSync(LOG, 'a');
  spawn(process.execPath, [path.join(HERE, 'tools.mjs'), '--only', todo.map((t) => t.key).join(',')], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  return todo.map((t) => t.label);
}

// Plugins recomendados que faltan: los instala en segundo plano. Devuelve sus nombres.
function startPlugins() {
  if (/^(off|0|false)$/i.test(process.env.CLAUDEOP || '') || /^(1|true|on)$/i.test(process.env.CLAUDEOP_NO_INSTALL || '')) return [];
  const stamp = readStamp();
  const reqs = readRequirements();
  // Caso normal (todo resuelto en una sesión anterior): ni siquiera se consulta la CLI de Claude (~1 s)
  if (reqs.every((r) => stamp[r.plugin]?.ok)) return [];
  const ids = installedIds();
  if (!ids) return [];
  const todo = reqs.filter((r) => {
    if (isInstalled(ids, r)) { stamp[r.plugin] = { ...stamp[r.plugin], ts: Date.now(), ok: true }; return false; } // ya lo tenía: no se tocará nunca
    const s = stamp[r.plugin];
    return !s || (!s.ok && s.tries < 3 && Date.now() - s.ts > HORAS_12);
  });
  writeStamp(stamp);
  if (!todo.length) return [];

  for (const r of todo) stamp[r.plugin] = { ts: Date.now(), tries: (stamp[r.plugin]?.tries || 0) + 1, ok: false };
  writeStamp(stamp);

  fs.mkdirSync(DATA, { recursive: true });
  const log = fs.openSync(LOG, 'a');
  spawn(process.execPath, [path.join(HERE, 'install-requirements.mjs'), '--only', todo.map((r) => r.plugin).join(',')], {
    detached: true, stdio: ['ignore', log, log], windowsHide: true,
  }).unref();

  return todo.map((r) => r.name);
}

function main() {
  const tools = startTools();
  const plugins = startPlugins();
  if (!tools.length && !plugins.length) return;
  const what = [...plugins, ...tools].join(', ');
  emit(`[claudeop] Se están instalando en segundo plano los recomendados que faltaban: ${what}. Dile al usuario en UNA línea que, cuando termine, reinicie la terminal y Claude Code para que carguen. Si algo falla, el motivo queda en ${LOG}.`);
}

try { main(); } catch { /* un hook nunca debe romper la sesión */ }
