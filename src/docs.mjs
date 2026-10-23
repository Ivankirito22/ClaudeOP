// Contexto del proyecto a partir de sus MDs: encuentra README/CLAUDE.md/docs, los indexa y genera un resumen
// (.claude/contexto.md) que se importa desde CLAUDE.md. Así cada sesión "entra en contexto" sin releer todo.
import fs from 'node:fs';
import path from 'node:path';

export const CONTEXT_REL = path.join('.claude', 'contexto.md');
// Nunca pisamos un contexto.md tuyo: si existe y no lo generó claude-router, usamos contexto-router.md
export function contextRel(cwd) {
  try { return fs.readFileSync(path.join(cwd, CONTEXT_REL), 'utf8').includes('claude-router') ? CONTEXT_REL : path.join('.claude', 'contexto-router.md'); } catch (e) { return e.code === 'ENOENT' ? CONTEXT_REL : path.join('.claude', 'contexto-router.md'); }
}
const SKIP_DIR = /^(node_modules|\.git|\.venv|venv|__pycache__|dist|build|out|target|Library|Temp|\.godot|\.next|coverage|vendor|site-packages)$/i;
const KEEP_HIDDEN = new Set(['.claude', '.github']);
const OWN = /^(contexto|lecciones)\.md$/i; // los generamos nosotros: no se indexan como documentación

// Archivos de configuración que explican el proyecto (se leen solo si existen; de .env solo el ejemplo)
export const CONTEXT_FILES = ['package.json', 'pyproject.toml', 'requirements.txt', 'Makefile', 'docker-compose.yml', 'Dockerfile',
  'tsconfig.json', 'pom.xml', 'build.gradle', 'project.godot', '.env.example', '.cursorrules', '.github/copilot-instructions.md'];

function priority(rel) {
  const base = path.basename(rel).toLowerCase();
  const depth = rel.split('/').length - 1;
  if (depth === 0 && base === 'claude.md') return 0;
  if (base === 'agents.md') return 1;
  if (depth === 0 && /^readme/.test(base)) return 2;
  if (/^(architecture|contributing|design|decisions|adr|roadmap)/.test(base)) return 3;
  if (rel.startsWith('docs/') || rel.startsWith('doc/')) return 4;
  return depth === 0 ? 5 : 6;
}

function titleOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const lines = buf.toString('utf8', 0, n).split('\n').map((l) => l.trim());
    const h = lines.find((l) => /^#{1,3}\s+\S/.test(l));
    const t = h ? h.replace(/^#+\s+/, '') : lines.find((l) => l && !l.startsWith('<!--') && l !== '---') || '';
    return t.replace(/[*_`]/g, '').slice(0, 70);
  } catch {
    return '';
  }
}

export function scanDocs(cwd, { maxDepth = 3, max = 40 } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.test(e.name) || (e.name.startsWith('.') && !KEEP_HIDDEN.has(e.name))) continue;
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (/\.mdx?$/i.test(e.name) && !(OWN.test(e.name) && dir.endsWith('.claude'))) {
        try {
          const st = fs.statSync(full);
          if (st.size === 0) continue;
          const rel = path.relative(cwd, full).split(path.sep).join('/');
          found.push({ rel, size: st.size, mtime: st.mtimeMs, title: titleOf(full), prio: priority(rel) });
        } catch { /* ilegible */ }
      }
    }
  };
  walk(cwd, 0);
  found.sort((a, b) => a.prio - b.prio || a.rel.localeCompare(b.rel));
  return found.slice(0, max);
}

// CLAUDE.md ya se carga solo: no se resume, no cuenta para saber si el resumen está viejo y no hace falta leerlo
export const readable = (docs) => docs.filter((d) => d.rel.toLowerCase() !== 'claude.md');

export function contextFiles(cwd) {
  return CONTEXT_FILES.filter((f) => { try { return fs.existsSync(path.join(cwd, f)); } catch { return false; } });
}

const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(0)}KB` : `${n}B`);

// Índice compacto para la política del sistema (se cachea con ella: casi gratis tras la primera petición)
export function docsIndex(docs, max = 25) {
  if (!docs.length) return '';
  const lines = docs.slice(0, max).map((d) => `- ${d.rel}${d.title ? ' — ' + d.title : ''} (${kb(d.size)})`);
  if (docs.length > max) lines.push(`- … y ${docs.length - max} más`);
  return lines.join('\n');
}

// ¿Existe el resumen y está al día respecto a los MDs?
export function digestState(cwd, docs) {
  try {
    const st = fs.statSync(path.join(cwd, contextRel(cwd)));
    const newest = Math.max(0, ...readable(docs).map((d) => d.mtime));
    const stale = newest > st.mtimeMs + 1000;
    return { exists: true, fresh: !stale, stale, mtime: st.mtimeMs };
  } catch {
    return { exists: false, fresh: false, stale: false, mtime: 0 };
  }
}

// Primera instrucción de una sesión sin resumen al día: lectura barata (Haiku) en vez de leer los MDs con el modelo principal.
export function firstRunPrefix(docs, extras = []) {
  const top = readable(docs).slice(0, 8).map((d) => d.rel).join(', ');
  return `(Router) Primera instrucción de esta sesión. Antes de empezar, delega en explorador la lectura de la documentación del proyecto relevante para esta tarea (${top}${extras.length ? '; configuración: ' + extras.slice(0, 4).join(', ') : ''}) y pídele un resumen de máx. 15 líneas: qué es, comandos de build/test/run, convenciones y trampas. No leas tú esos MDs enteros. Si la tarea contradice la documentación, avísame antes de tocar código.`;
}

export function contextPrompt(allDocs, extras = [], rel = CONTEXT_REL) {
  const docs = readable(allDocs);
  const list = docs.length ? docs.map((d) => `- ${d.rel}${d.title ? ' — ' + d.title : ''}`).join('\n') : '(no hay MDs: parte del código y de los archivos de configuración)';
  const today = new Date().toISOString().slice(0, 10);
  return `Genera el resumen de contexto del proyecto en ${rel.split(path.sep).join('/')} (créalo o reescríbelo entero; es un archivo de claude-router, no toques ningún otro MD).

Fuentes:
${list}
Configuración a mirar si existe: ${extras.length ? extras.join(', ') : 'ninguna'} (de .env solo el ejemplo y solo los NOMBRES de variables; NUNCA leas .env ni claves). Si es un repo git, añade \`git log --oneline -10\`.

Cómo: delega en explorador la lectura en PARALELO (un solo mensaje, máx. 5 archivos por explorador) y que cada uno devuelva puntos clave, no copias. Después escribe tú el archivo con este formato (máx. 45 líneas, condensado, solo comandos literales):

<!-- generado por claude-router ${today} · fuentes: ${docs.length} MDs -->
# Contexto del proyecto
- Qué es: …
- Stack: …
- Cómo se ejecuta / prueba / construye: comandos exactos
- Estructura: carpetas clave → propósito
- Convenciones y decisiones importantes (indica el MD donde está el detalle)
- Trampas conocidas y pendientes relevantes (TODO/FIXME importantes)
- Documentos: ruta — para qué sirve (una línea cada uno)

Si dos MDs se contradicen o algo parece obsoleto frente al código, añade una sección "Dudas" con eso. Termina diciendo cuántos MDs leíste y qué dudas hay.`;
}
