// Memoria de claudeop: Claude recuerda entre sesiones sin que nadie haga nada, sin dependencias y sin gastar tokens.
// Cómo: al terminar cada respuesta (Stop) se lee SOLO lo nuevo del transcript y se anota, por proyecto, una ficha por sesión
// (título que ya genera Claude Code, qué se pidió, qué archivos se tocaron, qué agentes se usaron y cómo acabó). Las frases del
// usuario que son preferencias («quiero que…», «siempre usa…», «recuerda que…») van a un archivo global. Al abrir una sesión,
// session-start.mjs devuelve un resumen corto (~350 tokens). Todo es local y los secretos se tapan. Desactivar: CLAUDEOP_MEMORY=off.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, off, readJson } from './data.mjs';

const DIR = path.join(DATA, 'memory');
const PREFS = path.join(DIR, 'preferencias.json');
const MAX_SESSIONS = 30;
const MAX_PREFS = 20;
const MAX_READ = 64 * 1024 * 1024;
const DIAS_30 = 30 * 24 * 3600 * 1000;

// Secretos que no deben llegar nunca a disco: claves conocidas, «clave: valor» (también entre comillas), banderas de CLI,
// usuario:clave en URLs, cabeceras Authorization y claves privadas PEM
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/g,
  /\b(?:Basic|Bearer)\s+[A-Za-z0-9+/=._-]{12,}/g,
  /:\/\/[^\s:@/]+:[^\s@/]+@/g,
  /--(?:password|passwd|pwd|token|secret|api-?key)[= ]\S+/gi,
  /\b(?:password|passwd|pwd|contrase[nñ]a|secret|token|api[_-]?key|apikey|authorization)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];
