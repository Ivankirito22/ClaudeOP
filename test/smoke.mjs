// Pruebas del núcleo con un `claude` falso: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-test-'));
process.env.CR_CLAUDE_BIN = `${process.execPath} ${path.join(here, 'fake-claude.mjs')}`;
process.env.CR_STATE_FILE = path.join(tmpHome, 'state.json');
process.env.CR_HISTORY_FILE = path.join(tmpHome, 'history.jsonl');
process.env.CR_NO_UPDATE_CHECK = '1';
process.env.CR_CKPT_MAX_FILE_MB = '1'; // topes pequeños para poder probar las protecciones
process.env.CR_CKPT_MAX_TOTAL_MB = '3';

const core = await import('../src/core.mjs');
const rules = await import('../src/rules.mjs');
const config = await import('../src/config.mjs');
const gitx = await import('../src/git.mjs');
const history = await import('../src/history.mjs');
const { detectStack } = await import('../src/stack.mjs');
const { TaskQueue } = await import('../src/queue.mjs');
const { ACTIONS } = await import('../src/actions.mjs');
const { spawnSync } = await import('node:child_process');
const docsm = await import('../src/docs.mjs');
const { Session, authStatus, buildAgents, buildPolicy, augmentPrompt, isQuick, MODELS, effectiveVerify, DEFAULT_ALLOW } = core;

const settings = { userName: 'Frivan', compactAt: 150000, maxBudget: null, checkpoints: false, remindEvery: 0 };
const s = new Session({ cwd: process.cwd(), settings });
assert.equal(s.settings, settings, 'los ajustes se comparten por referencia (así /nombre y /presupuesto llegan a Claude)');
const seen = { active: [], delegate: [], text: [], tool: [], result: [], route: [], compacted: [] };
s.on('active', (e) => seen.active.push(e.tier + (e.agent ? ':' + e.agent : '')));
s.on('delegate', (e) => seen.delegate.push(e));
s.on('text', (e) => seen.text.push(e));
s.on('tool', (e) => seen.tool.push(e));
const ends = [];
s.on('tool-end', (e) => ends.push(e));
s.on('result', (e) => seen.result.push(e));
s.on('route', (e) => seen.route.push(e));
s.on('compacted', (e) => seen.compacted.push(e));
s.on('failure', (m) => assert.fail('failure: ' + m));
const clear = () => { seen.text.length = 0; seen.result.length = 0; seen.route.length = 0; };

// 1) instrucción normal: delegación entre modelos
await s.run('optimiza el proyecto');
assert.equal(s.sessionId, 'sess-1');
assert.deepEqual(seen.active, ['sonnet', 'haiku:limpiador', 'haiku:limpiador', 'sonnet']);
assert.equal(seen.delegate[0].agentType, 'limpiador');
assert.equal(seen.delegate[0].expectedTier, 'haiku');
assert.equal(seen.tool.find((t) => t.name === 'Edit').agent, 'limpiador');
// pasos con id, instrucción completa y fin (para la interfaz: modelo + instrucción + tiempo)
const bash = seen.tool.find((t) => t.name === 'Bash');
assert.equal(bash.id, 'tb1');
assert.equal(bash.full, 'npm test -- --reporter=dot');
assert.equal(seen.delegate[0].id, 'tu1');
assert.ok(seen.delegate[0].full.includes('Borra los imports sin usar'), 'el detalle de la delegación lleva la instrucción');
assert.deepEqual(ends.map((e) => e.id).sort(), ['tb1', 'tu1', 'tu2'], 'cada paso avisa cuando termina');
assert.equal(seen.result[0].cost, 0.0123);
const firstRun = seen.result[0].run;
assert.ok(rules.startsWithName(seen.result[0].text, 'Frivan'));

// 2) flags pasados a claude
const argsText = seen.text[0].text;
for (const f of ['-p', '--agents', '--append-system-prompt-file', '--forward-subagent-text', '--system-prompt-snapshot off',
  '--append-subagent-system-prompt-file', '--exclude-dynamic-system-prompt-sections', '--output-format stream-json', `--model ${MODELS.sonnet}`]) {
  assert.ok(argsText.includes(f), 'falta flag: ' + f);
}
assert.ok(!argsText.includes('--resume') && !argsText.includes('--max-budget-usd'));

// 3) estadísticas por modelo, caché y coste
const st = s.stats;
assert.equal(st.tiers.haiku.msgs, 2);
assert.equal(st.tiers.sonnet.msgs, 2);
assert.equal(st.tiers.opus.msgs, 0);
assert.equal(st.tiers.haiku.out, 15);
assert.ok(st.cacheRatio > 0 && st.cacheRatio < 1);
assert.equal(st.ctx, 120);

// 4) segunda instrucción reanuda la sesión
clear();
await s.run('otra cosa');
assert.ok(seen.text[0].text.includes('--resume sess-1'));

// 5) subagentes: 7 integrados + personalizados, política coherente
const agents = buildAgents({ blender: { description: 'Blender helper', prompt: 'bpy', model: 'sonnet', tools: ['Read'] }, malo: { description: 'x' } });
assert.deepEqual(Object.keys(agents).sort(), ['arquitecto', 'blender', 'depurador', 'documentador', 'explorador', 'investigador', 'limpiador', 'probador', 'revisor', 'verificador']);
assert.equal(agents.depurador.model, MODELS.sonnet);
assert.equal(agents.verificador.model, MODELS.sonnet);
assert.equal(agents.blender.model, MODELS.sonnet);
assert.equal(agents.limpiador.model, MODELS.haiku);
assert.equal(agents.arquitecto.model, MODELS.opus);
const policy = buildPolicy('eco', 'Frivan', agents);
assert.ok(policy.includes('START EVERY reply') && policy.includes('"Frivan,"') && policy.includes('ECONOMY') && policy.includes('- blender (sonnet)'));
const written = JSON.parse(fs.readFileSync(s.agentsFile, 'utf8'));
assert.equal(Object.keys(written).length, 9);

// 6) perfil calidad => principal Opus; perfil eco + pregunta rápida => Haiku
s.profile = 'quality';
clear();
await s.run('x');
assert.ok(seen.text[0].text.includes(`--model ${MODELS.opus}`));
s.profile = 'eco';
clear();
await s.run('¿qué hace main.js?');
assert.ok(seen.text[0].text.includes(`--model ${MODELS.haiku}`));
assert.equal(seen.route[0].main, 'haiku');
clear();
await s.run('arregla el bug del login');
assert.ok(seen.text[0].text.includes(`--model ${MODELS.sonnet}`));
clear();
await s.run('hola', { main: 'opus' });
assert.ok(seen.text[0].text.includes(`--model ${MODELS.opus}`));
s.profile = 'balanced';
assert.ok(isQuick('cómo se llama esta función?') && !isQuick('crea una función nueva') && !isQuick('qué hago\nlinea2'));

// 7) compactación propia: resumen silencioso con Haiku + arranque limpio con el resumen
const textsBefore = seen.text.length;
const resultsBefore = seen.result.length;
const summary = await s.compact();
assert.ok(summary.startsWith('Resumen: objetivo X'));
assert.equal(seen.text.length, textsBefore, 'compactar no debe pintar texto');
assert.equal(seen.result.length, resultsBefore, 'compactar no debe emitir result');
assert.equal(s.sessionId, null);
assert.equal(s.compactions, 1);
assert.equal(seen.compacted[0].chars, summary.length);
clear();
await s.run('sigue con lo mío');
assert.ok(!seen.text[0].text.includes('--resume'));
assert.ok(seen.text[0].text.includes('Contexto de la conversación anterior'));
assert.ok(seen.text[0].text.includes('Resumen: objetivo X'));
assert.ok(seen.text[0].text.includes('Recordatorio de reglas'));
assert.ok(seen.route[0].notes.includes('contexto resumido') && seen.route[0].notes.includes('reglas reforzadas'));
assert.ok(s.totalCost > 0.0123, 'el coste acumula entre sesiones');

// 8) escalado al decir que algo sigue fallando + presupuesto
const aug = augmentPrompt('sigue fallando el login', { name: 'Frivan' });
assert.ok(aug.text.includes('consulta a arquitecto') && aug.notes.includes('escalado a arquitecto'));
assert.equal(augmentPrompt('hola', {}).notes.length, 0);
s.settings.maxBudget = 2;
clear();
await s.run('presupuesto');
assert.ok(seen.text[0].text.includes('--max-budget-usd 2'));

