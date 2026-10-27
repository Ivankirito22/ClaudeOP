// Hooks SubagentStop y Stop (asíncronos, no frenan nada): anotan qué modelo ha gastado cuántos tokens,
// en el hilo principal y en cada subagente, para que `stats.mjs` pueda demostrar lo que se delega.
//   node track.mjs sub   ← SubagentStop (lee el transcript del subagente)
//   node track.mjs main  ← Stop (lee el transcript de la sesión y anota lo nuevo desde la última vez)
import fs from 'node:fs';
import path from 'node:path';
import { DATA, USAGE, CONTEXT, off, readJson, writeJson, sessionFile } from './data.mjs';
import { recordDuration } from './eta.mjs';
import { contextTokens } from './ctx.mjs';
import { updateSession } from './memory.mjs';

const MAX_TRANSCRIPT = 80 * 1024 * 1024;
const DIAS_30 = 30 * 24 * 3600 * 1000;

// Tokens por modelo de un transcript .jsonl. Cada mensaje puede aparecer repetido: se cuenta una vez por id.
export function usageByModel(file) {
  const out = {};
  if (!file || fs.statSync(file).size > MAX_TRANSCRIPT) return out;
  const seen = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (e.type !== 'assistant' || !m?.usage || !m.model || m.model.startsWith('<')) continue;
    seen.set(m.id || `${seen.size}`, { model: m.model, u: m.usage });
  }
  for (const { model, u } of seen.values()) {
    const t = (out[model] ||= { i: 0, o: 0, r: 0, c: 0 });
    t.i += u.input_tokens || 0; t.o += u.output_tokens || 0;
    t.r += u.cache_read_input_tokens || 0; t.c += u.cache_creation_input_tokens || 0;
  }
  return out;
}

function append(rows) {
  if (!rows.length) return;
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(USAGE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // Rotación: el registro no crece sin fin
  if (fs.statSync(USAGE).size > 4 * 1024 * 1024) {
    const lines = fs.readFileSync(USAGE, 'utf8').trim().split('\n');
    fs.writeFileSync(USAGE, lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n');
  }
}

// Tamaño del contexto al terminar cada respuesta (lo que se reenvía en el turno siguiente): stats.mjs saca mediana y máximo
function recordContext(row) {
  if (!row.tok) return;
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(CONTEXT, JSON.stringify(row) + '\n');
  if (fs.statSync(CONTEXT).size > 512 * 1024) {
    const lines = fs.readFileSync(CONTEXT, 'utf8').trim().split('\n');
    fs.writeFileSync(CONTEXT, lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n');
  }
}

function sweep() {
  try {
    for (const f of fs.readdirSync(DATA)) {
      if (!/^(sess|main|notify)-.*\.json$/.test(f)) continue;
      const p = path.join(DATA, f);
      if (Date.now() - fs.statSync(p).mtimeMs > DIAS_30) fs.rmSync(p);
    }
  } catch { /* nada que limpiar */ }
}

function main() {
  if (off()) return;
  const kind = process.argv[2];
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const t = Date.now();

  if (kind === 'sub') {
    const agent = String(input.agent_type || 'desconocido').replace(/^claudeop:/, '');
    append(Object.entries(usageByModel(input.agent_transcript_path)).map(([m, u]) => ({ t, s: input.session_id, k: 'sub', a: agent, m, ...u })));
  } else if (kind === 'main') {
    const now = usageByModel(input.transcript_path);
    const stateFile = path.join(DATA, `main-${String(input.session_id).replace(/[^\w-]/g, '')}.json`);
    const prev = readJson(stateFile, {});
    const rows = [];
    for (const [m, u] of Object.entries(now)) {
      const p = prev[m] || { i: 0, o: 0, r: 0, c: 0 };
      const reset = u.i < p.i || u.o < p.o; // el transcript se reinició (compactación, /clear)
      const d = reset ? u : { i: u.i - p.i, o: u.o - p.o, r: u.r - p.r, c: u.c - p.c };
      if (d.i + d.o + d.r + d.c > 0) rows.push({ t, s: input.session_id, k: 'main', a: 'principal', m, ...d });
    }
    append(rows);
    writeJson(stateFile, now);
    recordContext({ t, s: input.session_id, tok: contextTokens(input.transcript_path) });
    updateSession({ session_id: input.session_id, cwd: input.cwd, transcript_path: input.transcript_path }); // memoria entre sesiones

    // Cuánto ha tardado esta petición (de que el usuario la envía a que Claude termina): alimenta las estimaciones
    const sf = sessionFile(input.session_id);
    const st = readJson(sf);
    // Si aún hay subagentes en segundo plano, la petición no ha terminado: se cierra en el Stop que llegue después de su aviso
    const pending = Array.isArray(input.background_tasks) && input.background_tasks.length > 0;
    if (st && st.kind && st.t0 && !st.logged && !pending) {
      const sec = Math.round((t - st.t0) / 1000);
      if (sec >= 3 && sec <= 3 * 3600) recordDuration({ t, s: input.session_id, k: st.kind, sec }); // fuera lo instantáneo y lo que se quedó esperando horas
      writeJson(sf, { ...st, logged: true });
    }
    sweep();
  }
}

// Solo corre como hook, no al importarlo (los tests importan usageByModel)
if (process.argv[1] && path.basename(process.argv[1]) === 'track.mjs') {
  try { main(); } catch { /* un hook nunca debe romper la sesión */ }
}
