// Instala los plugins de REQUIREMENTS.md que falten.
//   node install-requirements.mjs                 → instala los que falten
//   node install-requirements.mjs --dry-run       → solo muestra qué haría
//   node install-requirements.mjs --optional      → incluye también los opcionales
//   node install-requirements.mjs --only a,b      → solo esos (lo usa el arranque automático, que además anota el resultado)
import { readRequirements, installedIds, isInstalled, installOne, readStamp, writeStamp } from './requirements.mjs';

const DRY = process.argv.includes('--dry-run');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? process.argv[onlyArg + 1].split(',') : null;

const all = [...readRequirements(), ...(process.argv.includes('--optional') ? readRequirements('optional') : [])];
const reqs = all.filter((r) => !ONLY || ONLY.includes(r.plugin));
const ids = installedIds() || [];

let fallos = 0;
for (const r of reqs) {
  if (isInstalled(ids, r)) { console.log(`ya instalado  ${r.plugin}`); continue; }
  if (DRY) { console.log(`instalaría    ${r.plugin}  (claude plugin marketplace add ${r.repo})`); continue; }
  const res = installOne(r);
  if (ONLY) { const s = readStamp(); s[r.plugin] = { ...s[r.plugin], ok: res.ok }; writeStamp(s); }
  if (res.ok) console.log(`instalado     ${r.plugin}`);
  else { fallos++; console.log(`FALLÓ         ${r.plugin}: ${res.msg}`); }
}
if (!DRY && reqs.length && fallos < reqs.length) console.log('\nReinicia Claude Code (o /reload-plugins) para que carguen.');
process.exit(fallos ? 1 : 0);
