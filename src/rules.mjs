// Reglas persistentes: "empieza siempre con mi nombre" + higiene de tokens.
// Si Claude deja de empezar con tu nombre, es la señal de que se le va la olla (contexto saturado).
import fs from 'node:fs';
import path from 'node:path';

export const MARK_START = '<!-- claude-router:start -->';
export const MARK_END = '<!-- claude-router:end -->';

export const LESSONS_REL = path.join('.claude', 'lecciones.md');
const LESSONS_HEADER = '# Lecciones del proyecto\n<!-- Una línea por lección (máx. 120 caracteres). Las añade Claude al arreglar bugs; claude-router las condensa. -->\n';

export function rulesBlock(name, { lessons = true, context = true } = {}) {
  return `${MARK_START}
## Reglas de ${name} (gestionado por claude-router; no edites este bloque)

1. **Empieza SIEMPRE cada respuesta con "${name},"** (incluso las cortas, tras usar herramientas o en sesiones largas). Es la señal que ${name} usa para saber que sigues leyendo estas reglas.
2. Español informal, breve y directo. Primero el resultado, después (solo si hace falta) el porqué.
3. Higiene de tokens:
   - No releas archivos que ya leíste en esta sesión.
   - Usa Grep/Glob antes de leer; lee por rangos (offset/limit), no archivos enteros.
   - No pegues salidas largas (logs, archivos): resume y da rutas con número de línea.
   - Agrupa llamadas independientes y para de explorar cuando ya tengas lo necesario.
4. Delegación: lo mecánico (borrar código muerto, renombrar, formatear) y la exploración amplia van a subagentes baratos (limpiador, explorador, probador, documentador). Bugs raros: depurador antes de parchear. Solo decisiones difíciles van a arquitecto. Lanza en paralelo (un solo mensaje) los subagentes independientes.
5. Calidad: antes de empezar una tarea no trivial di en una línea qué significa "hecho" y compruébalo al terminar; si tocas más de 2 archivos, que lo revise \`verificador\`. Al limpiar o optimizar no cambies el comportamiento: comprueba con grep que nada usa lo que borras.
${lessons ? `6. Lecciones: al arreglar un bug o descubrir una trampa del proyecto, añade UNA línea (máx. 120 caracteres, sin duplicar) a \`${LESSONS_REL.replace(/\\/g, '/')}\`.
@${LESSONS_REL.replace(/\\/g, '/')}
` : ''}${context ? `${lessons ? '7' : '6'}. Documentación: al empezar, el resumen del proyecto está en \`.claude/contexto.md\` (importado abajo); para el detalle lee solo el MD que toque. Si tu cambio deja desactualizado un MD (comandos, estructura, API), actualízalo en la misma tarea.
@.claude/contexto.md
` : ''}${MARK_END}`;
}

export function reminder(name) {
  return `[Recordatorio de reglas: empieza tu respuesta con "${name},"; español informal y breve; no releas archivos ya leídos; delega lo mecánico a limpiador/explorador y revisa lo importante con verificador.]`;
}

export function hasRules(cwd) {
  try {
    return fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8').includes(MARK_START);
  } catch {
    return false;
  }
}

// Idempotente: crea CLAUDE.md o reemplaza solo nuestro bloque, sin tocar el resto.
export function installRules(cwd, name, { lessons = true, context = true } = {}) {
  const file = path.join(cwd, 'CLAUDE.md');
  const block = rulesBlock(name, { lessons, context });
  let txt = '';
  let existed = false;
  try { txt = fs.readFileSync(file, 'utf8'); existed = true; } catch { /* no existe */ }
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
  let out;
  let action;
  if (re.test(txt)) { out = txt.replace(re, block); action = 'actualizado'; }
  else if (existed && txt.trim()) { out = txt.replace(/\s*$/, '') + '\n\n' + block + '\n'; action = 'añadido al final'; }
  else { out = block + '\n'; action = 'creado'; }
  if (out !== txt) fs.writeFileSync(file, out);
  let lessonsCreated = false;
  if (lessons) {
    const lf = path.join(cwd, LESSONS_REL);
    if (!fs.existsSync(lf)) {
      fs.mkdirSync(path.dirname(lf), { recursive: true });
      fs.writeFileSync(lf, LESSONS_HEADER);
      lessonsCreated = true;
    }
  }
  return { file, action, changed: out !== txt, lessonsCreated };
}

// Lecciones guardadas (una por línea, ignorando cabecera y comentarios)
export function lessonsInfo(cwd) {
  try {
    const lines = fs.readFileSync(path.join(cwd, LESSONS_REL), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('<!--'));
    return { exists: true, count: lines.length, lines };
  } catch {
    return { exists: false, count: 0, lines: [] };
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function startsWithName(text, name) {
  const t = String(text || '').replace(/^[\s*_>#`"'¡¿\-–—]+/, '');
  return new RegExp('^' + escapeRe(name) + '(?![\\p{L}\\p{N}])', 'iu').test(t);
}

export class DriftTracker {
  constructor(name) { this.name = name; this.reset(); this.total = 0; }
  reset() { this.strikes = 0; }
  get level() { return this.strikes === 0 ? 0 : this.strikes === 1 ? 1 : 2; }
  record(text) {
    this.total += 1;
    const ok = startsWithName(text, this.name);
    this.strikes = ok ? 0 : this.strikes + 1;
    return { ok, strikes: this.strikes, level: this.level };
  }
}
