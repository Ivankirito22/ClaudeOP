// Núcleo de los hooks de claudeop: inventario de lo que hay instalado (agentes, skills, MCP, flujos propios)
// y reconocimiento por contexto. Todo local y sin llamar a ningún modelo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { detectStack } from './stack.mjs';
import { norm } from './intent.mjs';
import { DATA, readJson } from './data.mjs';

export const NAME = 'claudeop';
const HOME = os.homedir();
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const CFG_JSON = process.env.CLAUDE_CONFIG_DIR ? path.join(CFG, '.claude.json') : path.join(HOME, '.claude.json');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

// ---------- Frontmatter (solo lo que necesitamos: clave: valor y bloques | >) ----------
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)(?:\r?\n---|$)/.exec(text);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const km = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!km) continue;
    let v = km[2];
    if (v === '' || /^[|>][+-]?$/.test(v.trim())) {
      const buf = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) buf.push(lines[++i].trim());
      v = buf.join(' ');
    }
    out[km[1]] = v.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return out;
}

function head(file, n = 6000) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(n);
    const len = fs.readSync(fd, b, 0, n, 0);
    fs.closeSync(fd);
    return b.toString('utf8', 0, len);
  } catch { return ''; }
}

// ---------- Texto: normalizar, quitar relleno, raíz de 5 letras (sirve para es/en: optimiza≈optimize) ----------
const STOP = new Set(('de la el los las un una unos unas y o u e a en con por para que como mi mis tu tus su sus al del lo le les se me te nos ' +
  'es son ser esta este esto estos estas eso esa ese hay no si ya muy mas pero sin sobre todo toda todos todas quiero necesito puedes puedo ' +
  'haz hazme hacer crea crear usa usar usando quisiera favor ahora luego tambien cuando donde cual cuales ' +
  'the and for with from that this you your are can use using make create want need please also when then into any all ' +
  'proyecto project codigo code archivo archivos file files cosa cosas algo ' +
  'x y z').split(/\s+/));

const stem = (w) => (w.length > 5 ? w.slice(0, 5) : w);
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w));
const stems = (s) => [...new Set(words(s).map(stem))];

// Español → raíces inglesas, porque casi todas las descripciones de agentes/skills están en inglés
const EXPAND = {
  '3d': ['blend', 'mesh', 'model', 'rende', 'sculp'],
  malla: ['mesh', 'model'], mallas: ['mesh', 'model'],
  rendi: ['perfo'], lento: ['perfo', 'slow'], lenta: ['perfo', 'slow'],
  segur: ['secur'], prueb: ['test'], revis: ['revie'], busca: ['searc'], inves: ['resea'],
  docum: ['docs', 'docum'], infor: ['repor'], graf: ['chart', 'graph', 'plot'], grafi: ['chart', 'graph', 'plot'],
  prese: ['prese', 'slide', 'deck', 'pptx'], diapo: ['slide', 'deck', 'pptx'],
  hoja: ['sprea', 'excel', 'xlsx'], calcu: ['sprea', 'excel', 'xlsx'], excel: ['xlsx', 'sprea'],
  corre: ['email', 'gmail', 'mail'], calen: ['calen'], reuni: ['meeti'],
  anunc: ['ad', 'video', 'adver'], video: ['video'], image: ['image', 'photo'], foto: ['photo', 'image'],
  dibuj: ['draw', 'desig'], disen: ['desig'], datos: ['data', 'datab'], tiend: ['shop', 'store', 'shopi'],
  pago: ['payme'], factu: ['invoi'], venta: ['sales'], marke: ['marke'], anali: ['analy'],
  pagin: ['page', 'web', 'site'], sitio: ['site', 'web'], naveg: ['brows', 'web'], scrap: ['scrap', 'web'], web: ['web', 'site'],
  word: ['docx', 'word'], pdf: ['pdf'], tradu: ['trans'], anima: ['anima'], audio: ['audio', 'sound'], musica: ['music', 'audio'], sonid: ['sound', 'audio'],
};
export const queryWords = (text) => [...new Set(words(text))];
export function queryStems(text) {
  const base = stems(text);
  const extra = [];
  for (const s of base) if (EXPAND[s]) extra.push(...EXPAND[s]);
  return [...new Set([...base, ...extra])];
}

