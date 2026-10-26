// Hook UserPromptSubmit: lee lo que escribe el usuario, reconoce flujos, especialistas, MCP, skills y agentes que encajan
// y se lo pasa a Claude como contexto. No bloquea ni cambia el mensaje. Preguntas y cambios pequeños: no añade nada.
import fs from 'node:fs';
import { ACTIONS } from './actions.mjs';
import { detectCmds, bodyOf, norm, MAX_FLOWS, GENERAL } from './intent.mjs';
import { specialistsFor, SPEC_KEYS } from './stack.mjs';
import { NAME, loadCatalog, queryStems, queryWords, rankItems, rankMcp } from './lib.mjs';

const emit = (text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));

const SKIP_FLOWS = new Set(['/plugins']); // «el plugin» aquí casi siempre es otra cosa
const EDIT_FLOWS = new Set(['/feature', '/bugprofundo', '/refactor', '/tests', '/optimizar', '/limpiar', '/rendimiento']);
const ACTION_WORD = /\b(cre\w+|haz\w*|hac\w+|arregl\w+|cambi\w+|anad\w+|agreg\w+|modific\w+|elimin\w+|borr\w+|implement\w+|constru\w+|gener\w+|escrib\w+|program\w+|desarroll\w+|model\w+|disen\w+|optimi\w+|mejor\w+|refactor\w+|migr\w+|instal\w+|conect\w+|prepar\w+|mont\w+|analiz\w+|planific\w+|calcul\w+|convert\w+|traduc\w+|redact\w+|document\w+|investig\w+|busc\w+|compar\w+|revis\w+|audit\w+|limpi\w+|pul\w+|prueb\w+|ejecut\w+|lanz\w+|desplieg\w+|build|fix|add|write|make|update|remove|delete|create|generate|design|improve|analy\w+|plan|render\w*|anim\w+)\b/;
const NO_DELEGATE = /\b(sin delegar|no delegues|sin agentes|no uses (agentes|subagentes)|hazlo tu (solo|mismo))\b/;

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function resourceLines(servers, skills, agents) {
  return [
    'Instalado en esta máquina y relacionado con la petición (úsalo si encaja de verdad, si no ignóralo):',
    ...servers.map((m) => `- MCP \`${m.name}\`: sus herramientas son \`${m.prefix}*\`. Úsalas tú directamente (si salen diferidas, cárgalas con ToolSearch).`),
    ...skills.map((s) => `- Skill \`${s.id}\` (herramienta Skill): ${cut(s.d, 100)}`),
    ...agents.map((a) => `- Agente \`${a.id}\` (subagent_type): ${cut(a.d, 100)}`),
  ];
}

function main() {
  if (/^(off|0|false)$/i.test(process.env.CLAUDEOP || '')) return;
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  const prompt = String(input.prompt || '').trim();
  const cwd = input.cwd || process.cwd();
  if (!prompt || prompt.startsWith('/')) return;
  const t = norm(prompt).trim();
  if (NO_DELEGATE.test(t)) return;

  const words = t.split(/\s+/).filter(Boolean).length;
  const question = /\?\s*$/.test(t) || /^[\s¿]*(que|como|por que|donde|cual|cuando|quien|cuanto)\b/.test(t);

  // Flujos: los conocidos por palabras (los demás los reconoce Claude con el catálogo de la sesión, incluso con faltas)
  // (una pregunta tipo «¿cómo se modela un cubo?» no es «construye algo»: sin Feature completa)
  const known = detectCmds(prompt).filter((c) => !SKIP_FLOWS.has(c) && !(question && c === '/feature')).slice(0, Math.min(MAX_FLOWS, 3));
  const flows = known.map((c) => ACTIONS.find((a) => a.cmd === c)).filter(Boolean);

  const cat = loadCatalog(cwd);
  const q = queryStems(prompt);

  // Flujos propios del usuario (~/.claude/flows, .claude/flows)
  const own = cat.flows.filter((f) => f.triggers.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t))
    || f.t.filter((w) => q.includes(w)).length >= 2).slice(0, 2);

  // MCP, skills y agentes instalados que encajan con la petición
  const servers = rankMcp(cat.mcp, q, queryWords(prompt)).slice(0, 2);
  const skills = rankItems(cat.skills, cat.idf, q, { max: 2 });
  const agents = rankItems(cat.agents, cat.idf, q, { max: 2 });
  const resources = servers.length + skills.length + agents.length > 0;

  const isTask = flows.length > 0 || own.length > 0 || (!question && words >= 6 && ACTION_WORD.test(t));
  if (!isTask) {
    // Sin trabajo de código, pero lo instalado encaja («manda un correo», «convierte este pdf»): solo se lo señalamos
    if (resources && !question && words >= 3) emit([`[${NAME} · automático]`, ...resourceLines(servers, skills, agents)].join('\n'));
    return;
  }

  // «hazme X» es el verbo más genérico: si lo único que encaja es Feature completa y hay un recurso instalado que encaja
  // de verdad y ninguna tecnología de programación, probablemente no es trabajo de código (informe, presentación, imagen…).
  const explicitTech = specialistsFor(prompt).length > 0;
  const maybeCode = flows.length === 1 && flows[0].cmd === '/feature' && !own.length && resources && !explicitTech;

  const lines = [`[${NAME} · automático] Esto es una tarea: aplica el método sin que el usuario lo pida y delega según las reglas de la sesión.`];

  if (maybeCode) {
    lines.push('Flujo posible: Feature completa, pero SOLO si la petición implica escribir o cambiar código del proyecto; si no, usa directamente lo instalado que se indica abajo.');
  } else if (flows.length || own.length) {
    const labels = [...flows.map((a) => a.label), ...own.map((f) => f.label)];
    lines.push(`Flujos que encajan: ${labels.join(' + ')}. Síguelos anunciando cada fase en una línea.`);
    if (labels.length > 1) {
      lines.push('Combínalos en UN solo trabajo: un solo explorador para todo, el paralelismo de cada flujo se mantiene, UN verificador al final, y los de solo lectura (revisión/auditoría) van DESPUÉS de implementar.');
    }
    for (const a of flows) {
      const body = bodyOf(a, '');
      lines.push(`### ${a.label}\n${body}`);
    }
    for (const f of own) lines.push(`### ${f.label} (flujo propio)\n${f.body}`);
  } else {
    lines.push(`No encaja un flujo concreto: usa el método general.\n${GENERAL.wrap('(la petición del usuario está arriba)')}`);
  }
  if (!maybeCode) lines.push('Si la petición nombra además otros flujos del catálogo (aunque tenga faltas de ortografía), añádelos.');

  // Especialistas: por lo que escribe; si no dice ninguna tecnología y va a editar, los 2 del proyecto
  let techs = specialistsFor(prompt).filter((k) => SPEC_KEYS.includes(k)).slice(0, 3);
  if (!techs.length && !maybeCode && flows.some((a) => EDIT_FLOWS.has(a.cmd))) techs = (cat.stack.hints || []).slice(0, 2);
  if (techs.length) lines.push(`Especialistas para esta tarea (subagent_type \`${NAME}:<nombre>\`): ${techs.join(', ')}.`);

  if (resources) lines.push(...resourceLines(servers, skills, agents));

  emit(lines.join('\n'));
}

try { main(); } catch { /* un hook nunca debe romper el mensaje del usuario */ }
