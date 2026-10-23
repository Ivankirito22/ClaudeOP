// Red de seguridad con git: antes de cada instrucción guarda una "foto" de tu carpeta (incluye archivos nuevos),
// sin tocar tu rama, tu índice ni tu historial. Permite ver qué cambió Claude y deshacerlo.
// Las fotos viven como commits sueltos bajo refs/claude-router/ckpt/ (git no las borra).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REF = 'refs/claude-router/ckpt';
let seq = 0;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const KEEP = 40; // fotos que se conservan
const SKIP_RE = /(^|\/)(node_modules|\.venv|venv|__pycache__|\.git|Library|Temp|\.godot)(\/|$)/; // nunca se tocan al restaurar
// Tope por archivo y total: los assets enormes (texturas, .blend, vídeo) no se fotografían — ni se tocan al deshacer.
const MAX_FILE = (Number(process.env.CR_CKPT_MAX_FILE_MB) || 8) * 1024 * 1024;
const MAX_TOTAL = (Number(process.env.CR_CKPT_MAX_TOTAL_MB) || 300) * 1024 * 1024;
const IDENT = { GIT_AUTHOR_NAME: 'claude-router', GIT_AUTHOR_EMAIL: 'router@local', GIT_COMMITTER_NAME: 'claude-router', GIT_COMMITTER_EMAIL: 'router@local' };

function git(cwd, args, env = {}, input) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT, ...env }, maxBuffer: 256 * 1024 * 1024, input });
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\r?\n$/, ''), err: (r.stderr || '').trim(), raw: r.stdout || '' };
}

export function hasGit() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}
export function isRepo(cwd) {
  return hasGit() && git(cwd, ['rev-parse', '--is-inside-work-tree']).out === 'true';
}
export function gitInit(cwd) {
  if (isRepo(cwd)) return { ok: true, already: true };
  const r = git(cwd, ['init']);
  return { ok: r.ok, already: false, err: r.err };
}
const topLevel = (cwd) => git(cwd, ['rev-parse', '--show-toplevel']).out || cwd;

// Lista lo que entra en la foto: archivos de esta carpeta (no ignorados), sin dependencias y por debajo del tope de tamaño.
function scanWork(cwd) {
  const r = git(cwd, ['ls-files', '-z', '-c', '-o', '--exclude-standard']);
  if (!r.ok) return null;
  const list = [];
  let total = 0;
  for (const f of r.raw.split('\0')) {
    if (!f || SKIP_RE.test(f)) continue;
    try {
      const size = fs.statSync(path.join(cwd, f)).size;
      if (size > MAX_FILE) continue;
      total += size;
      list.push(f);
    } catch { /* borrado o ilegible */ }
  }
  return { list, mb: Math.round(total / 1048576), tooBig: total > MAX_TOTAL };
}

// Árbol (tree) con el contenido actual de esta carpeta, sin tocar el índice real.
function workTree(cwd, scan = scanWork(cwd)) {
  if (!scan || scan.tooBig) return null;
  const idx = path.join(os.tmpdir(), `cr-idx-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    if (scan.list.length) {
      const a = git(cwd, ['add', '-f', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], env, scan.list.join('\0'));
      if (!a.ok) return null;
    }
    const t = git(cwd, ['write-tree'], env);
    return t.ok ? t.out : null;
  } finally {
    try { fs.rmSync(idx, { force: true }); } catch { /* nada */ }
  }
}

function refs(cwd) {
  const r = git(cwd, ['for-each-ref', '--sort=refname', '--format=%(refname)\t%(objectname)\t%(tree)\t%(creatordate:unix)\t%(subject)', REF]);
  if (!r.ok || !r.out) return [];
  return r.out.split('\n').map((l) => {
    const [ref, sha, tree, ts, ...s] = l.split('\t');
    return { ref, sha, tree, ts: Number(ts) * 1000, label: s.join('\t') };
  });
}

// Estado de deshacer/rehacer (vive dentro de .git, no ensucia tu proyecto).
const stateFile = (cwd) => path.join(git(cwd, ['rev-parse', '--absolute-git-dir']).out, 'claude-router-undo.json');
function readState(cwd) {
  try { return { pos: null, redo: [], ...JSON.parse(fs.readFileSync(stateFile(cwd), 'utf8')) }; } catch { return { pos: null, redo: [] }; }
}
function writeState(cwd, st) {
  try { fs.writeFileSync(stateFile(cwd), JSON.stringify(st)); } catch { /* nada */ }
}

// Guarda una foto. Devuelve null si no es repo; { created:false } si no cambió nada desde la última igual.
export function checkpoint(cwd, label = 'manual', { dedupe = true } = {}) {
  if (!isRepo(cwd)) return null;
  if (label.startsWith('antes:')) writeState(cwd, { pos: null, redo: [] }); // una instrucción nueva empieza una línea de tiempo nueva
  const scan = scanWork(cwd);
  if (scan && scan.tooBig) return { created: false, skipped: 'grande', mb: scan.mb, maxMb: Math.round(MAX_TOTAL / 1048576) };
  const tree = workTree(cwd, scan);
  if (!tree) return null;
  const list = refs(cwd);
  const same = list.filter((c) => c.label.startsWith('antes:') === label.startsWith('antes:')).pop();
  if (dedupe && same && same.tree === tree) return { created: false, sha: same.sha, label: same.label };
  const head = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  const args = ['commit-tree', tree, ...(head.ok ? ['-p', head.out] : []), '-m', label.slice(0, 120)];
  const c = git(cwd, args);
  if (!c.ok) return null;
  const name = `${REF}/${Date.now()}${String(seq++ % 100).padStart(2, '0')}`;
  if (!git(cwd, ['update-ref', name, c.out]).ok) return null;
  const all = refs(cwd);
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) git(cwd, ['update-ref', '-d', old.ref]);
  return { created: true, sha: c.out, label };
}

export function listCheckpoints(cwd) {
  return isRepo(cwd) ? refs(cwd).reverse() : [];
}

function filesOf(cwd, tree) {
  return new Set(git(cwd, ['ls-tree', '-r', '-z', '--name-only', tree]).raw.split('\0').filter(Boolean));
}

// Deja la carpeta exactamente como en `tree` (sin tocar node_modules & co).
function restore(cwd, tree) {
  const top = topLevel(cwd);
  const prefix = git(cwd, ['rev-parse', '--show-prefix']).out; // '' si cwd es la raíz del repo; si no, solo tocamos esta subcarpeta
  const idx = path.join(os.tmpdir(), `cr-idx-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    if (!git(top, ['read-tree', tree], env).ok) throw new Error('no pude leer la foto');
    const co = git(top, ['checkout-index', '-a', '-f'], env);
    if (!co.ok) throw new Error(co.err || 'checkout-index falló');
    const target = filesOf(top, tree);
    const now = git(top, ['ls-files', '-z', '-c', '-o', '--exclude-standard']).raw.split('\0').filter(Boolean);
    let removed = 0;
    for (const f of now) {
      if (target.has(f) || SKIP_RE.test(f) || !f.startsWith(prefix)) continue;
      try {
        if (fs.statSync(path.join(top, f)).size > MAX_FILE) continue; // nunca estuvo en la foto: no se borra
        fs.rmSync(path.join(top, f), { force: true });
        removed++;
        for (let d = path.dirname(path.join(top, f)); d !== top && d.startsWith(top); d = path.dirname(d)) {
          try { fs.rmdirSync(d); } catch { break; } // solo borra carpetas vacías
        }
      } catch { /* ya no estaba */ }
    }
    return { ok: true, restored: target.size, removed };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { fs.rmSync(idx, { force: true }); } catch { /* nada */ }
  }
}

