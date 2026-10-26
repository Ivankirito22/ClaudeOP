// Estimación de cuánto tardará una tarea. Se calcula con lo que ha tardado de verdad cada tipo de tarea en esta máquina
// (track.mjs lo anota al terminar) y, mientras hay pocos datos, con valores iniciales razonables.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './data.mjs';

const DURATIONS = path.join(DATA, 'durations.jsonl');
const MIN_SAMPLES = 3;
const COMBO_FACTOR = 0.75; // varios flujos en un solo trabajo comparten exploración y verificación: tardan menos que la suma

// [p25, p75] en segundos, para cuando todavía no hay historial de ese tipo de tarea
const PRIORS = {
  '/feature': [480, 1500], '/bugprofundo': [300, 900], '/refactor': [480, 1500], '/decidir': [180, 480], '/auditoria': [300, 900],
  '/pulir': [180, 420], '/rendimiento': [300, 900], '/release': [180, 420], '/optimizar': [240, 720], '/limpiar': [120, 360],
  '/md': [90, 240], '/explicar': [60, 180], '/probar': [60, 240], '/tests': [240, 720], '/documentar': [120, 420],
  '/revisar': [120, 360], '/seguridad': [240, 720], '/investigar': [90, 300],
  propio: [300, 900], general: [180, 600],
};

function quantile(sorted, p) {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}

export function readDurations(since = 0) {
  const rows = [];
  try {
    for (const l of fs.readFileSync(DURATIONS, 'utf8').split('\n').slice(-1500)) {
      if (!l) continue;
      try { const r = JSON.parse(l); if (r.t >= since) rows.push(r); } catch { /* línea rota */ }
    }
  } catch { /* sin historial todavía */ }
  return rows;
}

export function recordDuration(row) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(DURATIONS, JSON.stringify(row) + '\n');
}

// Rango [p25, p75] de un tipo de tarea según el historial, o null si hay pocas muestras
export function spread(rows, key) {
  const s = rows.filter((r) => r.k === key).map((r) => r.sec).sort((a, b) => a - b);
  return s.length >= MIN_SAMPLES ? { lo: quantile(s, 0.25), hi: quantile(s, 0.75), n: s.length } : null;
}

// kinds: lista de flujos de la tarea ('/feature', '/tests'…, 'propio', 'general')
export function estimate(kinds) {
  const rows = readDurations();
  const exact = spread(rows, [...kinds].sort().join('+'));
  if (exact) return { lo: exact.lo, hi: exact.hi, n: exact.n, source: 'historial' };
  let lo = 0, hi = 0, n = 0;
  for (const k of kinds) {
    const h = spread(rows, k);
    const [a, b] = h ? [h.lo, h.hi] : PRIORS[k] || PRIORS.general;
    lo += a; hi += b; n += h ? h.n : 0;
  }
  if (kinds.length > 1) { lo *= COMBO_FACTOR; hi *= COMBO_FACTOR; }
  return { lo, hi, n, source: n ? 'historial' : 'inicial' };
}

export function fmt(sec) {
  if (sec < 90) return `${Math.max(10, Math.round(sec / 10) * 10)} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export function range({ lo, hi }) {
  const a = fmt(lo), b = fmt(hi);
  if (a === b) return `~${a}`;
  return a.endsWith(' min') && b.endsWith(' min') ? `~${parseInt(a)}–${b}` : `~${a}–${b}`; // «~9–28 min»
}