// 9) reglas en CLAUDE.md: idempotente y respetuoso con tu contenido
const proj = fs.mkdtempSync(path.join(tmpHome, 'proj-'));
assert.equal(rules.hasRules(proj), false);
let r = rules.installRules(proj, 'Frivan');
assert.equal(r.action, 'creado');
assert.equal(rules.hasRules(proj), true);
assert.equal(rules.installRules(proj, 'Frivan').changed, false);
fs.appendFileSync(path.join(proj, 'CLAUDE.md'), '\n## Mis notas\nno tocar\n');
r = rules.installRules(proj, 'Iván');
assert.equal(r.action, 'actualizado');
const md = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8');
assert.ok(md.includes('"Iván,"') && !md.includes('"Frivan,"') && md.includes('no tocar'));
assert.equal(md.split('claude-router:start').length - 1, 1);
const proj2 = fs.mkdtempSync(path.join(tmpHome, 'proj-'));
fs.writeFileSync(path.join(proj2, 'CLAUDE.md'), '# Mi proyecto\nhola\n');
assert.equal(rules.installRules(proj2, 'Frivan').action, 'añadido al final');
assert.ok(fs.readFileSync(path.join(proj2, 'CLAUDE.md'), 'utf8').startsWith('# Mi proyecto'));

// 10) detector de deriva
for (const [t, ok] of [['Frivan, hola', true], ['**Frivan**: ok', true], ['frivan hola', true], ['"Frivan," vale', true],
  ['Hola Frivan', false], ['Frivanx dice', false], ['', false]]) {
  assert.equal(rules.startsWithName(t, 'Frivan'), ok, `startsWithName(${JSON.stringify(t)})`);
}
const d = new rules.DriftTracker('Frivan');
assert.equal(d.record('Frivan, ok').level, 0);
assert.equal(d.record('sin nombre').level, 1);
assert.equal(d.record('sin nombre otra vez').level, 2);
assert.equal(d.record('Frivan, ya').level, 0);
d.record('x'); d.reset();
assert.equal(d.level, 0);

// 11) ajustes guardados y personalización
assert.equal(config.loadSettings().userName, 'Frivan');
config.saveSettings({ ...config.loadSettings(), userName: 'Iván', maxBudget: 3 });
assert.equal(config.loadSettings().userName, 'Iván');
assert.equal(config.loadSettings().maxBudget, 3);
config.setProject('/x', { sessionId: 'abc' });
assert.equal(config.getProject('/x').sessionId, 'abc');
fs.writeFileSync(path.join(proj, '.claude-router.json'), JSON.stringify({
  actions: [{ label: 'Optimizar escena Blender', prompt: 'optimiza la escena' }, { label: 'Pregunta', prefill: 'Sobre el juego: ' }],
  agents: { blender: { description: 'bpy', prompt: 'p', model: 'sonnet' } },
}));
const cu = config.loadCustom(proj);
assert.equal(cu.actions.length, 2);
assert.equal(cu.actions[0].cmd, '/optimizar-escena-blender');
assert.equal(cu.actions[1].input, true);
assert.ok(cu.agents.blender);

// 11b) cancelar una tarea en curso (Ctrl+X)
process.env.FAKE_SLOW = '5';
let cancelled = 0;
s.on('cancelled', () => cancelled++);
const t0 = Date.now();
const pending = s.run('tarea lenta');
await new Promise((r) => setTimeout(r, 400));
assert.equal(s.busy, true);
assert.equal(s.cancel(), true);
await pending;
assert.equal(cancelled, 1);
assert.equal(s.busy, false);
assert.ok(Date.now() - t0 < 3000, 'cancelar debe cortar la espera');
delete process.env.FAKE_SLOW;
assert.equal(s.cancel(), false);

// 11c) métricas por instrucción: delegación, ediciones y coste
const r1 = firstRun;
assert.equal(r1.delegations, 1);
assert.deepEqual(r1.delegList, ['limpiador']);
assert.equal(r1.subEdits, 1);
assert.equal(r1.mainEdits, 0);
assert.equal(r1.out.haiku, 15);
assert.equal(r1.out.sonnet, 35);
assert.ok(Math.abs(r1.delegated - 15 / 50) < 1e-9, 'delegado = salida de subagentes / salida total');
assert.equal(r1.cost, 0.0123);
{
  const sd = new Session({ cwd: process.cwd(), settings: { userName: 'Frivan', checkpoints: false, remindEvery: 0 } });
  sd.on('failure', (m) => assert.fail(m));
  await sd.run('SOLOEDIT haz cosas');
  assert.equal(sd.lastRun.mainEdits, 5);
  assert.equal(sd.lastRun.delegations, 0);
  assert.equal(sd.lastRun.delegated, 0);
  await sd.run('FALLA esto');
  assert.equal(sd.lastRun.ok, false);
}

// 11d) permisos: lista permitida, bloqueo de push y reglas propias
{
  const args = (await (async () => { clear(); await s.run('args'); return seen.text[0].text; })());
  assert.ok(args.includes('--allowedTools') && args.includes('Bash(git diff:*)') && args.includes('Bash(npm test:*)'));
  assert.ok(args.includes('--disallowedTools') && args.includes('Bash(git push:*)'));
  s.extraAllow = ['Bash(blender:*)'];
  s.settings.blockPush = false;
  clear();
  await s.run('args2');
  assert.ok(seen.text[0].text.includes('Bash(blender:*)'));
  assert.ok(!seen.text[0].text.includes('--disallowedTools'));
  s.settings.blockPush = true;
  s.extraAllow = [];
  assert.ok(DEFAULT_ALLOW.includes('WebSearch'));
}

// 11e) recordatorio periódico de reglas (previene la deriva en vez de solo detectarla)
{
  const sp = new Session({ cwd: process.cwd(), settings: { userName: 'Frivan', checkpoints: false, remindEvery: 2 } });
  const routes = [];
  sp.on('route', (e) => routes.push(e.notes.join(',')));
  sp.on('failure', (m) => assert.fail(m));
  await sp.run('uno');
  await sp.run('dos');
  await sp.run('tres');
  assert.ok(!routes[0].includes('periódico'));
  assert.ok(routes[1].includes('recordatorio periódico'), 'a la 2ª instrucción con sesión abierta se recuerda');
  assert.ok(!routes[2].includes('periódico'));
}

// 11f) política: paralelismo, verificación, lecciones, stack y seguridad
{
  const ag = buildAgents({});
  const pol = buildPolicy('balanced', 'Frivan', ag, { verify: 'auto', lessons: true, stack: 'React · TypeScript', blockPush: true });
  for (const k of ['Parallelism', 'verificador', 'Project stack: React · TypeScript', 'Lessons', '.claude/lecciones.md', 'git push', 'depurador', 'done" criterion']) assert.ok(pol.includes(k), 'falta en la política: ' + k);
  const pol2 = buildPolicy('quality', 'Frivan', ag, { verify: 'auto', lessons: false, blockPush: false });
  assert.ok(pol2.includes('ALWAYS finish by delegating to verificador') && !pol2.includes('Lessons:') && !pol2.includes('Safety:'));
  assert.ok(buildPolicy('eco', 'Frivan', ag, { verify: 'auto' }).includes('economy mode'));
  assert.equal(effectiveVerify('auto', 'quality'), 'siempre');
  assert.equal(effectiveVerify('auto', 'eco'), 'nunca');
  assert.equal(effectiveVerify('nunca', 'quality'), 'nunca');
  const withSpec = buildPolicy('balanced', 'Frivan', buildAgents({ frontend: { description: 'fe', prompt: 'p', model: 'sonnet' } }));
  assert.ok(withSpec.includes('Specialists loaded ONLY for this request'));
  assert.ok(!pol.includes('Specialists loaded ONLY'), 'sin especialistas no se menciona');
  assert.ok(augmentPrompt('rediseña la arquitectura del login', {}).notes.includes('plan con arquitecto'));
  assert.ok(!augmentPrompt('arregla el color del botón', {}).notes.includes('plan con arquitecto'));
}

