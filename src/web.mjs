// Interfaz web local (por defecto): un servidor en 127.0.0.1 + una página con botones que SÍ responden al clic.
// Sin dependencias: http + SSE. Seguridad: puerto aleatorio, token secreto, y se comprueban Host y Origin
// (esta página puede mandar a Claude a editar tus archivos, así que ninguna otra web debe poder hablar con ella).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', 'web', 'index.html');
const COLORS = new Set(['green', 'cyan', 'magenta', 'yellow', 'red', 'gray', 'white']);

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// {green-fg}texto{/} {bold}…{/bold} → <span class="c-green b">…</span> (el estado se reinicia con {/})
export function tagsToHtml(text) {
  let fg = null;
  let bold = false;
  let out = '';
  const re = /\{(open|close|bold|\/bold|\/|inverse|\/inverse|([a-z]+)-fg)\}/g;
  let last = 0;
  const emit = (t) => {
    if (!t) return;
    const cls = [fg ? 'c-' + fg : '', bold ? 'b' : ''].filter(Boolean).join(' ');
    const h = escHtml(t);
    out += cls ? `<span class="${cls}">${h}</span>` : h;
  };
  let m;
  while ((m = re.exec(text))) {
    emit(text.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m[1];
    if (tag === 'open') emit('{');
    else if (tag === 'close') emit('}');
    else if (tag === 'bold') bold = true;
    else if (tag === '/bold') bold = false;
    else if (tag === '/') { fg = null; bold = false; }
    else if (m[2] && COLORS.has(m[2])) fg = m[2];
    // inverse y desconocidas: se ignoran
  }
  emit(text.slice(last));
  return out;
}

function kindOf(raw) {
  const t = String(raw);
  if (/^\n?\{bold\}›/.test(t)) return 'user';
  if (/^\s*\{gray-fg\}⚙/.test(t)) return 'tool';
  if (/^\{(green|cyan|magenta|white)-fg\}● /.test(t)) return 'head';
  if (/^\{gray-fg\}── /.test(t)) return 'sep';
  if (/^\s*\{(green|cyan|magenta)-fg\}↳ /.test(t)) return 'deleg';
  return 'text';
}

// ---------- Abrir el navegador ----------
function exists(f) { try { return fs.existsSync(f); } catch { return false; } }

export function browserCommand(url, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const pf = env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env['LOCALAPPDATA'] || '';
    const candidates = [
      path.win32.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.win32.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.win32.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local && path.win32.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter(Boolean);
    const exe = candidates.find(exists);
    // Ventana propia sin barra de pestañas (se siente como una aplicación); si no hay Edge/Chrome, navegador por defecto
    if (exe) return { file: exe, args: [`--app=${url}`, '--window-size=1320,880'], shell: false };
    return { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url], shell: false };
  }
  if (platform === 'darwin') return { file: 'open', args: [url], shell: false };
  return { file: 'xdg-open', args: [url], shell: false };
}

