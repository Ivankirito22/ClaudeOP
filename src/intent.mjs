// Reconoce, en lo que escribes con tus palabras, los flujos que ya existen ("optimiza el código" → Optimizar proyecto)
// y compone varias acciones en UNA sola instrucción. Todo local y gratis: no llama a ningún modelo.

import { SPEC_KEYS, SPEC_DESC, specialistsFor } from './stack.mjs';

export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// weak: solo cuenta si aparece al principio de una frase de 6+ palabras que no es pregunta (verbos muy genéricos: "haz", "añade"…; así un cambio pequeño no dispara un flujo grande)
const P = (re, weak = false) => ({ re, weak });

export const PATTERNS = {
  '/rendimiento': [P(/\b(rendimiento|performance|cuellos? de botella|bottlenecks?|va lento|esta lento|muy lento|lag|fps|tarda (mucho|demasiado))\b/)],
  '/optimizar': [P(/\boptimi[zc]\w*/), P(/\bmejora(r|me)? (el |la |todo el )?(codigo|proyecto|calidad)/)],
  '/limpiar': [P(/(codigo muerto|dead code|sin usar|no usad[oa]s?)/), P(/\blimpia(r)? (el )?(codigo|proyecto|imports)/)],
  '/md': [P(/claude\.md/), P(/\bcrea(r)? (un )?(archivo )?md\b/)],
  '/explicar': [P(/\bexplica(me|r)? (el )?(proyecto|repo|repositorio|todo)\b/), P(/como esta (organizado|estructurado)/), P(/por donde (empiezo|empezar)/)],
  '/probar': [P(/\b(ejecuta|corre|lanza|pasa)\w* (los |todos los )?(tests?|pruebas)/), P(/\bcompila\b/), P(/\b(haz|hacer) (un )?build\b/)],
  '/tests': [P(/\b(genera|escribe|crea|anade|agrega|haz)\w* (los |unos |mas |nuevos )?(tests?|pruebas unitarias)/)],
  '/documentar': [P(/\bdocumenta\w*/), P(/\banade comentarios/), P(/\bcomenta (el )?codigo/), P(/\b(jsdoc|docstrings?)\b/)],
  '/bugprofundo': [P(/\b(bugs?|crash|petar|peta|se rompe|se cuelga|no funciona|no va|falla|arregla\w*|soluciona\w*|depura\w*)\b/), P(/\b(errors?|errores|fallo|excepcion)\b/, true)],
  '/revisar': [P(/\brevisa\w*/), P(/\b(review|code review)\b/), P(/revision de codigo/)],
  '/seguridad': [P(/(seguridad|vulnerab|security|owasp|inyeccion|\bxss\b)/)],
  '/auditoria': [P(/\baudit\w*/), P(/(revision|analisis) completa?/)],
  '/refactor': [P(/\b(refactor\w*|reestructura\w*|reorganiza\w*)/)],
  '/decidir': [P(/(que|cual) (libreria|framework|herramienta|opcion|base de datos|enfoque) (usar|elegir|es mejor)/, true), P(/\b(compara\w*|elige entre|pros y contras)\b/, true)],
  '/pulir': [P(/\bpul(e|ir|o)\b|\bpule\w*/), P(/segunda pasada|repasa lo ultimo|toque final/)],
  '/release': [P(/\brelease\b/), P(/prepara (la |una )?(version|entrega|release)/), P(/\bchangelog\b|sacar version|publicar version/)],
  '/plugins': [P(/\bplugins?\b/), P(/servidores? mcp|\bmcp\b/)],
  '/investigar': [P(/\binvestiga\w*/), P(/busca (en )?(la )?(web|internet)/), P(/documentacion oficial/)],
  '/feature': [
    P(/\b(modela\w*|modelame|renderiza\w*|anima(r|me)?)\b/),
    P(/\bdisena\w* (un |una |el |la |los |las )?(modelo|personaje|nivel|pantalla|menu|interfaz|escena|sistema)/),
    P(/\b(crea|creame|crear|haz|hazme|hacer|anade|anademe|anadir|agrega|implementa\w*|construye\w*|genera\w*|desarrolla\w*|programa\w*|make|build|add|implement|create)\b/, true),
  ],
};

// Cuando una frase encaja con varios, el más específico gana
const SUPERSEDES = {
  '/rendimiento': ['/optimizar'],
  '/optimizar': ['/limpiar'],
  '/tests': ['/feature', '/probar'],
  '/documentar': ['/feature'],
  '/md': ['/feature', '/documentar'],
  '/auditoria': ['/revisar', '/seguridad'],
  '/refactor': ['/feature'],
  '/bugprofundo': ['/feature'],
};

// Orden de trabajo: primero lo que construye, luego lo que comprueba, al final la release
const RANK = ['/feature', '/bugprofundo', '/refactor', '/decidir', '/investigar', '/limpiar', '/optimizar', '/rendimiento', '/tests', '/documentar', '/md', '/plugins', '/explicar', '/probar', '/revisar', '/seguridad', '/auditoria', '/pulir', '/release'];
export const rank = (cmd) => { const i = RANK.indexOf(cmd); return i < 0 ? 50 : i; };

