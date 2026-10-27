// Hook SessionStart: al abrir (o reanudar/compactar) la sesión, inventaría lo instalado y le da a Claude las reglas de delegación.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOW_CATALOG } from './flows.mjs';
import { NAME, buildCatalog, frontmatter } from './lib.mjs';
import { readJson, writeJson, sessionFile } from './data.mjs';
import { recall } from './memory.mjs';
import { projectFacts } from './facts.mjs';

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const emit = (text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
const SEMANA = 7 * 24 * 3600 * 1000;

function roster() {
  const tiers = { haiku: [], sonnet: [], opus: [] };
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'agents'))) {
      if (!f.endsWith('.md')) continue;
      const fm = frontmatter(fs.readFileSync(path.join(ROOT, 'agents', f), 'utf8'));
      (tiers[fm.model] || tiers.sonnet).push(fm.name || f.replace(/\.md$/, ''));
    }
  } catch { /* sin agentes: no debería pasar */ }
  return tiers;
}

// Estado de un trabajo largo dejado por una sesión anterior (o antes de un /compact): se retoma sin que el usuario lo explique
function pendingState(cwd) {
  try {
    const f = path.join(cwd, '.claude', 'claudeop', 'estado.md');
    if (Date.now() - fs.statSync(f).mtimeMs > SEMANA) return '';
    return `\nTRABAJO EN CURSO (de .claude/claudeop/estado.md; retómalo si la petición va de lo mismo, y actualízalo):\n${fs.readFileSync(f, 'utf8').trim().slice(0, 1500)}\n`;
  } catch { return ''; }
}

function main() {
  if (/^(off|0|false)$/i.test(process.env.CLAUDEOP || '')) return;
  let cwd = process.cwd();
  let source = 'startup';
  let sid = null;
  try {
    const i = JSON.parse(fs.readFileSync(0, 'utf8'));
    cwd = i.cwd || cwd; source = i.source || source; sid = i.session_id || null;
    if (i.session_id && /compact|clear/.test(source)) { const sf = sessionFile(i.session_id); const st = readJson(sf); if (st?.sent) writeJson(sf, { ...st, sent: [] }); }
  } catch { /* sin stdin */ }

  // Se reutiliza el catálogo si es reciente y la configuración de plugins no ha cambiado (12 h al arrancar, 1 día en /clear, /compact y resume)
  const cat = buildCatalog(cwd, (source === 'startup' ? 12 : 24) * 3600 * 1000);
  const r = roster();
  const customs = cat.flows.map((f) => `- ${f.label}${f.desc ? `: ${f.desc}` : ''} (flujo propio del usuario; síguelo cuando la petición encaje)`);
  // Solo los MCP propios del usuario/proyecto van siempre; los de plugins (cientos) se sugieren cuando encajan con la petición
  const own = cat.mcp.filter((m) => m.src === 'usuario' || m.src === 'proyecto');
  const mcp = own.map((m) => `${m.name} (${m.prefix}*)`);
  const viaPlugins = new Set(cat.mcp.filter((m) => !own.includes(m)).map((m) => m.name)).size;

  const text = `[${NAME}] Orquestación multi-modelo AUTOMÁTICA. El usuario no usa comandos: deduce qué quiere (aunque escriba con faltas o jerga) y delega DENTRO de la misma petición con la herramienta Agent (subagent_type = \`${NAME}:<nombre>\`), siempre en el modelo más barato que lo haga bien: hacerlo tú cuesta dinero al usuario.

Agentes: haiku (barato) ${r.haiku.join(', ')} · sonnet ${r.sonnet.join(', ')} · opus (caro) ${r.opus.join(', ')}.
Reparto: leer/buscar en mucho código → explorador (no leas muchos archivos tú) · cambios mecánicos → limpiador, con rutas exactas · tests/build/lint → probador · documentación → documentador · web → investigador · bug no evidente → depurador (causa raíz ANTES de parchear) · revisar un diff → revisor · decisión difícil o algo que ya falló → arquitecto · más de ~20 líneas en una tecnología → \`especialista\` (blender y juego tienen el suyo; la nota trae su guía de estilo para pegarla en el prompt). Tú haces la implementación normal y la integración final. Agrupa las tareas RELACIONADAS (misma área, tecnología o archivos) en UN solo agente con instrucciones completas: menos arranques (~6k tokens cada uno) y cada agente aprovecha el contexto de lo que toca. Lo independiente va en paralelo en UN solo mensaje (hasta 6 agentes por petición: el hook bloquea el 7.º); nunca en paralelo agentes que editen los mismos archivos. Lo que harías en 1-3 llamadas, hazlo tú. Los subagentes no ven esta conversación: dales instrucciones completas y comprueba lo que devuelven.

${FLOW_CATALOG}
${customs.length ? `Flujos propios del usuario:\n${customs.join('\n')}\n` : ''}Cada petición con trabajo llega con una nota «[${NAME} · automático]» (flujos, especialistas, MCP, skills y agentes que encajan): síguela.
⏱ En CUALQUIER petición con trabajo, di en UNA línea cuánto tardará («⏱ ~X–Y min»): usa la estimación de la nota si viene, y si no, estímala tú.
Calidad: en tareas no triviales, criterio de «hecho» en una línea y compruébalo al final. Preguntas y cambios pequeños, directos y sin flujo. Anuncia cada delegación en una línea.
Seguridad: git push, reset --hard y clean piden confirmación al usuario (hook); no los intentes sin que lo pida.
Tokens: no releas archivos; Grep/Glob antes de Read con offset/limit; no imprimas archivos ni logs enteros; respuestas cortas, resultado primero.
Si preguntan cuánto ahorra o delega: \`node "${ROOT}/scripts/stats.mjs"\`; coste real en tokens y dinero por día: npx -y ccusage@20.0.45 daily. Si algo del plugin no va: \`node "${ROOT}/scripts/doctor.mjs"\` y resume el resultado.${cat.stack.summary ? `\nStack: ${cat.stack.summary}.` : ''}${mcp.length ? `\nMCP del usuario: ${mcp.join(', ')}. Si la tarea es de su herramienta, úsalos en vez de improvisar scripts (si salen diferidos, cárgalos con ToolSearch).` : ''}
También hay ${cat.skills.length} skills/comandos, ${cat.agents.length} agentes y ${viaPlugins} MCP de plugins: cada nota te indica los que encajan.${[projectFacts(cwd), recall(cwd, { current: sid })].filter(Boolean).map((x) => `\n${x}`).join('')}${pendingState(cwd)}`;
  emit(text);
}

try { main(); } catch { /* un hook nunca debe romper la sesión */ }
