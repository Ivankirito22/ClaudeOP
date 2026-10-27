// Hook PreToolUse: dos protecciones reales (no solo texto en el prompt).
//  1) Pide confirmación antes de comandos que no se deshacen: git push, reset --hard, clean -f, branch -D, rm -rf de algo amplio.
//  2) Si el modelo principal lleva muchas lecturas/búsquedas seguidas en una petición, le recuerda que delegue en el explorador (Haiku).
// Desactivar: CLAUDEOP_GUARD=off (solo 1), CLAUDEOP=off (todo el plugin).
import fs from 'node:fs';
import path from 'node:path';
import { off, readJson, writeJson, sessionFile, readStdin } from './data.mjs';

const READS_BEFORE_NUDGE = 8;
const MAX_AGENTS = 6; // CLAUDEOP_MAX_AGENTS lo cambia
const BIG_READ_KB = 40; // ~10k tokens; CLAUDEOP_BIG_READ_KB lo cambia (0 = sin freno)
const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb|svg|mp[34]|wav|zip)$/i;

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
  const input = readStdin();
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
  if (st.prompt !== input.prompt_id) st = { ...st, prompt: input.prompt_id, reads: 0, agents: 0, nudged: false };

  // Cada subagente cuesta ~6k tokens solo por arrancar, más su trabajo y su informe: tope de arranques por petición
  if (tool === 'Agent' || tool === 'Task') {
    if (st.quiet) return;
    st.agents = (st.agents || 0) + 1;
    const max = Math.max(1, Number(process.env.CLAUDEOP_MAX_AGENTS) || MAX_AGENTS);
    if (st.agents > max) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `claudeop: ya hay ${max} subagentes en esta petición y cada uno gasta tokens del usuario. Usa lo que ya devolvieron; si falta algo, agrupa lo pendiente en UN agente (por área, no por archivo) o hazlo tú.` } }));
    }
    writeJson(file, st);
    return;
  }
  // Leer entero un archivo grande en el hilo principal: ese texto viaja en cada turno posterior. Se frena UNA vez por archivo y petición.
  if (tool === 'Read' && !st.quiet) {
    const ti = input.tool_input || {};
    const kb = Number(process.env.CLAUDEOP_BIG_READ_KB ?? BIG_READ_KB);
    if (kb > 0 && typeof ti.file_path === 'string' && ti.limit == null && ti.offset == null && !NOT_TEXT.test(ti.file_path) && !(st.bigOk || []).includes(ti.file_path)) {
      let size = 0;
      try { size = fs.statSync(ti.file_path).size; } catch { /* no existe: que lo diga Read */ }
      if (size > kb * 1024) {
        st.bigOk = [...(st.bigOk || []), ti.file_path].slice(-50);
        writeJson(file, st);
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `claudeop: ${path.basename(ti.file_path)} pesa ${Math.round(size / 1024)} KB y entero se reenviaría en cada turno. Usa Grep para ubicar lo que buscas y Read con offset/limit, o delega la lectura en claudeop:explorador. Si de verdad lo necesitas entero, vuelve a pedirlo.` } }));
        return;
      }
    }
  }
  if (st.quiet || st.nudged) return;
  st.reads += 1;
  if (st.reads >= READS_BEFORE_NUDGE) {
    st.nudged = true;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[claudeop] Llevas ${st.reads} lecturas tú solo en esta petición. Para seguir explorando, delega en el subagente claudeop:explorador (Haiku, más barato) con la pregunta concreta y trabaja con su resumen.` } }));
  }
  writeJson(file, st);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'guard.mjs') {
  try { main(); } catch { /* un hook nunca debe romper la sesión */ }
}
