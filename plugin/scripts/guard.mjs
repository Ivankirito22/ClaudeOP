// Hook PreToolUse: dos protecciones reales (no solo texto en el prompt).
//  1) Pide confirmación antes de comandos que no se deshacen: git push, reset --hard, clean -f, branch -D, rm -rf de algo amplio.
//  2) Si el modelo principal lleva muchas lecturas/búsquedas seguidas en una petición, le recuerda que delegue en el explorador (Haiku).
// Desactivar: CLAUDEOP_GUARD=off (solo 1), CLAUDEOP=off (todo el plugin).
import fs from 'node:fs';
import path from 'node:path';
import { off, readJson, writeJson, sessionFile } from './data.mjs';

const READS_BEFORE_NUDGE = 8;

// Devuelve el motivo si el comando es difícil de deshacer, o null
export function riskOf(command) {
  for (const seg of String(command || '').split(/[;&|\n]+/)) {
    const tok = seg.trim().split(/\s+/).filter(Boolean);
    const gi = tok.findIndex((t) => /^(.*[\\/])?git(\.exe)?$/i.test(t));
    if (gi >= 0) {
      let i = gi + 1;
      while (i < tok.length && tok[i].startsWith('-')) i += /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(tok[i]) ? 2 : 1;
      const sub = tok[i];
      const rest = tok.slice(i + 1);
      if (sub === 'push') return 'git push sube tu trabajo fuera de tu máquina';
      if (sub === 'reset' && rest.includes('--hard')) return 'git reset --hard descarta cambios sin commit';
      if (sub === 'clean' && rest.some((t) => /^-\w*f/.test(t) || t === '--force')) return 'git clean borra archivos sin seguimiento';
      if (sub === 'branch' && rest.includes('-D')) return 'git branch -D borra una rama aunque no esté fusionada';
    }
    if (tok[0] === 'rm' && tok.some((t) => /^-\w*[rR]/.test(t)) && tok.some((t) => /^-\w*f/.test(t) || t === '--force')
      && tok.slice(1).some((t) => /^(\/|~|\$HOME|\*|\.|\.\.)$/.test(t))) return 'rm -rf sobre una ruta muy amplia';
  }
  return null;
}

function main() {
  if (off()) return;
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const tool = input.tool_name;

  if (tool === 'Bash' || tool === 'PowerShell') {
    if (/^(off|0|false)$/i.test(process.env.CLAUDEOP_GUARD || '')) return;
    const why = riskOf(input.tool_input?.command);
    if (why) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `claudeop: ${why}. ¿Lo ejecuto?` } }));
    return;
  }

  // Lecturas del hilo principal (los subagentes traen agent_id y no cuentan)
  if (input.agent_id || !input.prompt_id) return;
  const file = sessionFile(input.session_id);
  let st = readJson(file, {});
  // Turno nuevo (o continuación tras un subagente): se reinician las lecturas, pero se conserva el cronómetro y el tipo de la petición
  if (st.prompt !== input.prompt_id) st = { ...st, prompt: input.prompt_id, reads: 0, nudged: false };
  if (st.quiet || st.nudged) return;
  st.reads += 1;
  if (st.reads >= READS_BEFORE_NUDGE) {
    st.nudged = true;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[claudeop] Llevas ${st.reads} lecturas/búsquedas tú solo en esta petición. Para seguir explorando, delega en el subagente claudeop:explorador (Haiku, más barato) con la pregunta concreta y trabaja con su resumen.` } }));
  }
  writeJson(file, st);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'guard.mjs') {
  try { main(); } catch { /* un hook nunca debe romper la sesión */ }
}
