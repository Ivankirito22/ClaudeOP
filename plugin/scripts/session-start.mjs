// Hook SessionStart: al abrir (o reanudar/compactar) la sesión, inventaría lo instalado y le da a Claude las reglas de delegación.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOW_CATALOG } from './intent.mjs';
import { NAME, buildCatalog, frontmatter } from './lib.mjs';

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const emit = (text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));

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

function main() {
  if (/^(off|0|false)$/i.test(process.env.CLAUDEOP || '')) return;
  let cwd = process.cwd();
  try { cwd = JSON.parse(fs.readFileSync(0, 'utf8')).cwd || cwd; } catch { /* sin stdin */ }

  const cat = buildCatalog(cwd);
  const r = roster();
  const base = ['explorador', 'limpiador', 'probador', 'documentador', 'investigador', 'revisor', 'depurador', 'verificador', 'arquitecto'];
  const spec = [...r.haiku, ...r.sonnet, ...r.opus].filter((n) => !base.includes(n));
  const customs = cat.flows.map((f) => `- ${f.label}${f.desc ? `: ${f.desc}` : ''} (flujo propio del usuario; síguelo cuando la petición encaje)`);
  // Solo los MCP propios del usuario/proyecto van siempre; los de plugins (cientos) se sugieren cuando encajan con la petición
  const own = cat.mcp.filter((m) => m.src === 'usuario' || m.src === 'proyecto');
  const mcp = own.map((m) => `${m.name} (${m.prefix}*)`);
  const viaPlugins = new Set(cat.mcp.filter((m) => !own.includes(m)).map((m) => m.name)).size;

  const text = `[${NAME}] Orquestación multi-modelo AUTOMÁTICA. El usuario no usa comandos ni etiquetas: tú reconoces qué quiere (aunque escriba con faltas de ortografía, jerga o frases mal montadas), eliges los flujos y agentes que encajan y delegas por tu cuenta, DENTRO de la misma petición. Los subagentes corren en otros modelos (herramienta Agent; subagent_type = \`${NAME}:<nombre>\`). Usa siempre el modelo más barato que haga bien cada paso.

Subagentes por modelo:
- haiku (barato): ${r.haiku.join(', ')}
- sonnet: ${r.sonnet.filter((n) => base.includes(n)).join(', ')} y los especialistas de tecnología (${spec.join(', ')})
- opus (caro): ${r.opus.join(', ')}

Reglas de reparto (obligatorias; hacer tú un trabajo de nivel barato gasta dinero del usuario):
- Leer/buscar/resumir mucho código: explorador. No leas muchos archivos tú.
- Ediciones mecánicas (código muerto, imports, renombres, formato): limpiador, con rutas y cambio exactos.
- Tests/build/lint: probador (solo informa de fallos). Documentación/comentarios/README: documentador. Buscar en la web: investigador.
- Bug no evidente: depurador halla la causa raíz ANTES de parchear. Revisar un diff o un cambio arriesgado: revisor.
- Decisiones difíciles (arquitectura, bugs rebeldes, algoritmos/rendimiento complejos, refactors arriesgados): arquitecto. Si el usuario dice que algo ya falló, consúltalo antes de reintentar.
- Trabajo de más de ~20 líneas en un lenguaje/herramienta concreta: el especialista de esa tecnología (en paralelo entre sí si tocan archivos distintos), con instrucciones completas; luego revisas su resultado. Si hay un MCP de esa herramienta, los especialistas de Blender y juegos pueden usarlo.
- Tú haces la implementación normal y la integración final.
Paralelismo: sub-pasos independientes (probador + revisor, varios explorador) se lanzan con TODAS las llamadas Agent en UN solo mensaje. Nunca en paralelo agentes que editen los mismos archivos.

${FLOW_CATALOG}
${customs.length ? `Flujos propios del usuario:\n${customs.join('\n')}\n` : ''}
Cada petición con trabajo de verdad llegará con una nota «[${NAME} · automático]» que ya trae los flujos, especialistas, MCP, skills y agentes de otros plugins que encajan: síguela. Si la petición pide algo más que la nota no recoge, completa tú el criterio con el catálogo de arriba.

Calidad: en tareas no triviales escribe en UNA línea el criterio de «hecho» y compruébalo al final (verificador si tocas más de 2 archivos o es arriesgado). Preguntas y cambios pequeños van directos, sin flujo. Los subagentes no ven esta conversación: dales instrucciones completas y autocontenidas, y comprueba sus resultados antes de darlos por buenos. Anuncia cada delegación en una línea.
Seguridad: no hagas git push, reset --hard ni clean salvo que el usuario lo pida expresamente.
Higiene de tokens: no releas archivos ya leídos; Grep/Glob antes de Read con offset/limit; no imprimas archivos o logs enteros; respuestas cortas y con el resultado primero.
${cat.stack.summary ? `\nStack del proyecto: ${cat.stack.summary}.` : ''}${mcp.length ? `\nServidores MCP del usuario: ${mcp.join(', ')}. Si la tarea es de su herramienta, úsalos en vez de improvisar scripts (si sus herramientas aparecen diferidas, cárgalas con ToolSearch).` : ''}
Además hay ${cat.skills.length} skills/comandos, ${cat.agents.length} agentes y ${viaPlugins} servidores MCP de plugins instalados: en cada petición se te indican los que encajan.`;
  emit(text);
}

try { main(); } catch { /* un hook nunca debe romper la sesión */ }
