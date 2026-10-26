// Detecta el tipo de proyecto (barato, sin llamar a ningún modelo) y activa SOLO los subagentes
// especialistas que tocan: cada subagente listado cuesta tokens en cada petición, así que no cargamos los que no hacen falta.
import fs from 'node:fs';
import path from 'node:path';

const EDIT = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];

// kw = palabras (sin tildes, en minúsculas) con las que lo reconocemos en lo que escribes; ext = extensiones que delatan el stack del proyecto.
const spec = (tag, description, prompt, kw, ext = []) => ({ tag, description, prompt, kw, ext, model: 'sonnet', tools: EDIT });
const STD = 'Follow the project\'s existing style, versions and conventions. Reuse what exists before writing new code. Report briefly: files changed, anything the caller must verify and the command to build/test.';

export const SPECIALISTS = {
  frontend: spec('Frontend', 'Frontend specialist (mid-tier). React/Next/Vue/Svelte + TypeScript UI work: components, hooks, state, styling, accessibility, responsive layout. Edits files.',
    `You are a senior frontend engineer (React/TypeScript and modern frameworks). Typed, accessible, responsive code; reuse existing components/hooks first. ${STD}`,
    /\b(react|next(\.?js)?|vue|nuxt|svelte|angular|solid|typescript|tsx|jsx|hooks?|redux|zustand|componentes?|frontend|front-end)\b/, ['.tsx', '.jsx', '.vue', '.svelte']),
  web: spec('HTML/CSS', 'HTML/CSS specialist (mid-tier). Semantic HTML, CSS/SCSS/Tailwind, flexbox/grid, animations, responsive and accessible layouts, vanilla JS in the DOM. Edits files.',
    `You are a senior web developer focused on HTML and CSS (plus vanilla JS/DOM). Semantic markup, accessible, mobile-first, no unnecessary dependencies. ${STD}`,
    /\b(html5?|css3?|scss|sass|less|tailwind|bootstrap|flexbox|grid|maquet\w+|landing|responsive|dom|animacion\w*|estilos?)\b/, ['.html', '.css', '.scss', '.sass', '.less']),
  node: spec('Node.js', 'Node.js specialist (mid-tier). Node/Express/Fastify/NestJS servers, npm packages, CLIs, streams, async patterns, ESM/CJS, build tooling. Edits files.',
    `You are a senior Node.js engineer. Handle async errors explicitly, validate inputs, keep dependencies minimal, respect the module system (ESM/CJS) the project uses. ${STD}`,
    /\b(node(\.?js)?|npm|npx|pnpm|yarn|express|fastify|koa|nestjs|deno|bun|package\.json|esm|commonjs|cli en node)\b/, ['.mjs', '.cjs']),
  backend: spec('Backend/API', 'Backend/API specialist (mid-tier). Endpoints, validation, authentication/authorization, database access, error handling, security hardening. Edits files.',
    `You are a senior backend engineer. Validate all inputs, never trust the client, keep secrets out of code, use parameterized queries, handle errors explicitly. Report any security-relevant decision. ${STD}`,
    /\b(api|apis|endpoints?|rest|graphql|backend|back-end|servidor|jwt|oauth|autenticacion|autorizacion|middleware|orm|prisma|webhooks?)\b/),
  sql: spec('SQL/BBDD', 'Database specialist (mid-tier). SQL (Postgres/MySQL/SQLite/SQL Server), schema design, migrations, indexes, query optimization, Supabase/Prisma, MongoDB basics. Edits files.',
    `You are a senior database engineer. Write portable, parameterized SQL; think about indexes, constraints and migrations that are safe to run on existing data. ${STD}`,
    /\b(sql|postgres\w*|mysql|mariadb|sqlite|sql ?server|supabase|mongodb|mongo|base(s)? de datos|bbdd|consultas?|queries|query|migraci\w+|esquema|tablas?|indices?)\b/, ['.sql']),
  python: spec('Python', 'Python specialist (mid-tier). Python scripts, packages, async, typing, pytest, FastAPI/Flask/Django, pandas/numpy, packaging and virtualenvs. Edits files.',
    `You are a senior Python engineer. Idiomatic, typed where the project types, small functions, pytest for behavior changes, no new dependency without need. ${STD}`,
    /\b(python|pip|pipx|venv|django|flask|fastapi|pandas|numpy|pytest|pydantic|asyncio|jupyter|requirements\.txt|pyproject)\b/, ['.py', '.ipynb']),
  cpp: spec('C/C++', 'C/C++ specialist (mid-tier). Modern C++ (RAII, STL, templates), C, CMake/Make builds, memory safety, performance, Unreal C++ and native libraries. Edits files.',
    `You are a senior C/C++ engineer. Prefer RAII and the standard library, avoid raw owning pointers and undefined behavior, mind ABI/headers and the project's C++ standard. ${STD}`,
    /(\bc\+\+|\bcpp\b|\bcmake\b|\bmakefile\b|\bstl\b|\bclang\b|\bgcc\b|\bunreal\b|\bpunteros?\b|\bheader(s)?\b|\.cpp\b|\.hpp\b|\bc\/c\+\+)/, ['.cpp', '.cc', '.cxx', '.hpp', '.h', '.c']),
  csharp: spec('C#/.NET', 'C#/.NET specialist (mid-tier). C#, .NET, ASP.NET, Entity Framework, WPF/WinForms/MAUI, LINQ, async/await, Unity C# scripts. Edits files.',
    `You are a senior C#/.NET engineer. Use async/await correctly, nullable reference types, LINQ with care, dependency injection; in Unity avoid allocations in Update. ${STD}`,
    /(\bc#|\bcsharp\b|\.net\b|\bdotnet\b|\basp\.?net\b|\bblazor\b|\bwpf\b|\bwinforms\b|\bmaui\b|\blinq\b|\bentity framework\b|\bmonobehaviour\b|\.cs\b|\.csproj\b|\bnuget\b)/, ['.cs', '.csproj', '.sln']),
  java: spec('Java', 'Java/Kotlin-JVM specialist (mid-tier). Java/Spring/JavaFX/Maven/Gradle code: classes, generics, streams, JPA, JUnit, build issues. Edits files.',
    `You are a senior Java engineer. Follow the project's package layout and Java version, prefer immutability and clear exceptions, write JUnit tests when behavior changes. ${STD}`,
    /\b(java|spring( boot)?|javafx|maven|gradle|jpa|hibernate|junit|jvm|jar|pom\.xml|servlets?)\b/, ['.java']),
  go: spec('Go', 'Go specialist (mid-tier). Go modules, goroutines/channels, HTTP services, CLIs, testing, performance. Edits files.',
    `You are a senior Go engineer. Idiomatic Go: small interfaces, explicit errors, context propagation, table-driven tests, gofmt. ${STD}`,
    /(\bgolang\b|\bgo mod\b|\bgoroutines?\b|\bgo build\b|\.go\b)/, ['.go']),
  rust: spec('Rust', 'Rust specialist (mid-tier). Ownership/borrowing, traits, error handling, cargo, async (tokio), unsafe review, performance. Edits files.',
    `You are a senior Rust engineer. Idiomatic ownership, Result-based errors, avoid unnecessary clones and unsafe, clippy-clean. ${STD}`,
    /\b(rust|cargo|crates?|tokio|borrow checker|rustc|clippy)\b/, ['.rs']),
  php: spec('PHP', 'PHP specialist (mid-tier). PHP 8, Laravel/Symfony, Composer, WordPress plugins/themes, PDO, security basics. Edits files.',
    `You are a senior PHP engineer. Modern PHP 8 typing, prepared statements, escape output, follow the framework's conventions. ${STD}`,
    /\b(php|laravel|symfony|composer|wordpress|wp-content|blade|eloquent)\b/, ['.php']),
  mobile: spec('Mobile', 'Mobile specialist (mid-tier). Android (Kotlin/Jetpack Compose), iOS (Swift/SwiftUI), Flutter/Dart, React Native: screens, navigation, lifecycle, permissions, store builds. Edits files.',
    `You are a senior mobile engineer. Respect platform lifecycle and permissions, keep UI work off the main thread, follow the platform's design guidelines. ${STD}`,
    /\b(android|kotlin|jetpack|compose|ios|swift|swiftui|xcode|flutter|dart|react native|expo|app movil|apk)\b/, ['.kt', '.swift', '.dart']),
  shell: spec('Shell/DevOps', 'Shell/DevOps specialist (mid-tier). Bash/PowerShell/CMD scripts, Docker/compose, CI (GitHub Actions), installers, deployment, Linux/Windows setup. Edits files.',
    `You are a senior DevOps engineer. Scripts must be safe to re-run (idempotent), quote variables, fail loudly, and work on the user's OS; never put secrets in files. ${STD}`,
    /\b(bash|shell|powershell|cmd|batch|\.bat|\.sh|\.ps1|docker\w*|compose|github actions|ci\/cd|pipeline|nginx|deploy|despliegue|instalador|systemd)\b/, ['.sh', '.ps1', '.bat', 'Dockerfile']),
  blender: spec('Blender', 'Blender/bpy specialist (mid-tier). Python scripts and add-ons, geometry nodes, materials, rigging/animation scripts, export pipelines (glTF/FBX), scene performance. Edits scripts.',
    `You are an expert in Blender Python (bpy) and 3D pipelines. Write bpy code compatible with the project's Blender version, avoid heavy per-frame loops, prefer the data API over ops when possible, keep export settings explicit. ${STD}`,
    /\b(blender|bpy|geometry nodes|nodos de geometria|rigg?ing|armature|add-?on|\.blend|modelo 3d|modelado 3d|malla|mesh|uv|texturas?|shader nodes|animacion 3d|3d)\b/, ['.blend']),
  juego: spec('Videojuego', 'Game-dev specialist (mid-tier). Godot/Unity/Unreal/Phaser scripts, scenes and prefabs, game loop, physics, input, balance, performance, asset pipeline. Edits files.',
    `You are a senior game developer. Use the engine's idioms (signals/events, scenes/prefabs, delta-time), keep per-frame work cheap, avoid allocations in hot paths, keep gameplay numbers in data, not hard-coded. ${STD}`,
    /\b(godot|gdscript|unity|unreal|phaser|videojuegos?|juego|game ?dev|sprites?|hitbox|npc|niveles?|colisi\w+|fisicas?|bucle de juego|game loop|enemigos?|jugador)\b/, ['.gd', '.tscn', '.unity', '.prefab', '.uproject']),
};

export const SPEC_KEYS = Object.keys(SPECIALISTS);
const PUBLIC = ({ tag, kw, ext, ...def }) => def;
export const specialistDefs = (keys) => Object.fromEntries((keys || []).filter((k) => SPECIALISTS[k]).map((k) => [k, PUBLIC(SPECIALISTS[k])]));
const nrm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// Qué especialistas tocan según lo que escribes (palabras clave; el enrutador de Haiku lo hace mejor y esto es el plan B)
export const specialistsFor = (text) => SPEC_KEYS.filter((k) => SPECIALISTS[k].kw.test(nrm(text)));
// Para el enrutador: una línea por especialista
export const SPEC_DESC = Object.fromEntries(SPEC_KEYS.map((k) => [k, SPECIALISTS[k].tag]));

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
    tags.add('node');
    if (has(/^(react|next|vue|nuxt|svelte|@angular\/core|solid-js|astro|preact)$/)) tags.add('frontend');
    if (has(/^(express|fastify|koa|hono|@nestjs\/core|@hapi\/hapi|prisma|mongoose|sequelize|typeorm)$/)) tags.add('backend');
    if (deps.typescript || exists(cwd, 'tsconfig.json')) tags.add('ts');
    if (has(/^(phaser|three|babylonjs|@babylonjs\/core|pixi\.js)$/)) tags.add('juego');
  }
  const py = ['requirements.txt', 'pyproject.toml', 'Pipfile'].map((f) => { try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return ''; } }).join('\n');
  if (py.trim()) tags.add('python');
  if (/fastapi|flask|django|sqlalchemy|aiohttp|uvicorn/i.test(py)) tags.add('backend');
  if (exists(cwd, 'pom.xml') || exists(cwd, 'build.gradle') || exists(cwd, 'build.gradle.kts')) tags.add('java');
  if (exists(cwd, 'go.mod')) tags.add('go');
  if (exists(cwd, 'Cargo.toml')) tags.add('rust');
  if (exists(cwd, 'composer.json')) tags.add('php');
  if (exists(cwd, 'CMakeLists.txt')) tags.add('cpp');
  if (exists(cwd, 'Dockerfile') || exists(cwd, 'docker-compose.yml')) tags.add('shell');
  if (exists(cwd, 'project.godot') || exists(cwd, 'ProjectSettings') || [...(function* () { try { yield* fs.readdirSync(cwd); } catch { /* nada */ } })()].some((f) => f.endsWith('.uproject'))) tags.add('juego');

  // Un vistazo barato a las extensiones (2 niveles, tope de archivos): delata el lenguaje aunque no haya archivo de proyecto
  const byExt = {};
  let scanned = 0;
  let blender = false;
  walk(cwd, 2, (full, e) => {
    if (scanned > 400) return false;
    if (!e.isFile()) return true;
    scanned++;
    const ext = path.extname(e.name).toLowerCase();
    if (e.name === 'Dockerfile') byExt.Dockerfile = (byExt.Dockerfile || 0) + 1;
    if (ext) byExt[ext] = (byExt[ext] || 0) + 1;
    if (ext === '.blend') blender = true;
    if (!blender && ext === '.py' && scanned < 120) {
      try {
        const fd = fs.openSync(full, 'r');
        const b = Buffer.alloc(3000);
        const n = fs.readSync(fd, b, 0, 3000, 0);
        fs.closeSync(fd);
        if (/^\s*(import bpy|from bpy)/m.test(b.toString('utf8', 0, n))) blender = true;
      } catch { /* ilegible */ }
    }
    return true;
  });
  if (blender) tags.add('blender');
  for (const [k, def] of Object.entries(SPECIALISTS)) {
    if (k === 'frontend' || k === 'backend' || k === 'juego') continue; // esos se deducen mejor de las dependencias
    if (def.ext.reduce((n, x) => n + (byExt[x] || 0), 0) >= 2) tags.add(k);
  }

  // Los especialistas NO se cargan siempre: aparecen solo cuando una instrucción toca su tecnología (o, si no dices nada concreto, los 2 del proyecto)
  const hints = SPEC_KEYS.filter((k) => tags.has(k));
  const names = [...tags].map((t) => (t === 'ts' ? 'TypeScript' : SPECIALISTS[t]?.tag || t));
  return { tags: [...tags], hints, agents: {}, summary: names.join(' · ') };
}