// Deshace la última instrucción que cambió algo; cada pulsación va una más atrás.
export function undo(cwd) {
  if (!isRepo(cwd)) return { ok: false, error: 'Esto no es un repositorio git (usa /git-init).' };
  const st = readState(cwd);
  const cur = workTree(cwd);
  if (!cur) return { ok: false, error: 'La carpeta es demasiado grande para las fotos (usa .gitignore para los assets pesados).' };
  const cand = refs(cwd).reverse().find((c) => c.label.startsWith('antes:') && c.tree !== cur && (!st.pos || c.ref < st.pos));
  if (!cand) return { ok: false, error: 'No hay nada más que deshacer: la carpeta ya está como antes de esa instrucción.' };
  const point = checkpoint(cwd, 'deshacer-punto', { dedupe: false });
  const r = restore(cwd, cand.tree);
  if (!r.ok) return r;
  writeState(cwd, { pos: cand.ref, redo: [...st.redo, { sha: point?.sha, prevPos: st.pos }] });
  return { ...r, label: cand.label.replace(/^antes:\s*/, '') };
}

// Rehace lo último que deshiciste.
export function redo(cwd) {
  if (!isRepo(cwd)) return { ok: false, error: 'Esto no es un repositorio git.' };
  const st = readState(cwd);
  const e = st.redo[st.redo.length - 1];
  if (!e || !e.sha || !git(cwd, ['cat-file', '-e', e.sha]).ok) return { ok: false, error: 'No hay nada que rehacer.' };
  const r = restore(cwd, git(cwd, ['rev-parse', `${e.sha}^{tree}`]).out);
  if (!r.ok) return r;
  writeState(cwd, { pos: e.prevPos, redo: st.redo.slice(0, -1) });
  return { ...r, label: 'lo que habías deshecho' };
}

// Qué cambió desde la foto de antes de la última instrucción (o desde HEAD si no hay).
export function changes(cwd, { maxLines = 400 } = {}) {
  if (!isRepo(cwd)) return { ok: false, error: 'Esto no es un repositorio git (usa /git-init).' };
  const st = readState(cwd);
  const cur = workTree(cwd);
  if (!cur) return { ok: false, error: 'La carpeta es demasiado grande para calcular los cambios (usa .gitignore para los assets pesados).' };
  const list = refs(cwd).reverse().filter((c) => c.label.startsWith('antes:'));
  const base = (st.pos && list.find((c) => c.ref === st.pos)) || list[0];
  const baseTree = base ? base.tree : git(cwd, ['rev-parse', '--verify', '-q', 'HEAD^{tree}']).out || EMPTY_TREE;
  if (!cur || !baseTree) return { ok: false, error: 'No pude calcular los cambios.' };
  if (cur === baseTree) return { ok: true, empty: true, stat: '', diff: '', from: base?.label || 'HEAD' };
  const stat = git(cwd, ['diff', '--stat=60', '--no-color', baseTree, cur]).out;
  const diff = git(cwd, ['diff', '--no-color', '-U2', baseTree, cur]).out.split('\n');
  return {
    ok: true,
    empty: false,
    from: base ? base.label.replace(/^antes:\s*/, '') : 'el último commit',
    stat,
    diff: diff.slice(0, maxLines).join('\n'),
    truncated: Math.max(0, diff.length - maxLines),
  };
}
