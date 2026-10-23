// Detecta el tipo de proyecto (barato, sin llamar a ningún modelo) y activa SOLO los subagentes
// especialistas que tocan: cada subagente listado cuesta tokens en cada petición, así que no cargamos los que no hacen falta.
import fs from 'node:fs';
import path from 'node:path';

const EDIT = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];

export const SPECIALISTS = {
  frontend: {
    tag: 'Frontend',
    description: 'Frontend specialist (mid-tier). React/TypeScript/CSS UI work: components, hooks, state, styling, accessibility, responsive layout. Edits files.',
    prompt: 'You are a senior frontend engineer. Implement exactly what is asked in the project\'s existing style and component patterns, typed (TypeScript when the project uses it), accessible and responsive. Reuse existing components/hooks before writing new ones. Report briefly: files changed and anything the caller must verify.',
    model: 'sonnet',
    tools: EDIT,
  },
  backend: {
    tag: 'Backend/API',
    description: 'Backend/API specialist (mid-tier). Endpoints, validation, authentication/authorization, database queries, error handling, security hardening. Edits files.',
    prompt: 'You are a senior backend engineer. Implement exactly what is asked following the project\'s conventions. Validate all inputs, never trust the client, keep secrets out of code, use parameterized queries, handle errors explicitly. Report briefly: files changed and any security-relevant decision.',
    model: 'sonnet',
    tools: EDIT,
  },
  blender: {
    tag: 'Blender',
    description: 'Blender/bpy specialist (mid-tier). Python scripts and add-ons, geometry nodes, materials, rigging/animation scripts, export pipelines (glTF/FBX), scene performance. Edits scripts.',
    prompt: 'You are an expert in Blender Python (bpy) and 3D pipelines. Write bpy code compatible with the Blender version used in the project, avoid per-frame heavy loops, prefer data API over ops when possible, and keep export settings explicit. Report briefly: files changed, Blender version assumptions and how to run/test it.',
    model: 'sonnet',
    tools: EDIT,
  },
  juego: {
    tag: 'Videojuego',
    description: 'Game-dev specialist (mid-tier). Godot/Unity/Unreal scripts, scenes and prefabs, game loop, physics, input, performance, asset pipeline. Edits files.',
    prompt: 'You are a senior game developer. Implement exactly what is asked using the engine\'s idioms (signals/events, scenes/prefabs, delta-time), keep per-frame work cheap and avoid allocations in hot paths. Report briefly: files changed and how to test it in the editor.',
    model: 'sonnet',
    tools: EDIT,
  },
  java: {
    tag: 'Java',
    description: 'Java specialist (mid-tier). Java/Spring/JavaFX/Maven/Gradle code: classes, generics, streams, JPA, JUnit, build issues. Edits files.',
    prompt: 'You are a senior Java engineer. Follow the project\'s package layout and Java version, prefer immutability and clear exceptions, and write JUnit tests when behavior changes. Report briefly: files changed and the command to build/test.',
    model: 'sonnet',
    tools: EDIT,
  },
};

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function exists(...p) {
  try { return fs.existsSync(path.join(...p)); } catch { return false; }
}
function walk(dir, depth, visit) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (/^(node_modules|\.git|\.venv|venv|__pycache__|Library|Temp|dist|build)$/.test(e.name)) continue;
    const full = path.join(dir, e.name);
    if (visit(full, e) === false) return;
    if (e.isDirectory() && depth > 0) walk(full, depth - 1, visit);
  }
}

export function detectStack(cwd) {
  const tags = new Set();
  const pkg = readJson(path.join(cwd, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const has = (re) => Object.keys(deps).some((d) => re.test(d));
    if (has(/^(react|next|vue|nuxt|svelte|@angular\/core|solid-js|astro|preact)$/)) tags.add('frontend');
    if (has(/^(express|fastify|koa|hono|@nestjs\/core|@hapi\/hapi|prisma|mongoose|sequelize|typeorm)$/)) tags.add('backend');
    if (deps.typescript || exists(cwd, 'tsconfig.json')) tags.add('ts');
    if (has(/^(phaser|three|babylonjs|@babylonjs\/core|pixi\.js)$/)) tags.add('juego');
  }
  const py = ['requirements.txt', 'pyproject.toml', 'Pipfile'].map((f) => { try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return ''; } }).join('\n');
  if (/fastapi|flask|django|sqlalchemy|aiohttp|uvicorn/i.test(py)) tags.add('backend');
  if (exists(cwd, 'pom.xml') || exists(cwd, 'build.gradle') || exists(cwd, 'build.gradle.kts')) tags.add('java');
  if (exists(cwd, 'project.godot') || exists(cwd, 'ProjectSettings') || [...(function* () { try { yield* fs.readdirSync(cwd); } catch { /* nada */ } })()].some((f) => f.endsWith('.uproject'))) tags.add('juego');

  let scanned = 0;
  walk(cwd, 2, (full, e) => {
    if (tags.has('blender') || scanned > 40) return false;
    if (e.isFile() && /\.blend$/i.test(e.name)) { tags.add('blender'); return false; }
    if (e.isFile() && /\.py$/i.test(e.name)) {
      scanned++;
      try {
        const fd = fs.openSync(full, 'r');
        const b = Buffer.alloc(3000);
        const n = fs.readSync(fd, b, 0, 3000, 0);
        fs.closeSync(fd);
        if (/^\s*(import bpy|from bpy)/m.test(b.toString('utf8', 0, n))) { tags.add('blender'); return false; }
      } catch { /* ilegible */ }
    }
    return true;
  });

  const specialists = [...tags].filter((t) => SPECIALISTS[t]);
  const agents = {};
  for (const k of specialists) {
    const { tag, ...def } = SPECIALISTS[k];
    agents[k] = def;
  }
  const names = [...tags].map((t) => (t === 'ts' ? 'TypeScript' : SPECIALISTS[t]?.tag || t));
  return { tags: [...tags], agents, summary: names.join(' · ') };
}
