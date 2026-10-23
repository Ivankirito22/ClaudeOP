// Plan previo: antes de ejecutar, una lista con checks (todo marcado) de lo que se va a hacer.
// Desmarcas lo que no quieras (un flujo entero, un paso o un especialista) y se ejecuta solo lo marcado.
import { SPECIALISTS } from './stack.mjs';

export const STEPS = [
  { id: 'explorar', label: 'Explorar el código', who: 'explorador', tier: 'haiku' },
  { id: 'investigar', label: 'Buscar documentación en la web', who: 'investigador', tier: 'haiku' },
  { id: 'depurar', label: 'Encontrar la causa raíz del fallo', who: 'depurador', tier: 'sonnet' },
  { id: 'planificar', label: 'Plan / decisiones difíciles', who: 'arquitecto', tier: 'opus' },
  { id: 'implementar', label: 'Implementar los cambios', who: 'principal', tier: 'sonnet' },
  { id: 'mecanico', label: 'Limpieza mecánica (código muerto, imports…)', who: 'limpiador', tier: 'haiku' },
  { id: 'probar', label: 'Probar / compilar', who: 'probador', tier: 'haiku' },
  { id: 'revisar', label: 'Revisar los cambios', who: 'revisor', tier: 'sonnet' },
  { id: 'optimizar', label: 'Pasada de optimización', who: 'limpiador', tier: 'haiku' },
  { id: 'documentar', label: 'Documentar', who: 'documentador', tier: 'haiku' },
  { id: 'verificar', label: 'Verificación final independiente', who: 'verificador', tier: 'sonnet' },
];
const STEP = Object.fromEntries(STEPS.map((s) => [s.id, s]));

const FLOW_STEPS = {
  '/feature': ['explorar', 'investigar', 'planificar', 'implementar', 'probar', 'revisar', 'documentar', 'verificar'],
  '/bugprofundo': ['explorar', 'depurar', 'planificar', 'implementar', 'probar', 'revisar'],
  '/refactor': ['explorar', 'planificar', 'implementar', 'probar', 'revisar', 'verificar'],
  '/optimizar': ['explorar', 'mecanico', 'planificar', 'probar'],
  '/limpiar': ['explorar', 'mecanico', 'probar'],
  '/rendimiento': ['explorar', 'planificar', 'implementar', 'probar'],
  '/tests': ['explorar', 'implementar', 'probar'],
  '/documentar': ['explorar', 'documentar'],
  '/md': ['explorar', 'documentar'],
  '/revisar': ['revisar'],
  '/seguridad': ['explorar', 'revisar'],
  '/auditoria': ['explorar', 'revisar'],
  '/decidir': ['investigar', 'planificar'],
  '/investigar': ['investigar'],
  '/pulir': ['revisar', 'probar', 'mecanico', 'verificar'],
  '/release': ['probar', 'revisar', 'documentar'],
  '/explicar': ['explorar'],
  '/probar': ['probar'],
  '/plugins': ['investigar'],
  '/general': ['explorar', 'investigar', 'planificar', 'implementar', 'probar', 'revisar', 'optimizar', 'verificar'],
};
const DEFAULT_STEPS = ['explorar', 'implementar', 'probar'];

export function newPlan({ flows, specs, text, note }) {
  return {
    text: text || '',
    note: note || '',
    flows: flows.map((a) => ({ cmd: a.cmd, label: a.label, action: a, on: true })),
    specs: (specs || []).filter((k) => SPECIALISTS[k]).map((k) => ({ key: k, on: true })),
    stepOff: new Set(),
  };
}

const stepsOf = (cmd) => FLOW_STEPS[cmd] || DEFAULT_STEPS;

// Pasos que aparecen: los de los flujos marcados, en el orden de trabajo
export function visibleSteps(plan) {
  const ids = new Set();
  for (const f of plan.flows) if (f.on) for (const id of stepsOf(f.cmd)) ids.add(id);
  return STEPS.filter((s) => ids.has(s.id));
}

// Lista plana (para la web y para pintarla en la terminal): { id, kind, label, sub, on, tier }
export function planItems(plan) {
  const items = [];
  for (const f of plan.flows) items.push({ id: 'flow:' + f.cmd, kind: 'flow', label: f.label, sub: 'flujo', on: f.on });
  for (const s of visibleSteps(plan)) items.push({ id: 'step:' + s.id, kind: 'step', label: s.label, sub: s.who === 'principal' ? 'Sonnet' : `${s.who} · ${s.tier}`, on: !plan.stepOff.has(s.id), tier: s.tier });
  for (const sp of plan.specs) items.push({ id: 'spec:' + sp.key, kind: 'spec', label: `Especialista ${SPECIALISTS[sp.key].tag}`, sub: 'solo para esta tarea · sonnet', on: sp.on, tier: 'sonnet' });
  return items;
}

