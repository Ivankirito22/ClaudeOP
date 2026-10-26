// Lee el bloque ```requirements de REQUIREMENTS.md e instala los plugins que falten.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'REQUIREMENTS.md');

const block = /```requirements\r?\n([\s\S]*?)```/.exec(fs.readFileSync(FILE, 'utf8'));
if (!block) { console.error('REQUIREMENTS.md: falta el bloque ```requirements'); process.exit(1); }

const reqs = block[1].split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => { const [repo, plugin] = l.split(/\s+/); return { repo, plugin, name: plugin.split('@')[0] }; });

const claude = (args) => spawnSync(`claude plugin ${args}`, { shell: true, encoding: 'utf8' });

let installed = [];
try { installed = JSON.parse(claude('list --json').stdout || '[]').map((p) => String(p.id || p.name || '')); } catch { /* sin lista: se intenta instalar todo */ }
const has = (r) => installed.some((id) => id === r.plugin || id.split('@')[0] === r.name);

let fallos = 0;
for (const r of reqs) {
  if (has(r)) { console.log(`ya instalado  ${r.plugin}`); continue; }
  if (DRY) { console.log(`instalaría    ${r.plugin}  (claude plugin marketplace add ${r.repo})`); continue; }
  const add = claude(`marketplace add ${r.repo}`);
  const inst = add.status === 0 ? claude(`install ${r.plugin}`) : add;
  if (inst.status === 0) console.log(`instalado     ${r.plugin}`);
  else { fallos++; console.log(`FALLÓ         ${r.plugin}: ${(inst.stderr || inst.stdout || '').trim().split('\n').pop()}`); }
}
if (!DRY && reqs.length && fallos < reqs.length) console.log('\nReinicia Claude Code (o /reload-plugins) para que carguen.');
process.exit(fallos ? 1 : 0);