export const MAX_FLOWS = 4;

// Devuelve los cmd reconocidos en `text` (sin tocar nada más)
export function detectCmds(text) {
  const t = norm(text);
  if (!t.trim()) return [];
  const question = /\?\s*$/.test(t) || /^[\s¿]*(que|como|por que|donde|cual|cuando|quien|cuanto)\b/.test(t);
  const found = new Set();
  for (const [cmd, pats] of Object.entries(PATTERNS)) {
    for (const { re, weak } of pats) {
      const m = re.exec(t);
      if (!m) continue;
      if (weak && (question || m.index > 40 || t.trim().split(/\s+/).length < 6)) continue;
      found.add(cmd);
      break;
    }
  }
  for (const [winner, losers] of Object.entries(SUPERSEDES)) {
    if (found.has(winner)) for (const l of losers) found.delete(l);
  }
  return [...found].sort((a, b) => rank(a) - rank(b));
}

// Cada flujo en una línea, para que el modelo principal también reconozca los que no pillamos con palabras
export const FLOW_CATALOG = `Known workflows (the user's buttons). When a request resembles one, even if worded differently, follow that workflow's phases instead of improvising. For requests none of them covers (e.g. "create a model of X and optimize it"), still apply the same pattern: state the done criterion, explorador in parallel with investigador, plan with arquitecto only if hard, implement, probador + revisor in parallel, fix, verify; and if the user also asks to optimize/polish/clean, finish with an optimization pass (limpiador for mechanical cleanup, arquitecto only for hard performance decisions).
- Feature completa: done criterion → explorador+investigador (parallel) → arquitecto plan if 3+ files → implement → probador+revisor (parallel) → fix → documentador → verificador.
- Bug a fondo: probador reproduces → explorador+depurador (parallel) → arquitecto if cause unclear → minimal fix + regression test → probador+revisor → one lesson line.
- Refactor seguro: baseline tests → impact map → plan → small steps with tests between → revisor+verificador.
- Optimizar proyecto / Limpiar código muerto: explorador finds dead code and hotspots → limpiador fixes mechanical things → arquitecto only for hard calls → probador at the end.
- Cazar cuellos de botella: locate and measure in parallel → arquitecto ranks by impact/effort → apply the safe ones.
- Auditoría completa / Revisión / Seguridad: read-only, reviewers in parallel → prioritized list.
- Pulir lo último: second pass on what just changed: revisor+probador → fix → verificador.
- Investigar y decidir: one investigador per option (parallel) → arquitecto compares against THIS project.
- Preparar release: tests + changes in parallel → risks → changelog → proposed version (never push).`;

// ---------- Componer acciones + texto en una sola instrucción ----------
export const needsText = (a) => !!a.input;

export function bodyOf(a, text) {
  if (a.wrap) return a.wrap(text || '(la petición del usuario está arriba)');
  if (a.prompt) return a.prompt;
  return text || '';
}

export function composePrompt(list, text) {
  const t = String(text || '').trim();
  if (!list.length) return t;
  if (list.length === 1) {
    const a = list[0];
    if (a.wrap) return a.wrap(t);
    if (a.prompt) return t ? `${a.prompt}\n\nPetición concreta del usuario (tiene prioridad): ${t}` : a.prompt;
    return t;
  }
  const parts = list.map((a, i) => `### Flujo ${i + 1}: ${a.label}\n${bodyOf(a, t)}`);
  return `${t ? `PETICIÓN DEL USUARIO (prioridad máxima): ${t}\n\n` : ''}Haz TODO lo siguiente en UNA sola instrucción, como un único trabajo coordinado. Aplica cada flujo como método para esta petición. Reglas de combinación: un solo explorador para todo (no repitas la exploración), el paralelismo de cada flujo se mantiene, UN solo verificador al final, y si un flujo es de solo lectura (revisión/auditoría) ejecútalo DESPUÉS de implementar y sobre el resultado. Empieza anunciando en una línea el orden que seguirás.

${parts.join('\n\n')}`;
}

// ---------- Enrutador con Haiku (entiende faltas de ortografía, jerga y frases raras) ----------
export const FLOW_DESC = {
  '/optimizar': 'optimizar el proyecto: limpiar, quitar duplicados, mejorar sin cambiar el comportamiento',
  '/limpiar': 'quitar código muerto, imports sin usar',
  '/md': 'crear o actualizar el CLAUDE.md del proyecto',
  '/explicar': 'explicar qué hace el proyecto y cómo está organizado',
  '/probar': 'ejecutar tests / compilar',
  '/tests': 'escribir tests nuevos',
  '/documentar': 'documentar el código (comentarios, README)',
  '/bug': 'cazar un bug sencillo',
  '/bugprofundo': 'arreglar un bug o error a fondo (reproducir, causa raíz, test)',
  '/revisar': 'revisar el código / los cambios',
  '/seguridad': 'auditoría de seguridad',
  '/auditoria': 'auditoría completa (calidad + seguridad), solo lectura',
  '/refactor': 'refactorizar sin romper nada',
  '/decidir': 'investigar opciones/librerías y decidir cuál usar',
  '/pulir': 'segunda pasada sobre lo último que se cambió',
  '/rendimiento': 'cazar cuellos de botella, lag, cosas lentas',
  '/release': 'preparar una release/versión (changelog)',
  '/plugins': 'recomendar plugins o servidores MCP',
  '/investigar': 'investigar algo en la web',
  '/feature': 'crear/implementar algo nuevo (funcionalidad, modelo, pantalla, sistema…)',
};

