#!/usr/bin/env node
// Guardia de claude-router (hook PreToolUse de Claude Code): impide que Claude SOBRESCRIBA con «Write» un archivo que ya existía.
// - Archivos nuevos: se permiten (y se apuntan, para poder reescribirlos en la misma tarea).
// - Archivos que ya existían: se bloquean, salvo los de claude-router, los que tú aprobaste o los vacíos.
// - Cada bloqueo se apunta para que cla te pregunte (botones Permitir / Denegar).
// Si algo falla aquí, se deja pasar: el guardia nunca debe romper una tarea.
import fs from 'node:fs';
import path from 'node:path';

export function decide(ev, dir) {
  if (!ev || ev.tool_name !== 'Write') return { allow: true };
  const fp = ev.tool_input && ev.tool_input.file_path;
  if (!fp) return { allow: true };
  const abs = path.resolve(ev.cwd || process.cwd(), fp);
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
  const norm = (p) => path.resolve(p).toLowerCase();
  let st;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (!st) {
    const created = readJson('created.json', []);
    created.push(abs);
    try { fs.writeFileSync(path.join(dir, 'created.json'), JSON.stringify(created)); } catch { /* nada */ }
    return { allow: true };
  }
  if (!st.isFile() || st.size === 0) return { allow: true };
  if (readJson('created.json', []).some((p) => norm(p) === norm(abs))) return { allow: true };
  if (readJson('allow.json', []).some((p) => norm(p) === norm(abs))) return { allow: true };
  try {
    const head = fs.readFileSync(abs, 'utf8').slice(0, 600);
    if (head.includes('claude-router')) return { allow: true }; // archivos que generó el propio router (contexto, lecciones)
  } catch { /* binario: se bloquea igual */ }
  try { fs.appendFileSync(path.join(dir, 'asks.jsonl'), JSON.stringify({ path: abs, ts: Date.now() }) + '\n'); } catch { /* nada */ }
  return {
    allow: false,
    reason: `claude-router bloquea sobrescribir ${path.basename(abs)} porque ya existía. Usa Edit para cambiar solo lo necesario. Si de verdad hace falta reescribirlo entero, dile al usuario que pulse «Permitir» (ya se le ha avisado) y repítelo en la siguiente instrucción.`,
  };
}

if (import.meta.url === new URL(process.argv[1], 'file:///').href || process.argv[1]?.endsWith('guard.mjs')) {
  let raw = '';
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    try {
      const dir = process.env.CR_GUARD_DIR;
      if (!dir) process.exit(0);
      const r = decide(JSON.parse(raw), dir);
      if (!r.allow) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason } }));
      }
    } catch { /* ante la duda, dejar pasar */ }
    process.exit(0);
  });
}
