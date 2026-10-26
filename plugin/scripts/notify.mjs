// Avisos del sistema (toast de Windows; también macOS y Linux) cuando Claude te necesita o termina, para que no tengas que mirar la terminal.
//   Notification  → Claude espera tu permiso, una respuesta o lleva un rato parado (los eventos de Claude Code ya esperan unos segundos,
//                   así que si estás delante y contestas no salta nada)
//   Stop          → ha terminado una petición larga (por defecto, más de 20 s; CLAUDEOP_NOTIFY_MIN_SEC)
//   StopFailure   → se ha detenido por un error
//   node notify.mjs test → manda un aviso de prueba
// Desactivar: CLAUDEOP_NOTIFY=off. Nunca incluye el contenido de tus mensajes ni de las respuestas: solo el motivo, el proyecto y la duración.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA, off, readJson, writeJson, sessionFile } from './data.mjs';
import { fmt } from './eta.mjs';

const MIN_SEC = Number(process.env.CLAUDEOP_NOTIFY_MIN_SEC) || 20;
const MINUTOS_10 = 10 * 60 * 1000;
const notifyFile = (id) => path.join(DATA, `notify-${String(id || 'x').replace(/[^\w-]/g, '')}.json`);

// Qué avisar para cada situación (o null si no merece aviso)
function describe(kind, input, st = {}, now = Date.now()) {
  const project = String(input.cwd || '').split(/[\\/]+/).filter(Boolean).pop() || 'proyecto';

  if (kind === 'stop') {
    if (Array.isArray(input.background_tasks) && input.background_tasks.length) return null; // aún hay subagentes trabajando
    const sec = st.t0 ? (now - st.t0) / 1000 : 0;
    if (sec < MIN_SEC || sec > 3 * 3600) return null;
    return { title: '✅ Claude ha terminado', body: `${project} · ${fmt(sec)}`, stop: true };
  }
  if (kind === 'error') return { title: '⚠️ Claude se ha detenido por un error', body: `${project} · mira la terminal` };

  switch (input.notification_type) {
    case 'permission_prompt': {
      const tool = /use (\S+)/i.exec(input.message || '')?.[1];
      return { title: '🔐 Claude necesita tu permiso', body: `${project} · ${tool ? `quiere usar ${tool}. ` : ''}Vuelve a la terminal para aprobar o rechazar.` };
    }
    case 'idle_prompt':
      if (now - (st.lastStop || 0) < MINUTOS_10) return null; // ya te avisamos de que terminó
      return { title: '⏳ Claude te está esperando', body: `${project} · terminó hace un rato y espera tu siguiente mensaje.` };
    case 'elicitation_dialog':
    case 'elicitation_url_dialog':
      return { title: '❓ Claude necesita una respuesta tuya', body: `${project} · ${String(input.message || 'Un servidor MCP te pide datos.').slice(0, 120)}` };
    case 'agent_needs_input':
      return { title: '🤖 Un agente necesita tu respuesta', body: `${project} · ${String(input.message || '').slice(0, 120)}`.trim() };
    case 'agent_completed':
      return { title: '✅ Un agente en segundo plano ha terminado', body: project };
    case 'auth_success': case 'elicitation_complete': case 'elicitation_response':
      return null; // confirmaciones sin interés
    default:
      return input.message ? { title: input.title || 'Claude Code', body: `${project} · ${String(input.message).slice(0, 140)}` } : null;
  }
}

const PS = `$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$t = [Security.SecurityElement]::Escape($env:CLAUDEOP_T); $b = [Security.SecurityElement]::Escape($env:CLAUDEOP_B)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)`;

// El título y el texto viajan por variables de entorno: nada de comillas ni inyección en el comando
function send({ title, body }) {
  if (process.env.CLAUDEOP_NOTIFY_LOG) { fs.appendFileSync(process.env.CLAUDEOP_NOTIFY_LOG, JSON.stringify({ title, body }) + '\n'); return true; }
  const env = { ...process.env, CLAUDEOP_T: title, CLAUDEOP_B: body };
  const opts = { env, stdio: 'ignore', windowsHide: true, timeout: 15000 };
  let r;
  if (process.platform === 'win32') {
    r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS, 'utf16le').toString('base64')], opts);
  } else if (process.platform === 'darwin') {
    r = spawnSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', '--', title, body], opts);
  } else {
    r = spawnSync('notify-send', ['--app-name=claudeop', title, body], opts);
  }
  return r.status === 0;
}

function main() {
  if (/^(off|0|false)$/i.test(process.env.CLAUDEOP_NOTIFY || '') || off()) return;
  const kind = process.argv[2];
  if (kind === 'test') {
    const ok = send({ title: '🔔 claudeop', body: 'Los avisos funcionan: te avisaré cuando Claude termine o te necesite.' });
    console.log(ok ? 'Aviso enviado.' : 'No se pudo enviar el aviso (¿notificaciones desactivadas o modo «No molestar»?).');
    return;
  }
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const sf = notifyFile(input.session_id);
  const st = { ...readJson(sf, {}), t0: readJson(sessionFile(input.session_id), {}).t0 };
  const msg = describe(kind, input, st);
  if (!msg) return;
  send(msg);
  if (msg.stop) writeJson(sf, { lastStop: Date.now() });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'notify.mjs') {
  try { main(); } catch { /* un hook nunca debe romper la sesión */ }
}