// ---------- Descubrir plugins instalados ----------
function listPlugins() {
  // 1) La CLI es la fuente de verdad (qué está activado y dónde vive)
  try {
    const r = spawnSync('claude plugin list --json', { encoding: 'utf8', timeout: 20000, shell: true });
    const arr = r.status === 0 ? JSON.parse(r.stdout) : null;
    if (Array.isArray(arr) && arr.length) {
      return arr.filter((p) => p.enabled !== false && p.installPath && isDir(p.installPath))
        .map((p) => ({ id: p.id, dir: p.installPath, mcp: p.mcpServers || null }));
    }
  } catch { /* sin CLI: escaneo a mano */ }
  // 2) Plan B: recorrer las carpetas de plugins
  const dirs = [];
  const synced = path.join(CFG, 'plugins', 'synced');
  for (const g of ls(synced)) if (g.isDirectory()) for (const p of ls(path.join(synced, g.name))) if (p.isDirectory()) dirs.push(path.join(synced, g.name, p.name));
  const cache = path.join(CFG, 'plugins', 'cache');
  for (const m of ls(cache)) for (const p of ls(path.join(cache, m.name))) for (const v of ls(path.join(cache, m.name, p.name))) if (v.isDirectory()) dirs.push(path.join(cache, m.name, p.name, v.name));
  return dirs.map((dir) => ({ id: null, dir, mcp: null }));
}

function pluginName(p) {
  const j = readJson(path.join(p.dir, '.claude-plugin', 'plugin.json'));
  if (j?.name) return j.name;
  if (p.id) return p.id.split('@')[0];
  return path.basename(p.dir).replace(/~g\d+$/, '');
}

// ---------- Recoger agentes, skills y comandos ----------
function mdItems(dir, prefix, kind, { nested = false, depth = 2 } = {}) {
  const out = [];
  const visit = (d, lvl) => {
    for (const e of ls(d)) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (kind === 'skill') {
        if (e.isDirectory()) {
          const f = path.join(full, 'SKILL.md');
          if (fs.existsSync(f)) push(f, e.name); else if (nested && lvl < depth) visit(full, lvl + 1);
        }
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && !/^readme/i.test(e.name)) {
        push(full, e.name.replace(/\.md$/i, ''));
      } else if (e.isDirectory() && nested && lvl < depth) visit(full, lvl + 1);
    }
  };
  const push = (file, fallback) => {
    const fm = frontmatter(head(file));
    const name = fm.name || fallback;
    const desc = (fm.description || '').replace(/\s+/g, ' ').trim();
    if (!desc && kind !== 'command') return;
    out.push({ id: prefix ? `${prefix}:${name}` : name, name, d: desc.slice(0, 220), kind });
  };
  visit(dir, 0);
  return out;
}

function mcpFrom(j) {
  const s = j?.mcpServers || (j && !j.mcpServers && typeof j === 'object' ? j : null);
  return s && typeof s === 'object' ? Object.keys(s).filter((k) => typeof s[k] === 'object') : [];
}