// 11g) detección de stack: solo se activan los especialistas que encajan
{
  const mk = (files) => {
    const d = fs.mkdtempSync(path.join(tmpHome, 'stk-'));
    for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
    return d;
  };
  const a = detectStack(mk({ 'package.json': JSON.stringify({ dependencies: { react: '^18', express: '^4' }, devDependencies: { typescript: '^5' } }) }));
  assert.deepEqual(a.tags.sort(), ['backend', 'frontend', 'node', 'ts']);
  assert.deepEqual(a.hints.sort(), ['backend', 'frontend', 'node']);
  assert.deepEqual(a.agents, {}, 'los especialistas ya no van siempre activos');
  assert.ok(a.summary.includes('Frontend') && a.summary.includes('TypeScript'));
  assert.ok(detectStack(mk({ 'tools/export.py': 'import bpy\nprint(1)\n' })).tags.includes('blender'));
  assert.ok(detectStack(mk({ 'scene.blend': 'x' })).tags.includes('blender'));
  assert.ok(detectStack(mk({ 'pom.xml': '<project/>' })).tags.includes('java'));
  assert.ok(detectStack(mk({ 'project.godot': 'x' })).tags.includes('juego'));
  const none = detectStack(mk({ 'README.md': 'hola' }));
  assert.deepEqual(none.hints, []);
  // por extensión: lenguajes sin archivo de proyecto
  assert.ok(detectStack(mk({ 'a.py': 'x=1', 'b.py': 'y=2' })).hints.includes('python'));
  assert.ok(detectStack(mk({ 'src/a.cpp': 'int main(){}', 'src/b.hpp': '' })).hints.includes('cpp'));
  assert.ok(detectStack(mk({ 'Assets/A.cs': 'class A{}', 'Assets/B.cs': 'class B{}' })).hints.includes('csharp'));
  assert.ok(detectStack(mk({ 'index.html': '<p/>', 'style.css': 'a{}', 'x.css': 'b{}' })).hints.includes('web'));
  // sesión: sin especialistas por defecto; solo aparecen los que se piden en ESA instrucción
  const ss = new Session({ cwd: process.cwd(), settings: { userName: 'Frivan', checkpoints: false }, stack: a });
  assert.ok(!('frontend' in ss.agents) && !('python' in ss.agents), 'sin especialistas hasta que se llaman');
  ss.activeSpecialists = ['python', 'cpp'];
  assert.ok('python' in ss.agents && 'cpp' in ss.agents && !('blender' in ss.agents));
  assert.ok(ss.agents.python.prompt && !('kw' in ss.agents.python) && !('tag' in ss.agents.python));
}

// 11g2) especialistas bajo demanda: catálogo, detección por texto, plan con checks
{
  const { SPECIALISTS, SPEC_KEYS, specialistsFor } = await import('../src/stack.mjs');
  for (const k of ['python', 'cpp', 'csharp', 'java', 'node', 'web', 'frontend', 'backend', 'sql', 'blender', 'juego', 'go', 'rust', 'php', 'mobile', 'shell']) assert.ok(SPECIALISTS[k], 'falta especialista ' + k);
  assert.ok(SPEC_KEYS.length >= 15);
  const t = (txt) => specialistsFor(txt);
  assert.ok(t('arréglame este script de Python').includes('python'));
  assert.ok(t('crea una clase en C++ con CMake').includes('cpp'));
  assert.ok(t('un script en C# para Unity').includes('csharp'));
  assert.ok(t('mejora el CSS del header').includes('web'));
  assert.ok(t('endpoint en Express con node').includes('node'));
  assert.ok(t('modela un barril en Blender con bpy').includes('blender'));
  assert.ok(t('una consulta SQL en postgres').includes('sql'));
  assert.ok(!t('optimiza javascript').includes('java'), 'javascript no es java');
  assert.deepEqual(t('hola qué tal'), []);

  const { newPlan, planItems, togglePlan, resolvePlan, skipNote, visibleSteps } = await import('../src/plan.mjs');
  const fa = [{ cmd: '/feature', label: 'Feature completa' }, { cmd: '/optimizar', label: 'Optimizar proyecto' }];
  const plan = newPlan({ flows: fa, specs: ['python', 'inventado'], text: 'x' });
  let it = planItems(plan);
  assert.ok(it.every((i) => i.on), 'todo marcado al principio');
  assert.deepEqual(it.filter((i) => i.kind === 'spec').map((i) => i.id), ['spec:python']);
  assert.ok(it.some((i) => i.id === 'step:planificar') && it.some((i) => i.id === 'step:mecanico'));
  assert.ok(togglePlan(plan, 'step:planificar') && togglePlan(plan, 'spec:python') && !togglePlan(plan, 'step:noexiste'));
  let r = resolvePlan(plan);
  assert.deepEqual(r.flows.map((f) => f.cmd), ['/feature', '/optimizar']);
  assert.deepEqual(r.specs, []);
  assert.deepEqual(r.skipped.map((x) => x.id), ['planificar']);
  assert.ok(skipNote(r.skipped).includes('NO los hagas') && skipNote(r.skipped).includes('arquitecto'));
  assert.equal(skipNote([]), '');
  // desmarcar un flujo entero quita sus pasos propios (los compartidos se quedan)
  togglePlan(plan, 'flow:/feature');
  const ids = visibleSteps(plan).map((x) => x.id);
  assert.ok(!ids.includes('implementar') && !ids.includes('documentar') && ids.includes('mecanico') && ids.includes('probar'));
  assert.deepEqual(resolvePlan(plan).flows.map((f) => f.cmd), ['/optimizar']);
}

// 11h) git: foto antes de cada instrucción, ver cambios, deshacer/rehacer varias veces
{
  const repo = fs.mkdtempSync(path.join(tmpHome, 'repo-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };
  w('a.txt', 'uno\n'); w('src/b.js', 'b\n'); w('node_modules/x/i.js', 'dep');
  assert.equal(gitx.isRepo(repo), true);
  assert.equal(gitx.isRepo(tmpHome), false);
  const sg = new Session({ cwd: repo, settings: { userName: 'Frivan', remindEvery: 0 } });
  const ck = [];
  sg.on('checkpoint', (c) => ck.push(c && c.created));
  sg.on('failure', (m) => assert.fail(m));
  await sg.run('tarea uno', { label: 'Tarea uno' });
  w('a.txt', 'dos\n'); fs.rmSync(path.join(repo, 'src/b.js')); w('nuevo/c.txt', 'c\n'); // "Claude trabaja"
  const ch = gitx.changes(repo);
  assert.equal(ch.ok && !ch.empty, true);
  assert.ok(ch.stat.includes('a.txt') && ch.diff.includes('+dos') && ch.from === 'Tarea uno');
  await sg.run('tarea dos', { label: 'Tarea dos' });
  w('a.txt', 'tres\n');
  await sg.run('sin cambios', { label: 'Nada' });
  assert.deepEqual(ck, [true, true, true]);
  let u = gitx.undo(repo); // "Nada" no cambió nada: se salta; vuelve a antes de "Tarea dos"
  assert.ok(u.ok);
  assert.equal(u.label, 'Tarea dos');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'dos\n');
  u = gitx.undo(repo);
  assert.ok(u.ok);
  assert.equal(u.label, 'Tarea uno');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'uno\n');
  assert.ok(fs.existsSync(path.join(repo, 'src/b.js')), 'archivo borrado vuelve');
  assert.ok(!fs.existsSync(path.join(repo, 'nuevo')), 'archivo nuevo desaparece (y su carpeta vacía)');
  assert.ok(fs.existsSync(path.join(repo, 'node_modules/x/i.js')), 'node_modules no se toca');
  assert.equal(gitx.undo(repo).ok, false, 'no retrocede más allá de la primera foto');
  assert.ok(gitx.redo(repo).ok);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'dos\n');
  assert.ok(gitx.redo(repo).ok);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'tres\n');
  assert.equal(gitx.redo(repo).ok, false);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: repo }).status !== 0, true, 'no crea commits en tu rama');
  // sin git: la instrucción funciona igual y avisa con null
  const sn = new Session({ cwd: tmpHome, settings: { userName: 'Frivan', remindEvery: 0 } });
  let nogit = 'no-evento';
  sn.on('checkpoint', (c) => { nogit = c; });
  sn.on('failure', (m) => assert.fail(m));
  await sn.run('hola');
  assert.equal(nogit, null);
}