export function togglePlan(plan, id) {
  const [kind, key] = String(id).split(/:(.*)/s);
  if (kind === 'flow') { const f = plan.flows.find((x) => x.cmd === key); if (f) f.on = !f.on; return !!f; }
  if (kind === 'step') { if (!STEP[key]) return false; if (plan.stepOff.has(key)) plan.stepOff.delete(key); else plan.stepOff.add(key); return true; }
  if (kind === 'spec') { const s = plan.specs.find((x) => x.key === key); if (s) s.on = !s.on; return !!s; }
  return false;
}

// Lo que se ejecuta de verdad: flujos marcados, especialistas marcados y los pasos desmarcados (de los visibles)
export function resolvePlan(plan) {
  const flows = plan.flows.filter((f) => f.on).map((f) => f.action);
  const specs = plan.specs.filter((s) => s.on).map((s) => s.key);
  const skipped = visibleSteps(plan).filter((s) => plan.stepOff.has(s.id));
  return { flows, specs, skipped };
}

// Aviso para el modelo principal: lo desmarcado NO se hace
export function skipNote(skipped) {
  if (!skipped.length) return '';
  const list = skipped.map((s) => `${s.label}${s.who !== 'principal' ? ' (' + s.who + ')' : ''}`).join('; ');
  return `\n\nAJUSTES DEL USUARIO SOBRE EL PLAN (obligatorios): el usuario DESMARCÓ estos pasos, así que NO los hagas ni delegues en ellos aunque el flujo los incluya: ${list}.`;
}

export function planLines(plan) {
  const items = planItems(plan);
  const out = items.map((it, i) => ` ${String(i + 1).padStart(2)}  ${it.on ? '☑' : '☐'} ${it.label}  {gray-fg}${it.sub}{/}`);
  return { items, text: out.join('\n') };
}