export const ROUTER_MARK = 'enrutador de un asistente de programación';

export function routerPrompt(text, actions) {
  const list = actions.map((a) => `${a.cmd}: ${FLOW_DESC[a.cmd] || a.label}`).join('\n');
  return `Eres el ${ROUTER_MARK}. Lee la petición del usuario (puede tener faltas de ortografía, jerga, mezcla de idiomas o estar mal redactada: entiende lo que quiere decir) y responde SOLO con un JSON en una línea, sin texto extra ni explicaciones:
{"kind":"pregunta|pequeno|tarea","flows":["/comando",...],"tech":["clave",...]}
- kind: "pregunta" = solo quiere información o una explicación; "pequeno" = un cambio trivial (un archivo, pocas líneas); "tarea" = cualquier otra cosa que implique construir, cambiar, arreglar, optimizar, analizar o planificar.
- flows: los flujos de esta lista que encajan con lo que PIDE (puede haber varios; [] si ninguno encaja). No inventes comandos.
- tech: las tecnologías/lenguajes/herramientas con las que HAY QUE TRABAJAR para hacer lo pedido (de la lista de claves de abajo; [] si no se nombra ni se deduce ninguna; máximo 3). Solo las que de verdad hacen falta.
Flujos:
${list}
Claves de tech: ${SPEC_KEYS.map((k) => `${k} (${SPEC_DESC[k]})`).join(', ')}

Petición del usuario:
<<<
${text}
>>>`;
}

// Devuelve { kind, cmds, techs } o null si la respuesta no es utilizable
export function parseRouter(out, allowed) {
  const m = /\{[\s\S]*?\}/.exec(String(out || ''));
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const kind = ['pregunta', 'pequeno', 'pequeño', 'tarea'].includes(j.kind) ? (j.kind === 'pequeño' ? 'pequeno' : j.kind) : null;
  if (!kind) return null;
  const cmds = (Array.isArray(j.flows) ? j.flows : []).filter((c) => typeof c === 'string' && allowed.includes(c));
  const techs = [...new Set((Array.isArray(j.tech) ? j.tech : []).map((t) => String(t).toLowerCase()).filter((t) => SPEC_KEYS.includes(t)))].slice(0, 3);
  return { kind, cmds: [...new Set(cmds)].sort((a, b) => rank(a) - rank(b)), techs };
}

// Sin Haiku (sin red, sin login…): palabras clave y una estimación del tipo de petición
export function localRoute(text) {
  const cmds = detectCmds(text);
  const t = norm(text).trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  const question = /\?\s*$/.test(t) || /^[\s¿]*(que|como|por que|donde|cual|cuando|quien|cuanto)\b/.test(t);
  const kind = question ? 'pregunta' : words >= 6 || cmds.length ? 'tarea' : 'pequeno';
  return { kind, cmds, techs: specialistsFor(text).slice(0, 3) };
}

// Para lo que no encaja con ningún flujo pero es un trabajo de verdad: el método completo, igualmente
export const GENERAL = {
  cmd: '/general',
  label: 'Método general',
  wrap: (t) => `MÉTODO GENERAL (esta petición no encaja con un flujo concreto; aplica igualmente el método de trabajo completo). Petición: ${t}

1. Criterio de "hecho": 1-2 líneas.
2. ENTENDER — en PARALELO: explorador mapea lo relacionado (si hay código o archivos) e investigador busca documentación solo si hace falta una API/librería que no conoces.
3. PLANIFICAR — arquitecto solo si es grande o tiene decisiones difíciles (3+ archivos, algoritmos, diseño); si no, un plan de 3 líneas tuyo.
4. HACER — implementa tú (o el especialista del stack si es grande); lo mecánico (renombres, boilerplate, borrar lo muerto) a limpiador. No hagas tú lo que un agente barato hace igual de bien.
5. COMPROBAR — en PARALELO: probador (tests/build/lint, solo fallos) y revisor (revisa el diff).
6. OPTIMIZAR — una pasada corta sobre lo que acabas de tocar: código muerto, duplicados, cuellos de botella evidentes (limpiador; arquitecto solo si hay una decisión de rendimiento difícil).
7. VERIFICAR — verificador contra el criterio de "hecho" si el cambio toca más de 2 archivos o es arriesgado.
Si la petición es solo de análisis o planificación (no hay que tocar archivos), salta 4-7 y entrega el análisis o el plan (con arquitecto si es difícil).
Termina con: qué hiciste, archivos tocados, resultado de tests y pendientes (máx. 10 líneas).`,
};