// Palabras (raíces) que delatan para qué sirve un servidor MCP conocido; lo demás se reconoce por su nombre
const MCP_KW = {
  blender: ['3d', 'blend', 'mesh', 'malla', 'rende', 'sculp', 'textu', 'rigg', 'anima', 'shade'],
  godot: ['godot', 'gdscr'], unity: ['unity'], unreal: ['unrea'], roblox: ['roblo', 'luau'],
  playwright: ['playw', 'e2e', 'naveg', 'brows'], puppeteer: ['puppe', 'naveg', 'brows'],
  'browser-use': ['naveg', 'brows', 'scrap', 'captu', 'pagin'],
  supabase: ['supab', 'datab', 'sql', 'postg'], postgres: ['postg', 'sql', 'datab'], sqlite: ['sqlit', 'sql'],
  github: ['githu', 'pull', 'issue'], figma: ['figma'], notion: ['notio'], slack: ['slack'],
  shopify: ['shopi', 'tiend', 'store'], gmail: ['gmail', 'corre', 'email'], 'google-calendar': ['calen', 'agend', 'reuni'],
  'google-drive': ['drive'], stripe: ['strip', 'pago'], paypal: ['paypa'],
};
// Palabras de nombres de servidor que aparecen en cualquier frase y no dicen nada
const MCP_GENERIC = new Set(['close', 'data', 'box', 'hex', 'guru', 'docs', 'mcp', 'plugin', 'search', 'chat', 'google', 'ramp', 'clay']);

function collectMcp(cwd, plugins) {
  const out = [];
  const add = (name, prefix, src) => { if (!out.some((m) => m.prefix === prefix)) out.push({ name, prefix, src }); };
  const g = readJson(CFG_JSON) || {};
  for (const n of mcpFrom({ mcpServers: g.mcpServers })) add(n, `mcp__${n}__`, 'usuario');
  const proj = g.projects?.[cwd] || g.projects?.[cwd.replace(/\\/g, '/')];
  for (const n of mcpFrom({ mcpServers: proj?.mcpServers })) add(n, `mcp__${n}__`, 'proyecto');
  for (const n of mcpFrom(readJson(path.join(cwd, '.mcp.json')))) add(n, `mcp__${n}__`, 'proyecto');
  for (const p of plugins) {
    const pname = p.name;
    const names = new Set([...Object.keys(p.mcp || {}), ...mcpFrom(readJson(path.join(p.dir, '.mcp.json')))]);
    for (const n of names) add(n, `mcp__plugin_${pname}_${n}__`, pname);
  }
  return out.map((m) => ({
    ...m,
    w: [...new Set(words(m.name.replace(/[-_.]/g, ' ')))].filter((w) => !MCP_GENERIC.has(w)),
    t: [...new Set((MCP_KW[m.name.toLowerCase().replace(/_/g, '-')] || []).map(stem))],
  }));
}

// ---------- Flujos propios: ~/.claude/flows/*.md y <proyecto>/.claude/flows/*.md ----------
function customFlows(cwd) {
  const out = [];
  for (const dir of [path.join(CFG, 'flows'), path.join(cwd, '.claude', 'flows')]) {
    for (const e of ls(dir)) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
      const text = (() => { try { return fs.readFileSync(path.join(dir, e.name), 'utf8'); } catch { return ''; } })();
      const fm = frontmatter(text);
      const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
      if (!body) continue;
      const label = fm.name || e.name.replace(/\.md$/i, '');
      const triggers = String(fm.triggers || '').split(',').map((s) => norm(s).trim()).filter(Boolean);
      out.push({ label, desc: fm.description || '', body: body.slice(0, 3000), triggers, t: stems(`${label} ${fm.description || ''}`) });
    }
  }
  return out;
}

// ---------- Catálogo (se construye al abrir la sesión y se reutiliza en cada mensaje) ----------
const cacheFile = (cwd) => path.join(DATA, `catalog-${crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 12)}.json`);

// Última modificación de los ficheros donde Claude Code anota qué plugins hay y cuáles están activos
function configStamp(cwd) {
  const files = [path.join(CFG, 'settings.json'), path.join(CFG, 'plugins', 'known_marketplaces.json'), path.join(CFG, 'plugins', 'blocklist.json'),
    path.join(CFG, 'plugins'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')];
  return Math.max(0, ...files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }));
}