const DESC = {
  '/optimizar': 'Mejora el proyecto sin cambiar lo que hace: el explorador lo recorre y detecta código muerto, imports sin usar, duplicados y cuellos de botella; el limpiador arregla lo mecánico; el arquitecto (Opus) solo entra si hay una decisión difícil; y el probador corre tests/build al final. Termina con lo que cambió y lo que recomienda aparte.',
  '/limpiar': 'Busca y borra código muerto (imports, variables y funciones sin uso, bloques comentados viejos, archivos huérfanos). Comprueba con grep que nada lo referencia antes de borrar y luego prueba que todo sigue funcionando.',
  '/md': 'Crea o actualiza el CLAUDE.md del proyecto (descripción, comandos de build/test, estructura, convenciones y trampas) sin tocar el bloque de reglas del router.',
  '/explicar': 'Te explica qué hace el proyecto, cómo está organizado y por dónde empezar a tocar, con los archivos clave. Es solo lectura y barato: lo lee el explorador (Haiku).',
  '/probar': 'Ejecuta tests, build y linter (detecta los comandos solo) con el probador (Haiku) y te dice únicamente lo que falla, con una propuesta de arreglo.',
  '/tests': 'Detecta el framework de tests, busca las funciones importantes sin cobertura, escribe tests para ellas y se queda con los que pasan.',
  '/documentar': 'Añade o actualiza comentarios útiles, docstrings y el README donde falten, partiendo del código real. No cambia el comportamiento y lista los archivos tocados.',
  '/bug': 'Para un bug concreto: escribe tú qué pasa y Claude lo busca y lo arregla. Si es un bug difícil, mejor usa «Bug a fondo».',
  '/revisar': 'Revisa los cambios sin commitear (git diff) con el revisor: bugs, casos límite, seguridad y legibilidad. No modifica nada, te da una lista priorizada.',
  '/seguridad': 'Revisión de seguridad con el revisor: secretos en el código, inyecciones, dependencias peligrosas, permisos y validación de entradas. Solo informa, no toca nada.',
  '/commit': 'Mira los cambios (incluidos los staged) y te propone un mensaje de commit claro. Lo hace Haiku, así que es casi gratis. No hace el commit.',
  '/plugins': 'Analiza el proyecto y te recomienda plugins, skills, subagentes y servidores MCP de Claude Code que te ahorren tiempo o tokens.',
  '/investigar': 'Escribe qué quieres saber y el investigador (Haiku) lo busca en la web y en la documentación y te trae un resumen con fuentes.',
  '/feature': 'Funcionalidad nueva de principio a fin: explora el código, busca documentación, el arquitecto (Opus) diseña el plan, Sonnet implementa, se prueba, se revisa, se documenta y un verificador independiente lo comprueba al final.',
  '/bugprofundo': 'Para bugs difíciles: el depurador busca la causa raíz (no el síntoma), el arquitecto decide el arreglo, Sonnet lo implementa, se prueba y se revisa. Más caro que «Cazar un bug», pero acierta más.',
  '/refactor': 'Refactor sin romper nada: se explora, el arquitecto planifica los pasos, Sonnet los aplica, se prueban después de cada cambio, se revisa y un verificador independiente confirma que el comportamiento es el mismo.',
  '/decidir': 'Para elegir entre opciones: el investigador reúne datos de la web y el arquitecto (Opus) compara y recomienda con pros y contras.',
  '/auditoria': 'Auditoría completa en paralelo (sin modificar nada): varios revisores miran calidad, seguridad y rendimiento a la vez y se junta todo en un informe priorizado.',
  '/pulir': 'Repasa solo lo que cambiaste en esta sesión: revisor y probador en paralelo, el limpiador quita lo sobrante y un verificador independiente da el visto bueno.',
  '/rendimiento': 'Caza cuellos de botella: el explorador localiza los puntos calientes probables, el arquitecto prioriza, Sonnet aplica las mejoras seguras y el probador comprueba que nada se rompe.',
  '/release': 'Prepara una release sin hacer push ni tags: tests/build/lint, revisión de lo cambiado desde el último tag, notas de versión y changelog.',
  '/condensar': 'Reordena las lecciones que Claude ha ido apuntando (.claude/lecciones.md): une duplicados, borra lo obsoleto y lo deja en 30 líneas máximo. Ahorra tokens en cada sesión.',
  '/rapido': 'La siguiente instrucción se hace entera con Haiku (el más barato y rápido). Útil para preguntas cortas o cosas mecánicas.',
  '/profundo': 'La siguiente instrucción se hace entera con Opus (el más listo, y el más caro). Para pensar a fondo, diseñar o decidir algo difícil.',
  '/general': 'El método general: explora, investiga, planifica, implementa, prueba, revisa, optimiza y verifica. Es el que se usa cuando pides algo que no encaja en un flujo concreto.',
};
// Ficha informativa de una etiqueta (la ventanita ⓘ): qué hace, qué agentes usa y en qué modelo
const AGENT_RE = /\b(explorador|investigador|depurador|arquitecto|limpiador|probador|revisor|documentador|verificador)\b/g;
const TIER_NAME = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
export function actionInfo(a) {
  const prompt = String(a.prompt || a.prefill || '');
  let steps = FLOW_STEPS[a.cmd] ? FLOW_STEPS[a.cmd].map((id) => STEP[id]).filter(Boolean) : [];
  if (!steps.length) {
    // acciones sueltas: los agentes que nombra su instrucción
    const names = [...new Set([...prompt.matchAll(AGENT_RE)].map((m) => m[1]))];
    steps = names.map((n) => STEPS.find((s) => s.who === n)).filter(Boolean);
  }
  const byWho = new Map();
  for (const st of steps) {
    if (st.who === 'principal') continue;
    if (!byWho.has(st.who)) byWho.set(st.who, { who: st.who, tier: st.tier, does: [] });
    byWho.get(st.who).does.push(st.label);
  }
  const first = prompt.replace(/\s+/g, ' ').trim().split(/(?<=[.:!?])\s/)[0] || '';
  const main = a.main ? TIER_NAME[a.main] : 'Sonnet';
  return {
    what: DESC[a.cmd] || a.hint || (first.length > 240 ? first.slice(0, 237) + '…' : first),
    main: a.main ? `Todo con ${main} (modelo a mano)` : 'Sonnet coordina',
    agents: [...byWho.values()],
    steps: steps.map((st) => ({ label: st.label, who: st.who, tier: st.tier })),
    flow: !!FLOW_STEPS[a.cmd],
    prompt: prompt.length > 700 ? prompt.slice(0, 697) + '…' : prompt,
    needsText: !!a.input,
  };
}