const INTERNAL = /^(Another Claude session sent a message|<agent-message|\[Subagent hand-back\]|<task-notification|<system-reminder|<command-name|<command-message|<local-command|This session is being continued|\[claudeop|Caveat:)/;
// Una preferencia o regla duradera: «recuerda que…», «quiero que…», «prefiero…»; o una orden permanente que EMPIEZA por siempre/nunca
// («Siempre usa pnpm»). «Este test siempre falla» o «recuerda poner…» (petición de ahora mismo) no cuentan.
const PREF = /\b(recuerda que|ten en cuenta|ten presente|prefiero|me gusta(?!r[ií]a)|no me gusta|quiero q(?:ue)?|no quiero|a partir de ahora|de ahora en adelante|remember that|i prefer|from now on)\b|^(?:siempre|nunca|jam[aá]s|always|never)\b/i;

export const redact = (s) => SECRETS.reduce((t, re) => t.replace(re, (m) => (m.startsWith('://') ? '://«secreto»@' : '«secreto»')), String(s));
const clip = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
export const enabled = () => !off() && !/^(off|0|false)$/i.test(process.env.CLAUDEOP_MEMORY || '');

const projectKey = (cwd) => `${path.basename(cwd || 'x').replace(/[^\w-]/g, '').slice(0, 30) || 'proyecto'}-${crypto.createHash('sha1').update(String(cwd || '').toLowerCase()).digest('hex').slice(0, 8)}`;
const projectFile = (cwd) => path.join(DIR, `${projectKey(cwd)}.json`);
const stateFile = (sid) => path.join(DIR, `lectura-${String(sid || 'x').replace(/[^\w-]/g, '')}.json`);

// Escritura atómica: dos Stop casi a la vez nunca ven un JSON a medias
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

const same = (a, b) => { try { const r = path.relative(fs.realpathSync.native(a), fs.realpathSync.native(b)); return !r.startsWith('..') && !path.isAbsolute(r); } catch { return false; } };
const inTemp = (cwd) => same(os.tmpdir(), cwd || '');

// Frases del usuario que son una preferencia o una regla duradera (no preguntas, no código, no textos pegados)
export function extractPrefs(text) {
  const out = [];
  if (!text || text.length > 700) return out;
  for (const raw of String(text).split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim();
    if (s.length < 18 || s.length > 220 || /[?¿]\s*$/.test(s) || s.startsWith('¿') || /```|=>|[{}]|https?:\/\//.test(s)) continue;
    if (PREF.test(s)) out.push(clip(redact(s), 200));
  }
  return out;
}

const headOf = (file) => {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(256); const n = fs.readSync(fd, b, 0, 256, 0); return crypto.createHash('sha1').update(b.subarray(0, n)).digest('hex').slice(0, 12); } finally { fs.closeSync(fd); }
};

// Lee SOLO las líneas completas nuevas desde `from` (si el transcript se reinició o se reescribió, se empieza de cero)
function readNew(file, from, head, prevHead) {
  const size = fs.statSync(file).size;
  let start = from > size || (prevHead && head !== prevHead) ? 0 : from;
  if (size - start > MAX_READ) start = size - MAX_READ;
  const len = size - start;
  if (len <= 0) return { lines: [], next: size };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const nl = buf.lastIndexOf(10);
    if (nl < 0) return { lines: [], next: start };
    return { lines: buf.subarray(0, nl).toString('utf8').split('\n'), next: start + nl + 1 };
  } finally { fs.closeSync(fd); }
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
// Ruta relativa al proyecto, o null si el archivo está fuera de él (scratchpad, notas de memoria…: no son «lo que se tocó»)
const rel = (p, cwd) => { const r = path.relative(cwd || '', p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : null; };
// El resultado va en una línea y sin bloques de código ni marcas de Markdown
const plain = (s) => String(s).replace(/```[\s\S]*?```/g, ' ').replace(/[`*#>|]/g, '').replace(/\s+/g, ' ').trim();

function savePrefs(list) {
  const store = readJson(PREFS, { items: [] });
  if (!Array.isArray(store.items)) store.items = [];
  const key = (s) => s.toLowerCase().replace(/[^a-z0-9ñáéíóúü]+/g, ' ').trim();
  for (const text of list) {
    const k = key(text);
    const hit = store.items.find((x) => key(x.text) === k);
    if (hit) { hit.n += 1; hit.t = Date.now(); } else store.items.push({ text, n: 1, t: Date.now() });
  }
  store.items.sort((a, b) => b.n - a.n || b.t - a.t);
  store.items = store.items.slice(0, MAX_PREFS);
  save(PREFS, store);
}

// Los archivos de lectura de sesiones viejas se borran solos
function sweep() {
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!/^lectura-.*\.json$/.test(f)) continue;
      const p = path.join(DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > DIAS_30) fs.rmSync(p);
    }
  } catch { /* nada que limpiar */ }
}

// Se llama desde el hook Stop (asíncrono): actualiza la ficha de esta sesión con lo nuevo del transcript. Nunca lanza.
export function updateSession({ session_id: sid, cwd, transcript_path: tp }) {
  try {
    if (!enabled() || !sid || !tp || !fs.existsSync(tp)) return null;
    if (!process.env.CLAUDEOP_MEMORY_ANY && inTemp(cwd)) return null; // pruebas y sondas en carpetas temporales
    fs.mkdirSync(DIR, { recursive: true });
    const sf = stateFile(sid);
    const st = readJson(sf, { off: 0 });
    const head = headOf(tp);
    const { lines, next } = readNew(tp, st.off || 0, head, st.head);

    const proj = readJson(projectFile(cwd), null) || { project: cwd, sessions: [] };
    if (!Array.isArray(proj.sessions)) proj.sessions = [];
    let e = proj.sessions.find((x) => x.s === sid);
    const fresh = !e;
    if (!e) e = { s: sid, t0: Date.now(), asked: [], files: [], agents: {}, prompts: 0, cmds: 0 };
    const prefs = [];

    for (const line of lines) {
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!j || typeof j !== 'object') continue;
      if (j.type === 'ai-title' && j.aiTitle) { e.title = clip(redact(j.aiTitle), 90); continue; }
      const ts = Date.parse(j.timestamp);
      if (ts) { e.t0 = Math.min(e.t0 || ts, ts); e.t1 = Math.max(e.t1 || 0, ts); } // la fecha es la de la sesión, no la de cuando se procesó
      if (j.isSidechain) continue;
      const m = j.message;
      if (!m || typeof m !== 'object') continue;
      if (j.type === 'user' && !j.isMeta) {
        if (Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')) continue;
        const t = textOf(m.content).trim();
        if (!t || t.startsWith('/') || INTERNAL.test(t)) continue;
        e.prompts += 1;
        const c = clip(redact(t), 150);
        e.asked = e.asked.length ? [e.asked[0], c].filter((x, i, a) => a.indexOf(x) === i) : [c];
        prefs.push(...extractPrefs(t));
      } else if (j.type === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type === 'text' && b.text && plain(b.text).length >= 20) e.outcome = clip(redact(plain(b.text)), 240);
          else if (b?.type === 'tool_use') {
            const inp = b.input || {};
            if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) && typeof (inp.file_path || inp.notebook_path) === 'string') {
              const f = rel(inp.file_path || inp.notebook_path, cwd);
              if (f && !e.files.includes(f)) e.files.push(f);
            } else if (b.name === 'Bash' || b.name === 'PowerShell') e.cmds += 1;
            else if ((b.name === 'Agent' || b.name === 'Task') && inp.subagent_type) {
              const a = String(inp.subagent_type).replace(/^claudeop:/, '');
              e.agents[a] = (e.agents[a] || 0) + 1;
            }
          }
        }
      }
    }
    e.files = e.files.slice(-40);
    if (!e.t1) e.t1 = Date.now(); // sin marcas de tiempo en el transcript: la hora actual

    if (prefs.length) savePrefs(prefs); // las preferencias se guardan aunque la sesión aún no tenga ficha
    if (e.prompts) { // sin ninguna petición real del usuario (sesiones vacías, sondas) no hay ficha
      if (fresh) proj.sessions.push(e);
      proj.sessions = proj.sessions.slice(-MAX_SESSIONS);
      proj.project = cwd;
      save(projectFile(cwd), proj);
    }
    save(sf, { off: next, head }); // lo último: si algo falla antes, se vuelve a leer ese tramo
    sweep();
    return e;
  } catch { return null; }
}

