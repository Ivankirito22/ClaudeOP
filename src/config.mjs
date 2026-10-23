// Ajustes guardados (~/.claude-router/state.json) y personalización (acciones y subagentes propios).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.claude-router');
const FILE = process.env.CR_STATE_FILE || path.join(DIR, 'state.json');

export const DEFAULTS = {
  userName: 'Frivan',
  profile: 'balanced',
  permission: 'acceptEdits',
  autoCompact: true, // compacta solo cuando el contexto es grande o Claude "se va"
  compactAt: 150000, // tokens de contexto a partir de los cuales compactar
  autoRecover: true, // refuerza las reglas en la siguiente instrucción si detecta deriva
  maxBudget: null, // USD máximos por instrucción (null = sin límite)
  remindEvery: 5, // cada cuántas instrucciones se antepone solo un recordatorio de reglas (0 = nunca)
  verify: 'auto', // verificación final: auto | siempre | nunca
  lessons: true, // Claude apunta lecciones en .claude/lecciones.md
  autoFlows: true, // reconoce en lo que escribes los flujos que ya existen y los aplica solo
  contextDocs: true, // lee/indexa los MDs del proyecto para entrar en contexto
  checkpoints: true, // foto de la carpeta antes de cada instrucción (necesita git)
  blockPush: true, // bloquea git push / reset --hard / clean dentro de Claude
  allow: [], // permisos extra globales, p. ej. "Bash(blender:*)"
  collapsed: ['MODELO A MANO', 'COLA', 'INFORMES'], // grupos plegados en la barra lateral
};

function readState() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { settings: {}, projects: {} }; }
}
function writeState(st) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(st, null, 2));
  } catch { /* si no se puede guardar, seguimos */ }
}

export function loadSettings() {
  return { ...DEFAULTS, ...(readState().settings || {}) };
}
export function saveSettings(settings) {
  const st = readState();
  st.settings = settings;
  writeState(st);
}
export function getProject(cwd) {
  return (readState().projects || {})[cwd] || {};
}
export function setProject(cwd, data) {
  const st = readState();
  st.projects = st.projects || {};
  st.projects[cwd] = { ...(st.projects[cwd] || {}), ...data };
  writeState(st);
}

// Personalización: ~/.claude-router/config.json, ~/.claude-router/actions.json y ./.claude-router.json
// Formato: { "actions": [...], "agents": { "nombre": { "description", "prompt", "tools", "model": "haiku|sonnet|opus" } }, "allow": ["Bash(blender:*)"] }
export function loadCustom(cwd) {
  const files = [path.join(DIR, 'config.json'), path.join(DIR, 'actions.json'), path.join(cwd, '.claude-router.json')];
  const actions = [];
  const agents = {};
  const allow = [];
  for (const f of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const list = Array.isArray(data) ? data : data.actions;
    for (const a of list || []) {
      if (!a || !a.label || !(a.prompt || a.prefill)) continue;
      const slug = '/' + String(a.cmd || a.label).toLowerCase().replace(/^\//, '').replace(/[^a-z0-9áéíóúñ]+/g, '-').replace(/^-|-$/g, '');
      actions.push({ cmd: slug, label: a.label, prompt: a.prompt, input: !a.prompt, prefill: a.prefill, main: a.main, custom: true });
    }
    if (!Array.isArray(data) && data.agents && typeof data.agents === 'object') Object.assign(agents, data.agents);
    if (!Array.isArray(data) && Array.isArray(data.allow)) allow.push(...data.allow.filter((x) => typeof x === 'string'));
  }
  return { actions, agents, allow };
}