// maxAge > 0: reutiliza el catálogo de ese proyecto si es más reciente que maxAge (ms) y no ha cambiado la configuración de plugins
// desde que se hizo. Así se evita la llamada a la CLI de Claude (~1 s) en casi todas las sesiones.
export function buildCatalog(cwd, maxAge = 0) {
  if (maxAge) {
    const c = readJson(cacheFile(cwd));
    if (c && c.v === 2 && Date.now() - c.built < maxAge && c.built > configStamp(cwd)) return c;
  }
  const plugins = listPlugins().map((p) => ({ ...p, name: pluginName(p) })).filter((p) => p.name !== NAME);
  const seen = new Set();
  const items = [];
  const take = (arr) => { for (const it of arr) { if (!seen.has(it.kind + it.id)) { seen.add(it.kind + it.id); items.push(it); } } };

  // proyecto y usuario primero (tienen prioridad si se repite un nombre)
  for (const base of [path.join(cwd, '.claude'), CFG]) {
    take(mdItems(path.join(base, 'agents'), '', 'agent'));
    take(mdItems(path.join(base, 'skills'), '', 'skill', { nested: true }));
    take(mdItems(path.join(base, 'commands'), '', 'command'));
  }
  for (const p of plugins) {
    take(mdItems(path.join(p.dir, 'agents'), p.name, 'agent'));
    take(mdItems(path.join(p.dir, 'skills'), p.name, 'skill'));
    take(mdItems(path.join(p.dir, 'commands'), p.name, 'command'));
  }
  const flows = customFlows(cwd);

  for (const it of items) { it.t = stems(`${it.name.replace(/[-_:]/g, ' ')} ${it.d}`); it.n = stems(it.name.replace(/[-_:]/g, ' ')); }
  const df = {};
  for (const it of items) for (const w of it.t) df[w] = (df[w] || 0) + 1;
  const N = items.length || 1;
  const idf = {};
  for (const [w, c] of Object.entries(df)) idf[w] = Math.round(Math.log(1 + N / (1 + c)) * 100) / 100;

  const stack = detectStack(cwd);
  const cat = {
    v: 2, cwd, built: Date.now(), plugins: plugins.length,
    stack: { hints: stack.hints, summary: stack.summary },
    agents: items.filter((i) => i.kind === 'agent'),
    skills: items.filter((i) => i.kind !== 'agent'),
    mcp: collectMcp(cwd, plugins),
    flows, idf,
  };
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(cacheFile(cwd), JSON.stringify(cat)); } catch { /* sin caché: se reconstruirá */ }
  return cat;
}

export function loadCatalog(cwd) {
  const c = readJson(cacheFile(cwd));
  if (c && c.v === 2) return c;
  return buildCatalog(cwd);
}

// ---------- Puntuar recursos contra la petición ----------
// Una coincidencia suelta de una palabra común (p. ej. «model», «review») es ruido: se exigen ≥2 coincidencias y
// que una esté en el nombre (o ≥3), salvo skills de nombre único (pdf, pptx, docx…) cuya palabra aparece tal cual.
export function rankItems(items, idf, q, { max = 3, min = 6 } = {}) {
  if (!q.length) return [];
  const scored = [];
  for (const it of items) {
    const t = new Set(it.t);
    const n = new Set(it.n || []);
    let s = 0, hits = 0, nameHit = false;
    for (const w of q) {
      if (!t.has(w)) continue;
      hits++;
      const wt = idf[w] ?? 1.5;
      if (n.has(w)) { s += wt * 3; nameHit = true; } else s += wt;
    }
    const single = nameHit && n.size === 1;
    if ((hits >= 2 && s >= min && (nameHit || hits >= 3)) || single) scored.push({ it, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const top = scored[0]?.s || 0;
  return scored.filter((x) => x.s >= top * 0.6).slice(0, max).map((x) => x.it);
}

// MCP: por palabra completa del nombre del servidor, o por las palabras clave conocidas de su herramienta
export function rankMcp(servers, q, qw = []) {
  const qs = new Set(q);
  const ws = new Set(qw);
  const seen = new Set();
  return servers.filter((m) => {
    if (seen.has(m.name)) return false; // el mismo servidor suele venir en varios plugins
    if (!m.w.some((w) => ws.has(w)) && !m.t.some((w) => qs.has(w))) return false;
    seen.add(m.name);
    return true;
  });
}