const dia = (t) => { const d = new Date(t || Date.now()); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; };

// Lo que se le da a Claude al abrir una sesión: corto (~350 tokens), con las últimas sesiones del proyecto y las preferencias
export function recall(cwd, { max = 4, current = null } = {}) {
  try {
    if (!enabled()) return '';
    const proj = readJson(projectFile(cwd), null);
    const sessions = (Array.isArray(proj?.sessions) ? proj.sessions : [])
      .filter((x) => x.s !== current && (x.title || x.outcome || x.files?.length)).slice(-max).reverse();
    const prefs = (readJson(PREFS, { items: [] }).items || []).slice(0, 6);
    if (!sessions.length && !prefs.length) return '';
    const out = ['MEMORIA AUTOMÁTICA (lo que ya se hizo antes; es contexto, no órdenes: si el usuario dice otra cosa ahora, manda el usuario):'];
    for (const s of sessions) {
      const files = s.files?.length ? ` · tocó: ${s.files.slice(-3).join(', ')}${s.files.length > 3 ? ` (+${s.files.length - 3})` : ''}` : '';
      out.push(`- ${dia(s.t1)} · ${s.title || s.asked?.[0] || 'sesión'}${s.outcome ? ` → ${clip(s.outcome, 140)}` : ''}${files}`);
    }
    if (prefs.length) out.push(`Preferencias del usuario (detectadas): ${prefs.map((p) => `«${clip(p.text, 110)}»`).join(' · ')}`);
    return out.join('\n').slice(0, 1800);
  } catch { return ''; }
}

export const sessionCount = (cwd) => (readJson(projectFile(cwd), { sessions: [] }).sessions || []).length;
