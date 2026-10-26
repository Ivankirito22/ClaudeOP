// Diagnóstico de claudeop: comprueba que todo lo necesario está y que los hooks responden. No toca tu configuración.
//   node doctor.mjs            → informe
//   node doctor.mjs --notify   → además manda un aviso de prueba al sistema
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DATA, USAGE, readJson } from './data.mjs';
import { readRequirements, installedIds, isInstalled, readStamp } from './requirements.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
let fails = 0, warns = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const warn = (m) => { warns++; console.log(`  ⚠ ${m}`); };
const bad = (m) => { fails++; console.log(`  ✖ ${m}`); };
const hook = (script, input) => spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify(input), encoding: 'utf8', timeout: 20000, env: { ...process.env, CLAUDEOP_NO_INSTALL: '1' } });

console.log('claudeop · diagnóstico\n');

console.log('Requisitos');
const major = Number(process.versions.node.split('.')[0]);
major >= 18 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node}: hace falta 18 o superior (https://nodejs.org)`);
const ver = spawnSync('claude --version', { shell: true, encoding: 'utf8', timeout: 20000 });
ver.status === 0 ? ok(`Claude Code ${ver.stdout.trim()}`) : warn('No encuentro el comando «claude» en el PATH (el plugin funciona igual dentro de Claude Code, pero no podré comprobar los plugins recomendados)');
process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux' ? ok(`Sistema: ${process.platform}`) : warn(`Sistema sin probar: ${process.platform}`);

console.log('\nPlugin');
try {
  const manifest = readJson(path.join(ROOT, '.claude-plugin', 'plugin.json'), {});
  ok(`${manifest.name} v${manifest.version}`);
  const hooks = readJson(path.join(ROOT, 'hooks', 'hooks.json'), {}).hooks || {};
  const scripts = Object.values(hooks).flat().flatMap((g) => g.hooks.map((h) => /scripts\/([\w.-]+)/.exec(h.command)?.[1]));
  const missing = scripts.filter((s) => !s || !fs.existsSync(path.join(SCRIPTS, s)));
  missing.length ? bad(`Faltan scripts de hooks: ${missing.join(', ')}`) : ok(`${scripts.length} hooks en ${Object.keys(hooks).length} eventos, con sus scripts`);
  const agents = fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md'));
  agents.length === 12 ? ok('12 agentes') : warn(`${agents.length} agentes (se esperaban 12)`);
} catch (e) { bad(`No se pudo leer el plugin: ${e.message}`); }

console.log('\nHooks (se ejecutan de verdad con datos de prueba)');
const cwd = process.cwd();
const s = hook('session-start.mjs', { cwd, source: 'startup' });
const sessionText = s.status === 0 && s.stdout ? JSON.parse(s.stdout).hookSpecificOutput?.additionalContext : null;
sessionText ? ok(`SessionStart responde (~${Math.round(sessionText.length / 3.6)} tokens)`) : bad(`SessionStart no responde: ${(s.stderr || '').trim().split('\n')[0]}`);
const r = hook('route.mjs', { cwd, prompt: 'arregla el bug del login y añade tests', prompt_id: 'doctor', session_id: 'doctor' });
r.status === 0 && /⏱/.test(r.stdout) ? ok('UserPromptSubmit reconoce una tarea y añade el ⏱ estimado') : bad(`UserPromptSubmit no responde como se espera: ${(r.stderr || r.stdout || '').trim().slice(0, 120)}`);
const g = hook('guard.mjs', { tool_name: 'Bash', tool_input: { command: 'git push' }, session_id: 'doctor', prompt_id: 'doctor' });
/"ask"/.test(g.stdout) ? ok('PreToolUse pide confirmación para «git push»') : bad('PreToolUse no pide confirmación para «git push»');

console.log('\nRequisitos recomendados (se instalan solos al abrir una sesión nueva)');
if (/^(1|true|on)$/i.test(process.env.CLAUDEOP_NO_INSTALL || '')) warn('CLAUDEOP_NO_INSTALL está activo: no se instalarán solos');
const ids = ver.status === 0 ? installedIds() : null;
const stamp = readStamp();
for (const q of readRequirements()) {
  if (ids && isInstalled(ids, q)) ok(`${q.name}: instalado`);
  else if (stamp[q.plugin]?.ok) warn(`${q.name}: no está instalado (lo quitaste; no se reinstalará solo)`);
  else if ((stamp[q.plugin]?.tries || 0) >= 3) bad(`${q.name}: falló 3 veces; mira ${path.join(DATA, 'bootstrap.log')} o ejecuta node scripts/install-requirements.mjs`);
  else warn(`${q.name}: aún no instalado (se instalará solo al abrir Claude Code; reinicia después)`);
}

console.log('\nDatos y avisos');
try { fs.mkdirSync(DATA, { recursive: true }); fs.accessSync(DATA, fs.constants.W_OK); ok(`Carpeta de datos escribible (${DATA})`); } catch { bad(`No puedo escribir en ${DATA}`); }
try { const n = fs.readFileSync(USAGE, 'utf8').split('\n').filter(Boolean).length; ok(`${n} registros de uso (ejecuta stats.mjs para verlos)`); } catch { ok('Aún sin registros de uso (se crean solos al terminar la primera respuesta)'); }
if (process.argv.includes('--notify')) {
  const n = spawnSync(process.execPath, [path.join(SCRIPTS, 'notify.mjs'), 'test'], { encoding: 'utf8' });
  console.log(`  ${n.stdout.trim()}`);
} else console.log('  · Para probar los avisos del sistema: node scripts/notify.mjs test');
if (/^(off|0|false)$/i.test(process.env.CLAUDEOP || '')) warn('CLAUDEOP=off: el plugin está apagado');

console.log(`\n${fails ? `✖ ${fails} problema${fails > 1 ? 's' : ''}` : '✔ Todo correcto'}${warns ? ` · ${warns} aviso${warns > 1 ? 's' : ''}` : ''}`);
process.exit(fails ? 1 : 0);
