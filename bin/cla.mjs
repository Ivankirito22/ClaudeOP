#!/usr/bin/env node
// Uso:  cla [carpeta]            abre el panel (web) para el proyecto de la carpeta actual
//       cla --terminal [carpeta] interfaz de texto en la consola (solo teclado)
//       cla --update             actualiza claude-router desde GitHub
//       cla --version | --help   ·   --no-open: no abrir el navegador   ·   --port N
import fs from 'node:fs';
import { currentVersion, runUpdate, checkUpdate, TARBALL } from '../src/update.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('-') && !['--port'].includes(args[i - 1]));

if (flag('--version') || flag('-v')) {
  console.log(`claude-router v${currentVersion()}`);
  process.exit(0);
}

if (flag('--help') || flag('-h')) {
  console.log(`claude-router v${currentVersion()}

  cla                  abre el panel con botones para la carpeta actual
  cla <carpeta>        igual, para otra carpeta
  cla --terminal       interfaz de texto en la consola (solo teclado)
  cla --update         actualiza desde GitHub
  cla --no-open        no abre el navegador (muestra el enlace)
  cla --version        versión instalada`);
  process.exit(0);
}

if (flag('--update')) {
  console.log(`Actualizando claude-router desde GitHub (v${currentVersion()} instalada)…`);
  const r = await runUpdate((l) => console.log('  ' + l));
  if (r.ok) {
    const u = await checkUpdate({ force: true });
    console.log(`\n✔ Listo${u?.latest ? ' (última versión publicada: v' + u.latest + ')' : ''}. Vuelve a escribir  cla  para usarla.`);
    process.exit(0);
  }
  console.error(`\nNo pude actualizar: ${r.error}\nPrueba a mano:  npm i -g ${TARBALL}`);
  process.exit(1);
}

const dir = positional[0];
if (dir) {
  if (!fs.existsSync(dir)) {
    console.error(`No existe la carpeta: ${dir}`);
    process.exit(1);
  }
  process.chdir(dir);
}

if (flag('--terminal')) {
  if (!process.stdout.isTTY) {
    console.error('El modo --terminal necesita una consola interactiva (cmd, PowerShell o Windows Terminal).');
    process.exit(1);
  }
  const { start } = await import('../src/tui.mjs');
  start(process.cwd());
} else {
  const { startWeb } = await import('../src/web.mjs');
  const port = Number(val('--port')) || 0;
  try {
    await startWeb({ cwd: process.cwd(), open: !flag('--no-open'), port, idleMs: process.env.CR_IDLE_MS !== undefined ? Number(process.env.CR_IDLE_MS) : 60000 });
  } catch (e) {
    console.error('No pude arrancar el panel: ' + e.message);
    process.exit(1);
  }
}