// 11h2) git: protecciones — archivos grandes, carpeta enorme y repo que contiene otras carpetas
{
  const mkRepo = () => { const d = fs.mkdtempSync(path.join(tmpHome, 'repo-')); spawnSync('git', ['init', '-q'], { cwd: d }); return d; };
  const put = (d, f, t) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
  // a) archivo grande: no entra en la foto y deshacer ni lo borra ni falla
  const r1 = mkRepo();
  put(r1, 'a.txt', 'uno\n');
  put(r1, 'assets/grande.bin', Buffer.alloc(1.5 * 1024 * 1024, 1));
  const c1 = gitx.checkpoint(r1, 'antes: t1');
  assert.equal(c1.created, true);
  put(r1, 'a.txt', 'dos\n');
  put(r1, 'assets/otro-grande.bin', Buffer.alloc(1.2 * 1024 * 1024, 2));
  gitx.checkpoint(r1, 'antes: t2');
  put(r1, 'a.txt', 'tres\n');
  assert.ok(gitx.undo(r1).ok);
  assert.equal(fs.readFileSync(path.join(r1, 'a.txt'), 'utf8'), 'dos\n');
  assert.ok(fs.existsSync(path.join(r1, 'assets/grande.bin')) && fs.existsSync(path.join(r1, 'assets/otro-grande.bin')), 'los archivos grandes no se tocan');
  // b) carpeta enorme (suma > tope): sin foto, con aviso, y undo/cambios lo explican
  const r2 = mkRepo();
  for (let i = 0; i < 4; i++) put(r2, `d/f${i}.bin`, Buffer.alloc(0.9 * 1024 * 1024, i));
  const c2 = gitx.checkpoint(r2, 'antes: x');
  assert.equal(c2.created, false);
  assert.equal(c2.skipped, 'grande');
  assert.ok(gitx.undo(r2).error.includes('demasiado grande'));
  assert.ok(gitx.changes(r2).error.includes('demasiado grande'));
  // c) sesión dentro de una subcarpeta: nunca toca lo de fuera
  const r3 = mkRepo();
  put(r3, 'fuera.txt', 'original\n');
  put(r3, 'app/x.txt', 'x1\n');
  const app = path.join(r3, 'app');
  gitx.checkpoint(app, 'antes: sub');
  put(app, 'x.txt', 'x2\n');
  put(app, 'nuevo.txt', 'n\n');
  put(r3, 'fuera.txt', 'editado por mí\n');
  put(r3, 'fuera-nuevo.txt', 'mío\n');
  const u3 = gitx.undo(app);
  assert.ok(u3.ok);
  assert.equal(fs.readFileSync(path.join(app, 'x.txt'), 'utf8'), 'x1\n');
  assert.ok(!fs.existsSync(path.join(app, 'nuevo.txt')));
  assert.equal(fs.readFileSync(path.join(r3, 'fuera.txt'), 'utf8'), 'editado por mí\n', 'lo de fuera de la carpeta no se revierte');
  assert.ok(fs.existsSync(path.join(r3, 'fuera-nuevo.txt')), 'lo de fuera no se borra');
}

