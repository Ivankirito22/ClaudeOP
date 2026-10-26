// Genera plugin/ a partir de src/: agentes (.md con su modelo) y los módulos que usan los hooks.
// El plugin se instala desde el marketplace como una carpeta suelta, así que no puede importar ../src.
// Uso: node tools/build-plugin.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgents, tierOf, SUBAGENT_STYLE } from '../src/core.mjs';
import { SPECIALISTS } from '../src/stack.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(REPO, 'plugin');
const AGENTS = path.join(PLUGIN, 'agents');
const SCRIPTS = path.join(PLUGIN, 'scripts');

fs.mkdirSync(AGENTS, { recursive: true });
fs.mkdirSync(SCRIPTS, { recursive: true });

// 1) Agentes: un .md por subagente, con `model: haiku|sonnet|opus` (alias, siguen al modelo vigente de cada familia)
for (const f of fs.readdirSync(AGENTS)) if (f.endsWith('.md')) fs.rmSync(path.join(AGENTS, f));

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
// Los especialistas de herramientas (Blender, juegos) heredan TODAS las herramientas para poder usar el MCP si existe
const INHERIT_TOOLS = new Set(['blender', 'juego']);

const defs = buildAgents();
for (const k of Object.keys(SPECIALISTS)) {
  const s = SPECIALISTS[k];
  defs[k] = { description: s.description, prompt: s.prompt, tools: s.tools, model: s.model };
}
for (const [name, def] of Object.entries(defs)) {
  const tools = INHERIT_TOOLS.has(name) ? null : def.tools;
  const md = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(oneLine(def.description))}`,
    `model: ${tierOf(def.model) === 'other' ? 'sonnet' : tierOf(def.model)}`,
    ...(tools ? [`tools: ${tools.join(', ')}`] : []),
    '---',
    '',
    `${def.prompt}`,
    '',
    SUBAGENT_STYLE,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(AGENTS, `${name}.md`), md);
}

// 2) Módulos compartidos, tal cual (flujos, reconocimiento de intención, stack)
for (const f of ['actions.mjs', 'intent.mjs', 'stack.mjs']) {
  fs.copyFileSync(path.join(REPO, 'src', f), path.join(SCRIPTS, f));
}

console.log(`plugin/: ${Object.keys(defs).length} agentes + 3 módulos`);
