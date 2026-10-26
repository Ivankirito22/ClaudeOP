// Hook SessionStart: al abrir (o reanudar/compactar) la sesión, inventaría lo instalado y le da a Claude las reglas de delegación.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOW_CATALOG } from './intent.mjs';
import { NAME, buildCatalog, frontmatter } from './lib.mjs';

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
  try { const i = JSON.parse(fs.readFileSync(0, 'utf8')); cwd = i.cwd || cwd; source = i.source || source; } catch { /* sin stdin */ }

  // Se reutiliza el catálogo si es reciente y la configuración de plugins no ha cambiado (12 h al arrancar, 1 día en /clear, /compact y resume)
  const cat = buildCatalog(cwd, (source === 'startup' ? 12 : 24) * 3600 * 1000);
  const r = roster();
  const base = ['revisor', 'depurador', 'verificador'];
  const customs = cat.flows.map((f) => `- ${f.label}${f.desc ? `: ${f.desc}` : ''} (flujo propio del usuario; síguelo cuando la petición encaje)`);
  // Solo los MCP propios del usuario/proyecto van siempre; los de plugins (cientos) se sugieren cuando encajan con la petición
  const own = cat.mcp.filter((m) => m.src === 'usuario' || m.src === 'proyecto');
  const mcp = own.map((m) => `${m.name} (${m.prefix}*)`);
  const viaPlugins = new Set(cat.mcp.filter((m) => !own.includes(m)).map((m) => m.name)).size;

  const text = `[${NAME}] Orquestación multi-modelo AUTOMÁTICA. El usuario no usa comandos: tú reconoces qué quiere (aunque escriba con faltas o jerga), eliges los flujos y agentes que encajan y delegas DENTRO de la misma petición con la herramienta Agent (subagent_type = \`${NAME}:<nombre>\`). Usa siempre el modelo más barato que haga bien cada paso.

Subagentes por modelo:
- haiku (barato): ${r.haiku.join(', ')}
- sonnet: ${r.sonnet.filter((n) => base.includes(n)).join(', ')}, y para implementar: ${r.sonnet.filter((n) => !base.includes(n)).join(', ')}
- opus (caro): ${r.opus.join(', ')}

Reparto (obligatorio; hacerlo tú gasta dinero del usuario):
- Leer/buscar/resumir mucho código → explorador (no leas muchos archivos tú). Cambios mecánicos (código muerto, imports, renombres) → limpiador, con rutas exactas.
- Tests/build/lint → probador (solo informa de fallos). Documentación → documentador. Buscar en la web → investigador.
- Bug no evidente → depurador halla la causa raíz ANTES de parchear. Revisar un diff o un cambio arriesgado → revisor.
- Decisiones difíciles (arquitectura, bugs rebeldes, rendimiento complejo, refactors arriesgados) → arquitecto; si algo ya falló, consúltalo antes de reintentar.
- Más de ~20 líneas en una tecnología concreta → \`especialista\` (blender y juego tienen el suyo): la nota te da su guía de estilo para pegársela en el prompt. Tú haces la implementación normal y la integración final.
Paralelo: sub-pasos independientes van en UN solo mensaje con todas las llamadas Agent; nunca en paralelo agentes que editen los mismos archivos.

${FLOW_CATALOG}
${customs.length ? `Flujos propios del usuario:\n${customs.join('\n')}\n` : ''}
Cada petición con trabajo de verdad llega con una nota «[${NAME} · automático]» con los flujos, especialistas, MCP, skills y agentes que encajan: síguela. Si pide algo que la nota no recoge, completa tú el criterio con el catálogo de arriba.

Tiempo: en CUALQUIER petición con trabajo, antes de empezar di en UNA línea cuánto tardará aprox. («⏱ ~X–Y min»). Si la nota trae una estimación calculada con el historial del usuario, úsala; si no, estímala tú por el tamaño del trabajo.
Calidad: en tareas no triviales escribe en UNA línea el criterio de «hecho» y compruébalo al final (verificador si tocas más de 2 archivos o es arriesgado). Preguntas y cambios pequeños van directos, sin flujo. Los subagentes no ven esta conversación: dales instrucciones completas y autocontenidas, y comprueba sus resultados. Anuncia cada delegación en una línea.
Seguridad: git push, reset --hard y clean piden confirmación al usuario (hook); no los intentes sin que lo pida.
Tokens: no releas archivos ya leídos; Grep/Glob antes de Read con offset/limit; no imprimas archivos o logs enteros; respuestas cortas, resultado primero.
Medición: si el usuario pregunta cuánto ahorra o delega, ejecuta \`node "${ROOT}/scripts/stats.mjs"\` y resume el resultado.
${cat.stack.summary ? `\nStack del proyecto: ${cat.stack.summary}.` : ''}${mcp.length ? `\nServidores MCP del usuario: ${mcp.join(', ')}. Si la tarea es de su herramienta, úsalos en vez de improvisar scripts (si sus herramientas aparecen diferidas, cárgalas con ToolSearch).` : ''}
Además hay ${cat.skills.length} skills/comandos, ${cat.agents.length} agentes y ${viaPlugins} servidores MCP de plugins instalados: en cada petición se te indican los que encajan.${pendingState(cwd)}`;
  emit(text);
}

try { main(); } catch { /* un hook nunca debe romper la sesión */ }