// 11i) cola de tareas: orden, persistencia, tope de gasto y parada ante errores
{
  const saves = [];
  const mkSession = () => {
    const x = new Session({ cwd: process.cwd(), settings: { userName: 'Frivan', checkpoints: false, remindEvery: 0 } });
    x.on('failure', (m) => assert.fail(m));
    return x;
  };
  const q = new TaskQueue([], (items) => saves.push(items.length));
  q.add('primera', { label: 'Uno' }); q.add('segunda'); q.add('   ');
  assert.equal(q.items.length, 2);
  assert.equal(q.remove(9), null);
  const order = [];
  const res = await q.runAll(mkSession(), { before: (it) => order.push(it.text), after: () => {} });
  assert.deepEqual(order, ['primera', 'segunda']);
  assert.equal(res.done, 2);
  assert.equal(res.remaining, 0);
  assert.ok(saves.length >= 4, 'la cola se guarda en cada cambio');
  const q2 = new TaskQueue([{ text: 'a' }, { text: 'FALLA b' }, { text: 'c' }]);
  const res2 = await q2.runAll(mkSession());
  assert.equal(res2.done, 1);
  assert.equal(res2.remaining, 2);
  assert.ok(res2.stopReason, 'se para al primer error');
  const q3 = new TaskQueue([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  const res3 = await q3.runAll(mkSession(), { limitUsd: 0.005 });
  assert.equal(res3.done, 1);
  assert.ok(res3.stopReason.includes('tope'));
  assert.equal(q3.clear(), 2);
}

// 11j) historial e informe
{
  const base = { cwd: '/x/proyecto', cost: 0.2, out: { haiku: 10, sonnet: 80, opus: 10 }, delegated: 0.1 };
  for (let i = 0; i < 6; i++) history.record({ ...base, label: 'Limpiar', ms: 1000 });
  history.record({ ...base, label: null, cost: 0.5, error: true });
  const tc = history.typicalCost('Limpiar');
  assert.ok(Math.abs(tc.cost - 0.2) < 1e-9 && tc.n === 6);
  assert.equal(history.typicalCost('NoExiste'), null);
  const sm = history.summarize(history.load({ days: 7 }));
  assert.equal(sm.runs, 7);
  assert.ok(Math.abs(sm.cost - 1.7) < 1e-9);
  assert.equal(sm.errors, 1);
  assert.ok(sm.tips.some((t) => t.includes('delega muy poco')), 'avisa si Sonnet delega <15%');
  assert.equal(history.load({ days: 7, cwd: '/otro' }).length, 0);
  // tiempo aproximado: mediana de lo parecido; sin datos → null; general solo con 3+ tareas largas
  const e1 = history.estimateMs('Limpiar');
  assert.deepEqual([e1.ms, e1.n, e1.basis], [1000, 6, 'similares']);
  assert.equal(history.estimateMs('Tarea rara'), null, 'con tareas cortas no se inventa un tiempo general');
  for (const ms of [40000, 60000, 90000]) history.record({ ...base, label: 'Otra', ms });
  assert.deepEqual([history.estimateMs('Otra').ms, history.estimateMs('Otra').basis], [60000, 'similares']);
  const g = history.estimateMs('Nunca vista');
  assert.ok(g && g.basis === 'general' && g.ms === 60000 && g.n === 3);
  history.record({ ...base, label: 'Limpiar', ms: 99999999, error: true });
  assert.equal(history.estimateMs('Limpiar').ms, 1000, 'las que fallaron no cuentan');
}

// 11k) lecciones y reglas con import
{
  const pl = fs.mkdtempSync(path.join(tmpHome, 'les-'));
  const r0 = rules.installRules(pl, 'Frivan');
  assert.equal(r0.lessonsCreated, true);
  assert.ok(fs.readFileSync(path.join(pl, 'CLAUDE.md'), 'utf8').includes('@.claude/lecciones.md'));
  assert.equal(rules.lessonsInfo(pl).count, 0);
  fs.appendFileSync(path.join(pl, '.claude', 'lecciones.md'), 'El login falla si falta .env\nNo usar fs.sync en el render\n');
  assert.equal(rules.lessonsInfo(pl).count, 2);
  assert.equal(rules.installRules(pl, 'Frivan').lessonsCreated, false, 'no pisa tus lecciones');
  assert.equal(rules.lessonsInfo(pl).count, 2);
  const pn = fs.mkdtempSync(path.join(tmpHome, 'les-'));
  rules.installRules(pn, 'Frivan', { lessons: false });
  assert.ok(!fs.readFileSync(path.join(pn, 'CLAUDE.md'), 'utf8').includes('lecciones'));
}

// 11l) acciones y flujos: bien formados
{
  const cmds = ACTIONS.map((a) => a.cmd);
  assert.equal(new Set(cmds).size, cmds.length, 'comandos únicos');
  for (const a of ACTIONS) {
    assert.ok(a.label.length <= 26, 'etiqueta demasiado larga para la barra: ' + a.label);
    assert.ok(a.prompt || a.input, 'acción sin prompt ni caja: ' + a.cmd);
  }
  const flows = ACTIONS.filter((a) => a.group === 'FLUJOS');
  assert.ok(flows.length >= 7);
  for (const f of flows) {
    const text = f.wrap ? f.wrap('PETICION-X') : f.prompt;
    assert.ok(text.includes('FLUJO'), f.cmd);
    assert.ok(/paralelo|PARALELO/.test(text) || f.cmd === '/decidir' || f.cmd === '/bugprofundo' || f.cmd === '/refactor', f.cmd + ' debería paralelizar');
    if (f.wrap) assert.ok(text.includes('PETICION-X'), f.cmd + ' envuelve lo que escribes');
  }
  const feat = ACTIONS.find((a) => a.cmd === '/feature').wrap('X');
  for (const ag of ['explorador', 'investigador', 'arquitecto', 'probador', 'revisor', 'documentador', 'verificador']) assert.ok(feat.includes(ag), 'Feature completa usa ' + ag);
  const known = new Set(Object.keys(buildAgents({})));
  for (const f of flows) {
    const text = f.wrap ? f.wrap('x') : f.prompt;
    for (const m of text.matchAll(/\b(explorador|limpiador|probador|documentador|investigador|revisor|depurador|verificador|arquitecto)\b/g)) assert.ok(known.has(m[1]));
  }
}

// 11m) personalización: permisos propios desde .claude-router.json
{
  const pc = fs.mkdtempSync(path.join(tmpHome, 'cus-'));
  fs.writeFileSync(path.join(pc, '.claude-router.json'), JSON.stringify({ allow: ['Bash(blender:*)', 5], agents: {} }));
  assert.deepEqual(config.loadCustom(pc).allow, ['Bash(blender:*)']);
}

// 11n) contexto de MDs: escaneo, índice, resumen y lectura inicial barata
{
  const proj = fs.mkdtempSync(path.join(tmpHome, 'docs-'));
  const put = (f, t) => { fs.mkdirSync(path.dirname(path.join(proj, f)), { recursive: true }); fs.writeFileSync(path.join(proj, f), t); };
  put('README.md', '# Mi Juego\nUn roguelike en Blender.\n');
  put('CLAUDE.md', '# Reglas\n');
  put('docs/arquitectura.md', '# Arquitectura\nCapas...\n');
  put('docs/guia/niveles.md', 'Cómo se diseñan niveles\n');
  put('node_modules/x/README.md', '# dependencia\n');
  put('.claude/lecciones.md', '# lecciones\nuna\n');
  put('.claude/notas.md', '# Notas de Claude\n');
  put('a/b/c/d/profundo.md', '# demasiado hondo\n');
  put('notas.txt', 'no es md');
  put('vacio.md', '');
  put('package.json', '{}');
  put('.env.example', 'API_URL=');
  const found = docsm.scanDocs(proj);
  assert.deepEqual(found.map((d) => d.rel), ['CLAUDE.md', 'README.md', 'docs/arquitectura.md', 'docs/guia/niveles.md', '.claude/notas.md']);
  assert.equal(found[1].title, 'Mi Juego');
  assert.equal(found[3].title, 'Cómo se diseñan niveles');
  assert.ok(!found.some((d) => /node_modules|lecciones|profundo|vacio/.test(d.rel)));
  assert.deepEqual(docsm.contextFiles(proj), ['package.json', '.env.example']);
  const idx = docsm.docsIndex(found);
  assert.ok(idx.includes('- README.md — Mi Juego') && idx.includes('docs/arquitectura.md — Arquitectura'));
  assert.ok(docsm.docsIndex(Array.from({ length: 30 }, (_, i) => ({ rel: `m${i}.md`, title: '', size: 10 }))).includes('… y 5 más'));
  assert.equal(docsm.readable(found).length, 4, 'CLAUDE.md no se resume');

  // estado del resumen
  assert.equal(docsm.digestState(proj, found).exists, false);
  // un contexto.md TUYO (no generado por claude-router) no se toca: se usa otro nombre
  put(docsm.CONTEXT_REL, '# Mi contexto personal\n');
  assert.equal(docsm.digestState(proj, found).exists, false);
  assert.equal(docsm.contextRel(proj), path.join('.claude', 'contexto-router.md'));
  assert.ok(docsm.contextPrompt(found, [], docsm.contextRel(proj)).includes('contexto-router.md'));
  {
    const rules = await import('../src/rules.mjs');
    const lp = path.join(proj, rules.LESSONS_REL);
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, '- mis notas propias\n');
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Mi CLAUDE\nregla mía\n');
    const r = rules.installRules(proj, 'Frivan', { lessons: true, context: true });
    assert.equal(fs.readFileSync(lp, 'utf8'), '- mis notas propias\n', 'no pisa tus lecciones.md');
    assert.ok(fs.existsSync(path.join(proj, '.claude', 'lecciones-router.md')), 'crea lecciones-router.md aparte');
    const md = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8');
    assert.ok(md.startsWith('# Mi CLAUDE\nregla mía') && md.includes('lecciones-router.md') && md.includes('contexto-router.md') && md.includes('NUNCA sobrescribas'));
    assert.equal(fs.readFileSync(path.join(proj, 'CLAUDE.md.bak-router'), 'utf8'), '# Mi CLAUDE\nregla mía\n', 'copia de seguridad de tu CLAUDE.md');
    assert.ok(r.backup);
    fs.rmSync(lp); fs.rmSync(path.join(proj, '.claude', 'lecciones-router.md'));
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Mi CLAUDE\nregla mía\n'); fs.rmSync(path.join(proj, 'CLAUDE.md.bak-router'));
  }
  fs.rmSync(path.join(proj, docsm.CONTEXT_REL));
  put(docsm.CONTEXT_REL, '<!-- generado por claude-router 2026-01-01 -->\n# Contexto\n');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(proj, docsm.CONTEXT_REL), future, future);
  assert.equal(docsm.digestState(proj, found).fresh, true);
  const later = new Date(Date.now() + 20000);
  fs.utimesSync(path.join(proj, 'CLAUDE.md'), later, later);
  assert.equal(docsm.digestState(proj, docsm.scanDocs(proj)).fresh, true, 'tocar CLAUDE.md no invalida el resumen');
  fs.utimesSync(path.join(proj, 'README.md'), later, later);
  const st2 = docsm.digestState(proj, docsm.scanDocs(proj));
  assert.equal(st2.stale, true, 'si cambia un MD, el resumen está desactualizado');

  // prompt de contexto
  const cp = docsm.contextPrompt(found, docsm.contextFiles(proj));
  assert.ok(cp.includes('README.md') && cp.includes('docs/arquitectura.md') && !cp.includes('- CLAUDE.md'));
  assert.ok(cp.includes('NUNCA leas .env') && cp.includes('.claude/contexto.md') && cp.includes('PARALELO') && cp.includes('explorador'));

  // Session: índice en la política + lectura inicial solo al empezar sesión y sin resumen al día
  const mk = (extra = {}) => { const x = new Session({ cwd: proj, settings: { userName: 'Frivan', checkpoints: false, remindEvery: 0, ...extra } }); x.docs = docsm.scanDocs(proj); x.on('failure', (m) => assert.fail(m)); return x; };
  const sd = mk();
  const rts = [], txts = [];
  sd.on('route', (e) => rts.push(e.notes.join(',')));
  sd.on('text', (e) => txts.push(e.text));
  await sd.run('arregla el login');                     // sesión nueva + resumen desactualizado
  assert.ok(rts[0].includes('leyendo los MDs del proyecto'));
  assert.ok(txts[0].includes('(Router) Primera instrucción') && txts[0].includes('explorador') && txts[0].includes('README.md'));
  const pol = fs.readFileSync(sd.policyFile, 'utf8');
  assert.ok(pol.includes('Project documentation') && pol.includes('README.md — Mi Juego') && pol.includes('documentador'));
  await sd.run('otra');                                  // ya hay sesión: no se repite
  assert.ok(!rts[1].includes('MDs'));
  fs.utimesSync(path.join(proj, docsm.CONTEXT_REL), new Date(Date.now() + 60000), new Date(Date.now() + 60000));
  const rt2 = [];
  const fresh = mk(); fresh.on('route', (e) => rt2.push(e.notes.join(',')));
  await fresh.run('con resumen al día');
  assert.ok(!rt2[0].includes('MDs'), 'con el resumen al día no se releen los MDs');
  const off = mk({ contextDocs: false });
  const rt3 = [];
  off.on('route', (e) => rt3.push(e.notes.join(',')));
  await off.run('sin contexto');
  assert.ok(!rt3[0].includes('MDs') && !fs.readFileSync(off.policyFile, 'utf8').includes('Project documentation'));
  // solo CLAUDE.md: nada que leer
  const solo = fs.mkdtempSync(path.join(tmpHome, 'docs-'));
  fs.writeFileSync(path.join(solo, 'CLAUDE.md'), '# x\n');
  const ss = new Session({ cwd: solo, settings: { userName: 'Frivan', checkpoints: false, remindEvery: 0 } });
  ss.docs = docsm.scanDocs(solo);
  const rt4 = [];
  ss.on('route', (e) => rt4.push(e.notes.join(',')));
  await ss.run('hola');
  assert.ok(!rt4[0].includes('MDs'));
  // tras compactar (hay resumen de conversación) tampoco se relee
  // reglas: import del resumen y regla de mantener los MDs al día
  const blk = rules.rulesBlock('Frivan');
  assert.ok(blk.includes('@.claude/contexto.md') && blk.includes('actualízalo en la misma tarea'));
  assert.ok(!rules.rulesBlock('Frivan', { context: false }).includes('contexto.md'));
}

