// Cuánto se ha delegado de verdad: lee el registro que escribe track.mjs.
//   node stats.mjs                 → últimos 7 días
//   node stats.mjs --dias 30       → otro periodo (o --todo)
//   node stats.mjs --precios haiku=1,sonnet=3,opus=15 → además un índice de coste relativo con TUS precios
//   node stats.mjs --json          → salida en JSON
import fs from 'node:fs';
import { USAGE, CONTEXT, tierOf } from './data.mjs';
import { readDurations, spread, fmt as fmtTime } from './eta.mjs';
import { FLOWS } from './flows.mjs';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const flag = (n) => process.argv.includes(n);
const dias = flag('--todo') ? Infinity : Number(arg('--dias')) || 7;
const since = dias === Infinity ? 0 : Date.now() - dias * 24 * 3600 * 1000;

const rows = [];
try {
  for (const l of fs.readFileSync(USAGE, 'utf8').split('\n')) {
    if (!l) continue;
    try { const r = JSON.parse(l); if (r.t >= since) rows.push(r); } catch { /* línea rota */ }
  }
} catch { /* sin registro todavía */ }

// Contexto por turno: la cifra que de verdad dispara el gasto (se reenvía entera en cada mensaje)
const ctxs = [];
try {
  for (const l of fs.readFileSync(CONTEXT, 'utf8').split('\n')) {
    if (!l) continue;
    try { const r = JSON.parse(l); if (r.t >= since && r.tok) ctxs.push(r.tok); } catch { /* línea rota */ }
  }
} catch { /* sin registro todavía */ }
ctxs.sort((a, b) => a - b);
const ctxP50 = ctxs.length ? ctxs[Math.floor((ctxs.length - 1) / 2)] : 0;
const ctxMax = ctxs.length ? ctxs[ctxs.length - 1] : 0;

const tot = (r) => r.i + r.o + r.r + r.c;
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const bar = (p) => '█'.repeat(Math.round(p / 10)).padEnd(10, '░');

const byTier = {};
const byAgent = {};
for (const r of rows) {
  const tier = tierOf(r.m);
  const t = (byTier[tier] ||= { main: 0, sub: 0, out: 0 });
  t[r.k === 'main' ? 'main' : 'sub'] += tot(r);
  t.out += r.o;
  if (r.k === 'sub') {
    const a = (byAgent[r.a] ||= { runs: 0, tokens: 0, out: 0, models: new Set() });
    a.runs += 1; a.tokens += tot(r); a.out += r.o; a.models.add(tierOf(r.m));
  }
}
const total = Object.values(byTier).reduce((n, t) => n + t.main + t.sub, 0);
const subTotal = Object.values(byTier).reduce((n, t) => n + t.sub, 0);
const sessions = new Set(rows.map((r) => r.s)).size;

// Índice de coste con precios que da el usuario (no inventamos precios): real frente a «todo en el modelo principal»
let index = null;
const precios = arg('--precios');
if (precios && total) {
  const p = Object.fromEntries(precios.split(',').map((x) => x.split('=')).map(([k, v]) => [k.trim(), Number(v)]));
  const mainTier = Object.entries(byTier).sort((a, b) => b[1].main - a[1].main)[0]?.[0];
  if (mainTier && p[mainTier]) {
    const real = Object.entries(byTier).reduce((n, [k, t]) => n + (t.main + t.sub) * (p[k] ?? p[mainTier]), 0);
    index = { mainTier, ratio: real / (total * p[mainTier]) };
  }
}

// Tiempos reales por tipo de tarea (los que usa la estimación «⏱ ~X–Y min»)
const durs = readDurations(since);
const label = (k) => k.split('+').map((c) => FLOWS.find((a) => a.cmd === c)?.label || (c === 'propio' ? 'Flujo propio' : c === 'general' ? 'Método general' : c)).join(' + ');
const times = [...new Set(durs.map((d) => d.k))].map((k) => {
  const all = durs.filter((d) => d.k === k).map((d) => d.sec).sort((a, b) => a - b);
  const sp = spread(durs, k);
  return { kind: k, n: all.length, mediana: all[Math.floor((all.length - 1) / 2)], p25: sp?.lo, p75: sp?.hi };
}).sort((a, b) => b.n - a.n);

