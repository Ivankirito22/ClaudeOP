// Historial de uso (~/.claude-router/history.jsonl): coste y reparto por modelo de cada instrucción.
// Sirve para el informe semanal, para estimar lo que cuesta una acción y para detectar si Sonnet delega poco.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = () => process.env.CR_HISTORY_FILE || path.join(os.homedir(), '.claude-router', 'history.jsonl');
const MAX_LINES = 4000;

export function record(entry) {
  const f = FILE();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
    const st = fs.statSync(f);
    if (st.size > 2_000_000) { // recorta el archivo: se queda con las últimas MAX_LINES
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(f, lines.slice(-MAX_LINES).join('\n') + '\n');
    }
  } catch { /* el historial es opcional */ }
}

export function load({ days = 7, cwd = null } = {}) {
  let lines;
  try { lines = fs.readFileSync(FILE(), 'utf8').split('\n'); } catch { return []; }
  const since = Date.now() - days * 86400000;
  const out = [];
  for (const l of lines) {
    if (!l) continue;
    try {
      const e = JSON.parse(l);
      if (e.ts >= since && (!cwd || e.cwd === cwd)) out.push(e);
    } catch { /* línea rota */ }
  }
  return out;
}

// Coste típico de una acción (media de sus últimas ejecuciones con coste > 0).
export function typicalCost(label, { min = 2, last = 6 } = {}) {
  if (!label) return null;
  const xs = load({ days: 90 }).filter((e) => e.label === label && e.cost > 0).slice(-last);
  if (xs.length < min) return null;
  return { cost: xs.reduce((a, e) => a + e.cost, 0) / xs.length, n: xs.length };
}

// Tiempo aproximado de una instrucción: mediana de las últimas veces que se hizo lo mismo (o de las últimas parecidas si es nueva).
// Devuelve { ms, n, basis: 'similares'|'general' } o null si aún no hay datos.
export function estimateMs(label, { last = 6 } = {}) {
  const all = load({ days: 90 }).filter((e) => !e.error && e.ms > 0);
  const med = (xs) => { const v = xs.map((e) => e.ms).sort((a, b) => a - b); return v[Math.floor((v.length - 1) / 2)] ?? 0; };
  const same = all.filter((e) => (e.label || null) === (label || null)).slice(-last);
  if (same.length >= 1) return { ms: med(same), n: same.length, basis: 'similares' };
  const gen = all.filter((e) => e.ms > 15000).slice(-10);
  if (gen.length >= 3) return { ms: med(gen), n: gen.length, basis: 'general' };
  return null;
}

export function summarize(entries) {
  const t = { runs: entries.length, cost: 0, out: { haiku: 0, sonnet: 0, opus: 0 }, delegSum: 0, delegN: 0, ms: 0, errors: 0, byProject: {}, byLabel: {} };
  for (const e of entries) {
    t.cost += e.cost || 0;
    t.ms += e.ms || 0;
    if (e.error) t.errors++;
    for (const k of Object.keys(t.out)) t.out[k] += e.out?.[k] || 0;
    if (typeof e.delegated === 'number') { t.delegSum += e.delegated; t.delegN++; }
    const p = path.basename(e.cwd || '?') || '?';
    t.byProject[p] = (t.byProject[p] || 0) + (e.cost || 0);
    const l = e.label || 'instrucción libre';
    const o = (t.byLabel[l] = t.byLabel[l] || { n: 0, cost: 0 });
    o.n++;
    o.cost += e.cost || 0;
  }
  t.delegated = t.delegN ? t.delegSum / t.delegN : null;
  const totalOut = t.out.haiku + t.out.sonnet + t.out.opus;
  t.share = totalOut ? { haiku: t.out.haiku / totalOut, sonnet: t.out.sonnet / totalOut, opus: t.out.opus / totalOut } : { haiku: 0, sonnet: 0, opus: 0 };
  t.tips = [];
  if (t.runs >= 5 && t.delegated !== null && t.delegated < 0.15) t.tips.push('Sonnet delega muy poco (<15%). Usa los flujos (Feature completa, Bug a fondo…) o pide "delega lo mecánico".');
  if (totalOut > 0 && t.share.opus > 0.35) t.tips.push('Más del 35% de la salida es de Opus: reserva Opus para decisiones difíciles (perfil Equilibrado o Económico).');
  if (totalOut > 0 && t.share.haiku < 0.1 && t.runs >= 5) t.tips.push('Casi nada va a Haiku: hay trabajo mecánico que podrías abaratar (/limpiar, /documentar, /probar).');
  if (t.errors / Math.max(1, t.runs) > 0.2) t.tips.push('Más del 20% de las instrucciones terminan con error: revisa permisos (/permitir) o el login.');
  return t;
}