// 13) actualizaciones: versiones, aviso desde GitHub (servidor local) y ejecución del comando de actualizar
{
  process.env.CR_NO_UPDATE_CHECK = '';
  const upd = await import('../src/update.mjs');
  assert.ok(upd.isNewer('0.4.1', '0.4.0') && upd.isNewer('1.0.0', '0.9.9') && !upd.isNewer('0.4.0', '0.4.0') && !upd.isNewer('0.3.9', '0.4.0'));
  assert.match(upd.currentVersion(), /^\d+\.\d+\.\d+$/);
  const http = await import('node:http');
  const srv = http.createServer((q, r) => { r.end(JSON.stringify({ version: '99.0.0' })); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  process.env.CR_UPDATE_URL = `http://127.0.0.1:${srv.address().port}/package.json`;
  const u1 = await upd.checkUpdate({ force: true });
  assert.deepEqual(u1, { latest: '99.0.0', newer: true });
  srv.close();
  const u2 = await upd.checkUpdate(); // ahora sale de la caché del día aunque el servidor ya no exista
  assert.equal(u2.latest, '99.0.0');
  process.env.CR_UPDATE_URL = 'http://127.0.0.1:1/nada';
  assert.equal(await upd.checkUpdate({ force: true }), null, 'sin red no molesta ni lanza');
  process.env.CR_NO_UPDATE_CHECK = '1';
  const lines = [];
  process.env.CR_UPDATE_CMD = 'echo actualizando';
  const r1 = await upd.runUpdate((l) => lines.push(l));
  assert.ok(r1.ok && lines.join(' ').includes('actualizando'));
  process.env.CR_UPDATE_CMD = 'exit 3';
  const r2 = await upd.runUpdate();
  assert.ok(!r2.ok && /código 3/.test(r2.error));
  delete process.env.CR_UPDATE_CMD;
}

// 13b) reconocer flujos en texto libre y componer bandeja + texto
{
  const it = await import('../src/intent.mjs');
  const d = (t) => it.detectCmds(t).join(' ');
  assert.equal(d('oye, optimiza el código'), '/optimizar');
  assert.equal(d('créame un modelo de esto y optimízalo'), '/feature /optimizar');
  assert.equal(d('optimiza el rendimiento del menú'), '/rendimiento');
  assert.equal(d('arregla el login que falla'), '/bugprofundo');
  assert.equal(d('añade tests al inventario del juego por favor'), '/tests');
  assert.equal(d('limpia el código muerto y optimiza'), '/optimizar');
  assert.equal(d('¿qué hace este módulo?'), '', 'una pregunta no dispara flujos');
  assert.equal(d('haz un botón rojo'), '', 'un cambio pequeño no dispara un flujo grande');
  assert.equal(d('prepara la release'), '/release');
  const byCmd = Object.fromEntries(ACTIONS.map((a) => [a.cmd, a]));
  assert.ok(Object.keys(it.PATTERNS).every((c) => byCmd[c]), 'cada patrón apunta a una acción que existe');
  const one = it.composePrompt([byCmd['/optimizar']], '');
  assert.equal(one, byCmd['/optimizar'].prompt);
  assert.ok(it.composePrompt([byCmd['/optimizar']], 'y el menú').includes('Petición concreta del usuario'));
  assert.ok(it.composePrompt([byCmd['/feature']], 'un menú').includes('FLUJO «Feature completa». Petición: un menú'));
  const two = it.composePrompt([byCmd['/feature'], byCmd['/revisar']], 'un menú');
  assert.ok(two.startsWith('PETICIÓN DEL USUARIO') && two.includes('### Flujo 1: Feature completa') && two.includes('### Flujo 2: Revisión de código') && two.includes('UN solo verificador'));
  assert.ok(it.rank('/feature') < it.rank('/revisar') && it.rank('/revisar') < it.rank('/release'));
  const pol = core.buildPolicy('balanced', 'Frivan');
  assert.ok(pol.includes('Known workflows') && pol.includes('Optimizar proyecto'), 'la política lleva el catálogo de flujos');
}

// 13c) enrutador: Haiku (falso) elige flujos, método general, cambio pequeño, y si Haiku falla → palabras clave
{
  const it = await import('../src/intent.mjs');
  assert.deepEqual(it.parseRouter('ruido {"kind":"tarea","flows":["/optimizar","/nada"]} fin', ['/optimizar', '/feature']), { kind: 'tarea', cmds: ['/optimizar'], techs: [] });
  assert.deepEqual(it.parseRouter('{"kind":"tarea","flows":[],"tech":["Python","cpp","inventado","rust","go","php"]}', []).techs, ['python', 'cpp', 'rust'], 'tech: solo claves válidas, máx. 3');
  assert.equal(it.parseRouter('no es json', ['/optimizar']), null);
  assert.equal(it.parseRouter('{"kind":"otra"}', ['/optimizar']), null);
  const { createApp } = await import('../src/app.mjs');
  const dir = fs.mkdtempSync(path.join(tmpHome, 'route-'));
  process.env.FAKE_ECHO = '1';
  const drive = async (text, { plan = false } = {}) => {
    const logs = [];
    const app = createApp(dir, { log: (t) => logs.push(String(t)), setInput() {}, focusInput() {}, changed() {}, quit() {}, shortcuts: '' });
    if (!plan) app.handle('/plan off');
    app.handle(text);
    for (let i = 0; i < 100 && !logs.some((l) => l.includes('terminado')); i++) await new Promise((r) => setTimeout(r, 100));
    app.dispose();
    return logs.join('\n');
  };
  let o = await drive('créame un modelo de enemigo y optimisalo');
  assert.ok(o.includes('Haiku leyó tu petición y usa Feature completa + Optimizar proyecto') && o.includes('### Flujo 2: Optimizar proyecto'), 'Haiku entiende la frase con faltas');
  o = await drive('planifica la economía del juego con precios dinámicos');
  assert.ok(o.includes('método general') && o.includes('MÉTODO GENERAL'), 'sin flujo pero con trabajo: método general');
  o = await drive('cambia el color del botón a rojo');
  assert.ok(o.includes('cambio pequeño') && !o.includes('FLUJO') && !o.includes('MÉTODO GENERAL'));
  o = await drive('!créame un modelo');
  assert.ok(!o.includes('Haiku') && !o.includes('FLUJO'), '«!» va literal');
  process.env.FAKE_ROUTER_FAIL = '1';
  o = await drive('optimiza el código del enemigo');
  assert.ok(o.includes('No pude consultar a Haiku') && o.includes('Reconozco lo que pides') && o.includes('Optimizar proyecto'), 'sin Haiku: palabras clave');
  delete process.env.FAKE_ROUTER_FAIL;

  // Especialistas bajo demanda: Haiku dice qué tecnologías toca la frase y SOLO esas se cargan en la instrucción
  o = await drive('créame un script en python y optimízalo');
  assert.ok(o.includes('Especialistas para esta tarea: Python'), 'aparece el de Python');
  assert.ok(o.includes('--agents'), 'el fake devuelve los args');
  o = await drive('mejora el css y el html del menú de la web con pantalla nueva');
  assert.ok(o.includes('Especialistas para esta tarea: HTML/CSS'));
  assert.ok(!o.includes('Python'), 'los demás no aparecen');

  // Plan previo con checks: aparece, se desmarca, se ejecuta solo lo marcado
  const mk = () => {
    const logs = [];
    const app = createApp(dir, { log: (t) => logs.push(String(t)), setInput() {}, focusInput() {}, changed() {}, quit() {}, shortcuts: '' });
    return { logs, app, all: () => logs.join('\n') };
  };
  const until = async (fn) => { for (let i = 0; i < 120 && !fn(); i++) await new Promise((r) => setTimeout(r, 100)); };
  {
    const { logs, app, all } = mk();
    app.handle('/plan on');
    app.handle('créame un script en python y optimízalo');
    await until(() => app.snapshot().plan);
    let sn = app.snapshot();
    assert.ok(sn.plan && sn.plan.items.every((i) => i.on), 'plan con todo marcado');
    assert.ok(sn.plan.items.some((i) => i.id === 'flow:/feature') && sn.plan.items.some((i) => i.id === 'spec:python') && sn.plan.items.some((i) => i.id === 'step:planificar'));
    assert.ok(all().includes('Plan') && all().includes('☑'), 'también se pinta en la terminal');
    assert.ok(!logs.some((l) => l.includes('MÉTODO') || l.includes('### Flujo')), 'todavía no se ha enviado nada a Claude');
    // la terminal: números desmarcan, Enter ejecuta
    const idx = sn.plan.items.findIndex((i) => i.id === 'step:planificar') + 1;
    app.handle(String(idx));
    assert.equal(app.snapshot().plan.items.find((i) => i.id === 'step:planificar').on, false);
    assert.ok(app.planToggle('spec:python') && app.snapshot().plan.items.find((i) => i.id === 'spec:python').on === false);
    assert.ok(app.planToggle('spec:python'));
    process.env.FAKE_ECHO = '1';
    app.handle('');
    await until(() => all().includes('terminado'));
    const out = all();
    assert.ok(out.includes('Plan confirmado') && out.includes('sin: Plan / decisiones difíciles'), 'resumen del plan');
    assert.ok(out.includes('AJUSTES DEL USUARIO SOBRE EL PLAN') && out.includes('NO los hagas') && out.includes('arquitecto'), 'lo desmarcado llega a Claude');
    assert.ok(out.includes('### Flujo 1: Feature completa') && out.includes('### Flujo 2: Optimizar proyecto'));
    assert.ok(out.includes('Especialistas para esta tarea: Python'));
    assert.equal(app.snapshot().plan, null, 'el plan se cierra al ejecutar');
    app.dispose();
  }
  {
    const { app, all } = mk();
    app.handle('/plan on');
    app.handle('créame un script en python');
    await until(() => app.snapshot().plan);
    app.handle('x');
    assert.equal(app.snapshot().plan, null);
    assert.ok(all().includes('Plan cancelado') && !all().includes('terminado'), 'cancelar no ejecuta nada');
    // preguntas y cambios pequeños no piden plan
    const before = all().length;
    app.handle('¿qué hace este módulo de python?');
    await until(() => all().includes('terminado'));
    assert.ok(!all().slice(before).includes('☑') && app.snapshot().plan === null, 'sin plan para preguntas');
    app.dispose();
  }
  {
    const { app, all } = mk();
    app.handle('/plan off');
    app.handle('créame un script en python');
    await until(() => all().includes('terminado'));
    assert.equal(app.snapshot().plan, null);
    assert.ok(app.snapshot().planPreview === false);
    app.handle('/plan on');
    app.dispose();
  }
  delete process.env.FAKE_ECHO;
}

// 13d) feedback inmediato, consulta rápida a Haiku y cola «a continuación»
{
  const { createApp } = await import('../src/app.mjs');
  const dir = fs.mkdtempSync(path.join(tmpHome, 'queue-'));
  const mk = () => {
    const logs = [];
    const app = createApp(dir, { log: (t) => logs.push(String(t)), setInput() {}, focusInput() {}, changed() {}, quit() {}, shortcuts: '' });
    return { logs, app, all: () => logs.join('\n'), n: (needle) => logs.join('\n').split(needle).length - 1 };
  };
  const until = async (fn, ms = 12000) => { for (let i = 0; i < ms / 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); return fn(); };
  process.env.FAKE_STEP_MS = '500';

  // consulta rápida: flags de velocidad; si la versión no los conoce, se reintenta y se acuerda
  const flagsLog = path.join(tmpHome, 'router-flags.log');
  process.env.FAKE_ROUTER_LOG = flagsLog;
  {
    const { app, all, n } = mk();
    app.handle('/plan off');
    app.handle('créame un script en python y optimízalo');
    await until(() => n('terminado') >= 1);
    const l = fs.readFileSync(flagsLog, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    assert.equal(l.length, 1);
    for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--system-prompt', '--tools']) assert.ok(l[0].includes(f), 'consulta rápida: falta ' + f);
    assert.ok(all().includes('Creando el plan'), 'sale «creando el plan» enseguida');
    app.dispose();
  }
  fs.rmSync(flagsLog, { force: true });
  process.env.FAKE_NO_FAST = '1';
  {
    const { app, all, n } = mk();
    app.handle('/plan off');
    app.handle('créame un script en python y optimízalo');
    await until(() => n('terminado') >= 1);
    assert.ok(all().includes('Haiku leyó tu petición'), 'con el reintento Haiku sigue funcionando');
    assert.ok(!all().includes('No pude consultar a Haiku'));
    await until(() => !app.session.busy);
    app.handle('créame un modelo de enemigo y optimízalo');
    await until(() => n('terminado') >= 2);
    const l = fs.readFileSync(flagsLog, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    assert.equal(l.length, 3, '1ª vez: rápida + reintento; 2ª vez: solo la básica');
    assert.ok(!l[1].includes('--strict-mcp-config') && !l[2].includes('--strict-mcp-config'));
    app.dispose();
  }
  delete process.env.FAKE_NO_FAST; delete process.env.FAKE_ROUTER_LOG;

  // «saltar»: no esperar a Haiku (que tarda) y seguir con palabras clave, sin avisos de error
  process.env.FAKE_ROUTER_MS = '4000';
  {
    const { app, all, n } = mk();
    app.handle('/plan off');
    const t0 = Date.now();
    app.handle('créame un script en python y optimízalo por favor');
    await until(() => app.snapshot().routing);
    const sn = app.snapshot();
    assert.ok(sn.routing && sn.routing.start > 0, 'mientras Haiku piensa, el estado dice que está creando el plan');
    app.skipRouting();
    await until(() => n('terminado') >= 1);
    assert.ok(Date.now() - t0 < 3800, 'no esperó a Haiku');
    assert.ok(all().includes('Reconozco lo que pides') && !all().includes('No pude consultar a Haiku'));
    app.dispose();
  }
  delete process.env.FAKE_ROUTER_MS;

  // guardia de archivos: no sobrescribe lo que existía; pregunta; avisa; permite solo la tarea siguiente
  {
    const { createApp } = await import('../src/app.mjs');
    const gdir = fs.mkdtempSync(path.join(tmpHome, 'guard-'));
    const mine = path.join(gdir, 'mio.md');
    fs.writeFileSync(mine, 'MIO ORIGINAL\n');
    const logs = []; const notes = [];
    const app = createApp(gdir, { log: (t) => logs.push(String(t)), setInput() {}, focusInput() {}, changed() {}, quit() {}, shortcuts: '', notify: (x) => notes.push(x) });
    const all = () => logs.join('\n');
    app.handle('/plan off');
    app.handle('SOBREESCRIBE mio.md ahora');
    await until(() => app.snapshot().perm);
    assert.equal(fs.readFileSync(mine, 'utf8'), 'MIO ORIGINAL\n', 'el archivo existente no se tocó');
    assert.ok(all().includes('lo he bloqueado') && all().includes('mio.md'));
    assert.ok(notes.some((x) => x.kind === 'ask'), 'avisa con notificación de que necesita tu permiso');
    assert.equal(app.snapshot().perm.files[0].rel, 'mio.md');
    await until(() => !app.session.busy);
    app.permAllow();
    await until(() => fs.readFileSync(mine, 'utf8') !== 'MIO ORIGINAL\n', 15000);
    assert.equal(fs.readFileSync(mine, 'utf8'), 'reescrito por Claude\n', 'con permiso sí se reescribe');
    await until(() => !app.session.busy);
    assert.ok(!fs.existsSync(path.join(app.session.guardDir, 'allow.json')), 'el permiso vale solo para esa tarea');
    // nuevo archivo + denegar
    fs.writeFileSync(mine, 'OTRA VEZ MIO\n');
    app.handle('SOBREESCRIBE mio.md otra vez');
    await until(() => app.snapshot().perm);
    app.permDeny();
    assert.equal(app.snapshot().perm, null);
    await until(() => !app.session.busy);
    assert.equal(fs.readFileSync(mine, 'utf8'), 'OTRA VEZ MIO\n');
    assert.ok(app.session.buildArgs('sonnet').includes('--settings'), 'el hook del guardia se pasa a Claude');
    // sin protección, pasa
    app.handle('/proteger off');
    app.handle('SOBREESCRIBE mio.md sin guardia');
    await until(() => fs.readFileSync(mine, 'utf8') === 'reescrito por Claude\n', 15000);
    assert.equal(app.snapshot().guard, false);
    app.dispose();
    // archivo nuevo: siempre pasa; archivos de claude-router también
    const gd2 = fs.mkdtempSync(path.join(tmpHome, 'guard2-'));
    const gmod = await import('../src/guard.mjs');
    fs.mkdirSync(path.join(gd2, 'g'));
    assert.equal(gmod.decide({ tool_name: 'Write', cwd: gd2, tool_input: { file_path: 'nuevo.txt' } }, path.join(gd2, 'g')).allow, true);
    fs.writeFileSync(path.join(gd2, 'ctx.md'), '<!-- generado por claude-router -->\n');
    assert.equal(gmod.decide({ tool_name: 'Write', cwd: gd2, tool_input: { file_path: 'ctx.md' } }, path.join(gd2, 'g')).allow, true, 'sus propios archivos sí');
    assert.equal(gmod.decide({ tool_name: 'Edit', cwd: gd2, tool_input: { file_path: 'ctx.md' } }, path.join(gd2, 'g')).allow, true, 'Edit nunca se bloquea');
    const { notifyOS } = await import('../src/notify.mjs');
    const calls = [];
    const fakeSp = (f, a, o) => { calls.push({ f, a, o }); return { on() {}, unref() {} }; };
    notifyOS('Hola', 'Cuerpo', { spawnFn: fakeSp, platform: 'win32' });
    assert.equal(calls[0].f, 'powershell.exe');
    assert.ok(calls[0].o.env.CR_NT === 'Hola' && !calls[0].a.join(' ').includes('Cuerpo'), 'el texto va por entorno, no en el script');
  }

  // MCP y plugins desde cla (Blender, Godot…)
  {
    const mcpLog = path.join(tmpHome, 'mcp.log');
    process.env.FAKE_MCP_LOG = mcpLog; process.env.CR_NO_BIN_CHECK = '1';
    const { app, all, n } = mk();
    app.handle('/mcp-instalar blender');
    await until(() => all().includes('instalado'));
    app.handle('/mcp-instalar godot C:\\Godot\\godot.exe');
    await until(() => n('instalado') >= 2);
    app.handle('/mcp-añadir docs npx -y @upstash/context7-mcp');
    await until(() => n('instalado') >= 3);
    await new Promise((r) => setTimeout(r, 600));
    const calls = fs.readFileSync(mcpLog, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    if (!calls.some((c) => c.includes('docs'))) console.error(JSON.stringify(calls), all());
    const flat = calls.map((c) => c.join(' '));
    assert.ok(flat.some((c) => c.startsWith('mcp add --scope user blender -- ') && c.includes('uvx blender-mcp')), 'blender vía uvx, para todos los proyectos');
    assert.ok(flat.some((c) => c.includes('-e GODOT_PATH=C:\\Godot\\godot.exe godot --') && c.includes('@coding-solo/godot-mcp')), 'godot con su ruta');
    assert.ok(flat.some((c) => c.includes('mcp add --scope user docs -- ') && c.includes('@upstash/context7-mcp')), 'MCP propio');
    const allow = app.session.extraAllow;
    assert.ok(allow.includes('mcp__blender') && allow.includes('mcp__godot') && allow.includes('mcp__docs'), 'permite solo sus herramientas MCP');
    assert.ok(all().includes('addon'), 'explica el paso que falta en Blender');
    app.handle('/mcp-añadir mal nombre'); // dos tokens: nombre + comando = válido; probamos nombre malo
    app.handle('/mcp-añadir ma$l npx x');
    await until(() => all().includes('solo puede llevar'));
    app.handle('/mcp-quitar blender');
    await until(() => all().includes('quitado'));
    assert.ok(!app.session.extraAllow.includes('mcp__blender'));
    app.handle('/mcp'); await until(() => all().includes('MCP instalados'));
    app.handle('/plugin-instalar foo@bar'); await until(() => all().includes('Plugin instalado'));
    assert.ok(fs.readFileSync(mcpLog, 'utf8').includes('"plugin","install","foo@bar"'));
    process.env.FAKE_MCP_FAIL = '1';
    app.handle('/mcp-instalar blender'); await until(() => all().includes('No se pudo instalar'));
    delete process.env.FAKE_MCP_FAIL; delete process.env.FAKE_MCP_LOG; delete process.env.CR_NO_BIN_CHECK;
    // etiquetas ⓘ y el menú de MCP
    const grp = app.snapshot().menu || [];
    app.dispose();
  }

  // compactación automática: pasa del límite -> compacta y la cola sigue después, en orden
  {
    const { app, all, n } = mk();
    app.handle('/plan off');
    app.handle('/compactar-en 20');
    assert.ok(all().includes('Compactación automática a partir de'), '/compactar-en cambia el umbral');
    app.session.settings.compactAt = 100; // el fake gasta unos cientos de tokens: pasa seguro
    app.handle('créame un script en python');
    await until(() => app.session.busy);
    app.handle('documenta el proyecto entero');
    await until(() => n('terminado') >= 2, 25000);
    await until(() => !app.session.busy && !app.snapshot().next.length);
    const t = all();
    assert.ok(t.includes('Compactando el contexto'), 'avisa de que compacta');
    assert.ok(t.includes('Contexto compactado'), 'y de que terminó');
    assert.ok(t.indexOf('Contexto compactado') < t.indexOf('De la cola'), 'la cola espera a la compactación');
    app.dispose();
  }

  // cola «a continuación»: lo que escribes mientras trabaja se prepara y empieza solo, en orden
  {
    const { app, all, n } = mk();
    app.handle('/plan off');
    app.handle('créame un script en python');
    await until(() => app.session.busy);
    app.handle('optimiza el código del enemigo porfa');
    app.handle('documenta el proyecto entero');
    await until(() => app.snapshot().next.length === 2);
    const sn = app.snapshot();
    assert.ok(all().includes('Hay una tarea en marcha') && all().includes('A continuación (#1)') && all().includes('A continuación (#2)'));
    assert.ok(sn.next[0].label.includes('Optimizar') && sn.next[1].text.includes('documenta'));
    assert.ok(app.nextUp(sn.next[1].id), 'se puede subir una');
    assert.ok(app.snapshot().next[0].text.includes('documenta'));
    await until(() => n('terminado') >= 3, 20000);
    assert.equal(n('terminado'), 3, 'las tres terminan solas, una detrás de otra');
    const t = all();
    const iDoc = t.indexOf('De la cola · Método general: documenta'), iOpt = t.indexOf('De la cola · Optimizar proyecto: optimiza');
    assert.ok(iDoc > -1 && iOpt > -1 && iDoc < iOpt, 'respeta el orden que dejaste');
    assert.equal(app.snapshot().next.length, 0);
    app.dispose();
  }
  // quitar y vaciar; pausa al cancelar y «seguir»
  {
    const { app, all, n } = mk();
    app.handle('/plan off');
    app.handle('créame un script en python');
    await until(() => app.session.busy);
    app.handle('optimiza el código del enemigo porfa');
    app.handle('documenta el proyecto entero');
    await until(() => app.snapshot().next.length === 2);
    assert.ok(app.nextRemove(app.snapshot().next[1].id) && app.snapshot().next.length === 1);
    assert.ok(!app.nextRemove(9999));
    app.cancel();
    await until(() => app.snapshot().nextPaused);
    assert.ok(app.snapshot().nextPaused && !app.session.busy, 'al cancelar la tarea, la cola se pone en pausa');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(app.snapshot().next.length, 1, 'no arranca sola estando en pausa');
    app.handle('/seguir');
    await until(() => n('terminado') >= 1);
    assert.equal(app.snapshot().next.length, 0);
    assert.equal(app.snapshot().nextPaused, false);
    app.dispose();
  }
  // con plan previo: también se te enseña el plan al encolar
  {
    const { app, all, n } = mk();
    app.handle('/plan off');
    app.handle('créame un script en python');
    await until(() => app.session.busy);
    app.handle('/plan on');
    app.handle('créame un modelo de enemigo');
    await until(() => app.snapshot().plan);
    assert.equal(app.snapshot().plan.queued, true, 'el plan avisa de que irá a la cola');
    app.planRun();
    assert.equal(app.snapshot().next.length, 1);
    await until(() => n('terminado') >= 2, 20000);
    assert.equal(app.snapshot().next.length, 0);
    app.dispose();
  }
  delete process.env.FAKE_STEP_MS;
}

// 12) login detectado
assert.equal(authStatus().loggedIn, true);

console.log('OK: núcleo funciona (delegación, stats, caché, compactar, deriva, reglas, ajustes, perfiles, git, cola, historial, stack, flujos).');
