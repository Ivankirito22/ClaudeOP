// Avisos del sistema (toast de Windows, centro de notificaciones de macOS, notify-send en Linux).
// Los textos van por variables de entorno, nunca dentro del script: no hay inyección posible.
import { spawn } from 'node:child_process';

const WIN_SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  '$n = $t.GetElementsByTagName("text")',
  '$n.Item(0).AppendChild($t.CreateTextNode($env:CR_NT)) | Out-Null',
  '$n.Item(1).AppendChild($t.CreateTextNode($env:CR_NB)) | Out-Null',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($t)',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe").Show($toast)',
].join('; ');

export function notifyOS(title, body, { spawnFn = spawn, platform = process.platform } = {}) {
  if (process.env.CR_NO_NOTIFY) return false;
  const env = { ...process.env, CR_NT: String(title || 'claude-router').slice(0, 80), CR_NB: String(body || '').slice(0, 200) };
  try {
    let child;
    if (platform === 'win32') child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_SCRIPT], { env, stdio: 'ignore', windowsHide: true });
    else if (platform === 'darwin') child = spawnFn('osascript', ['-e', 'display notification (system attribute "CR_NB") with title (system attribute "CR_NT")'], { env, stdio: 'ignore' });
    else child = spawnFn('notify-send', [env.CR_NT, env.CR_NB], { env, stdio: 'ignore' });
    child.on('error', () => { /* sin notificaciones disponibles: no pasa nada */ });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