if (flag('--json')) {
  console.log(JSON.stringify({ dias, sesiones: sessions, tokens: total, delegado: subTotal, contexto: { turnos: ctxs.length, mediana: ctxP50, maximo: ctxMax }, porModelo: byTier, porAgente: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, { ...v, models: [...v.models] }])), indice: index, tiempos: times }, null, 2));
  process.exit(0);
}

if (!total && !times.length) {
  console.log(`claudeop · sin datos todavía${dias === Infinity ? '' : ` en los últimos ${dias} días`}. Se anotan solos al terminar cada respuesta: usa Claude Code un rato y vuelve a mirar.`);
  process.exit(0);
}

console.log(`claudeop · uso de ${dias === Infinity ? 'todo el historial' : `los últimos ${dias} días`} (${sessions} sesión${sessions === 1 ? '' : 'es'})\n`);
if (total) {
console.log('Tokens por modelo (entrada + salida + caché)');
for (const [k, t] of Object.entries(byTier).sort((a, b) => (b[1].main + b[1].sub) - (a[1].main + a[1].sub))) {
  const n = t.main + t.sub;
  console.log(`  ${k.padEnd(7)} ${bar((n / total) * 100)} ${String(Math.round((n / total) * 100)).padStart(3)}%  ${fmt(n).padStart(6)}   principal ${fmt(t.main)} · subagentes ${fmt(t.sub)}`);
}
const cheap = (byTier.haiku?.main || 0) + (byTier.haiku?.sub || 0);
console.log(`\nDelegado en subagentes: ${Math.round((subTotal / total) * 100)}% de los tokens · en Haiku: ${Math.round((cheap / total) * 100)}%`);
if (index) console.log(`Coste relativo con tus precios: ${(index.ratio * 100).toFixed(0)}% de lo que habría costado todo en ${index.mainTier} (≈ ${Math.round((1 - index.ratio) * 100)}% menos; cuenta todos los tipos de token por igual, es una estimación).`);
else console.log('Para un índice de coste: añade --precios haiku=1,sonnet=3,opus=15 (pon los precios reales de tu plan).');
}

if (ctxs.length) {
  console.log(`\nContexto por turno (lo que se reenvía en cada mensaje): mediana ${fmt(ctxP50)} · máximo ${fmt(ctxMax)} · ${ctxs.length} respuestas${ctxMax > 220000 ? ' — pasa de 220k: conviene compactar antes' : ''}`);
}

if (Object.keys(byAgent).length) {
  console.log('\nSubagentes');
  for (const [k, a] of Object.entries(byAgent).sort((x, y) => y[1].tokens - x[1].tokens).slice(0, 12)) {
    console.log(`  ${k.padEnd(14)} ${String(a.runs).padStart(3)} uso${a.runs === 1 ? ' ' : 's'}  ${[...a.models].join('/').padEnd(10)} ${fmt(a.tokens).padStart(6)} tokens (${fmt(a.out)} de salida)`);
  }
} else if (total) {
  console.log('\nNingún subagente en este periodo: todo el trabajo lo hizo el modelo principal.');
}

if (times.length) {
  console.log('\nTiempo real por tipo de tarea (con esto se calcula el «⏱ ~X–Y min» de cada petición)');
  for (const x of times.slice(0, 10)) {
    const rango = x.p25 != null ? `${fmtTime(x.p25)}–${fmtTime(x.p75)}` : 'aún pocas muestras';
    console.log(`  ${label(x.kind).slice(0, 34).padEnd(34)} ${String(x.n).padStart(3)}×  mediana ${fmtTime(x.mediana).padEnd(8)} rango habitual ${rango}`);
  }
}