function openBrowser(url) {
  const c = browserCommand(url);
  try {
    const child = spawn(c.file, c.args, { detached: true, stdio: 'ignore', windowsHide: false, shell: c.shell });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------- Servidor ----------
export async function startWeb({ cwd = process.cwd(), open = true, port = 0, idleMs = 60000, quiet = false } = {}) {
  const token = crypto.randomBytes(18).toString('hex');
  const clients = new Set();
  const logBuf = []; // últimas entradas del chat
  let seq = 0;
  let server = null;
  let idleTimer = null;
  let stateTimer = null;
  let url = '';

  const send = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* cliente cerrado */ } };
  const broadcast = (event, data) => { for (const c of clients) send(c, event, data); };

  const ui = {
    log(text = ' ') {
      const entry = { i: ++seq, k: kindOf(text), h: tagsToHtml(String(text).replace(/^\n+/, '')) };
      logBuf.push(entry);
      if (logBuf.length > 3000) logBuf.splice(0, logBuf.length - 2500);
      broadcast('log', entry);
    },
    setInput(text) { broadcast('input', { text: text || '' }); },
    focusInput() {},
    changed() {
      if (stateTimer) return;
      stateTimer = setTimeout(() => { stateTimer = null; broadcast('state', fullState()); }, 80);
    },
    quit() { shutdown(0); },
    shortcuts: 'Enter envía · Shift+Enter nueva línea · Ctrl+K busca una acción · Esc cancela la acción a medias',
  };

  const app = createApp(cwd, ui);
  const fullState = () => ({ s: app.snapshot(), menu: app.menu() });

  function shutdown(code = 0) {
    try { app.dispose(); } catch { /* nada */ }
    for (const c of clients) { try { c.end(); } catch { /* nada */ } }
    try { server && server.close(); } catch { /* nada */ }
    setTimeout(() => process.exit(code), 50).unref?.();
  }

  // Se cierra solo ~1 min después de cerrar la ventana (si no hay una tarea en marcha)
  function armIdle() {
    if (!idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function check() {
      if (clients.size > 0) return;
      if (app.session.busy || app.queueRunning) { idleTimer = setTimeout(check, 15000); return; }
      if (!quiet) console.log('\nVentana cerrada: claude-router se apaga. Vuelve a escribir  cla  cuando quieras.');
      shutdown(0);
    }, idleMs);
    idleTimer.unref?.();
  }

  function allowedHost(h) {
    const addr = server.address();
    return !!h && (h === `127.0.0.1:${addr.port}` || h === `localhost:${addr.port}`);
  }
  function allowedOrigin(o) {
    if (!o) return true; // peticiones del propio navegador a la misma origen en GET no traen Origin
    const addr = server.address();
    return o === `http://127.0.0.1:${addr.port}` || o === `http://localhost:${addr.port}`;
  }
  const tokenOk = (t) => {
    if (typeof t !== 'string' || t.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
  };

  const deny = (res, code, msg) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(msg); };
  const SEC_HEADERS = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 1_000_000) { reject(new Error('demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

  server = http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) return deny(res, 403, 'host no permitido');
      const u = new URL(req.url, 'http://x');

      if (req.method === 'GET' && u.pathname === '/') {
        if (!tokenOk(u.searchParams.get('t') || '')) return deny(res, 403, 'Abre claude-router con el comando  cla  (el enlace lleva una clave que cambia en cada arranque).');
        const html = fs.readFileSync(INDEX, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS });
        return res.end(html);
      }

      if (req.method === 'GET' && u.pathname === '/events') {
        if (!tokenOk(u.searchParams.get('t') || '') || !allowedOrigin(req.headers.origin)) return deny(res, 403, 'no autorizado');
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', ...SEC_HEADERS });
        res.write('retry: 1500\n\n');
        clients.add(res);
        clearTimeout(idleTimer);
        send(res, 'init', { ...fullState(), log: logBuf });
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* nada */ } }, 15000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
          if (clients.size === 0) armIdle();
        });
        return undefined;
      }

      if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
        if (!tokenOk(String(req.headers['x-token'] || '')) || !allowedOrigin(req.headers.origin) || !req.headers.origin) return deny(res, 403, 'no autorizado');
        if (!/^application\/json/.test(String(req.headers['content-type'] || ''))) return deny(res, 415, 'se espera JSON');
        const body = await readBody(req);
        const ok = (extra = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...SEC_HEADERS }); res.end(JSON.stringify({ ok: true, ...extra })); };
        switch (u.pathname) {
          case '/api/send': app.handle(String(body.text || '').slice(0, 200000)); return ok();
          case '/api/press': return ok({ found: app.press(String(body.id || '')) });
          case '/api/cancel': app.cancel(); return ok();
          case '/api/cancel-pending': app.cancelPending(); return ok();
          default: return deny(res, 404, 'no existe');
        }
      }
      return deny(res, 404, 'no existe');
    } catch (e) {
      try { deny(res, 400, 'petición no válida: ' + e.message); } catch { /* nada */ }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const addr = server.address();
  url = `http://127.0.0.1:${addr.port}/?t=${token}`;

  const onSig = () => shutdown(0);
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);

  app.boot();
  armIdle(); // si nadie llega a conectar, no se queda colgado

  if (!quiet) {
    console.log(`claude-router → ${url}`);
    console.log('Se abre en una ventana propia. Si no, copia ese enlace en el navegador. Ctrl+C aquí para cerrar.');
  }
  if (open) openBrowser(url);

  return { url, port: addr.port, token, app, close: () => shutdown(0) };
}
