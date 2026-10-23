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
