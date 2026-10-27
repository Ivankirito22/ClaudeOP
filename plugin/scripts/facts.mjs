// Datos del proyecto que Claude no tiene que averiguar leyendo archivos: rama, cambios sin guardar y comandos de test/build.
// Una línea (~40 tokens) al abrir la sesión.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// -c core.fsmonitor=false: en un repositorio ajeno, git status no debe ejecutar el programa que configure ese repo
const git = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout: 1500, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};

export function projectFacts(cwd) {
  try { return facts(cwd); } catch { return ''; } // un dato de más nunca debe romper el arranque
}

function facts(cwd) {
  const parts = [];
  const branch = (git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').replace(/[^\w./@+-]/g, '').slice(0, 60);
  if (branch) {
    const dirty = (git(cwd, ['status', '--porcelain']) || '').split('\n').filter(Boolean).length;
    parts.push(`git: rama ${branch}${dirty ? `, ${dirty} archivo${dirty === 1 ? '' : 's'} sin commit` : ', limpio'}`);
  }
  try {
    const scripts = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts || {};
    const pm = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(cwd, 'yarn.lock')) ? 'yarn' : 'npm';
    const cmds = ['test', 'build', 'lint', 'dev', 'start'].filter((k) => scripts[k]).map((k) => `${k}=\`${pm}${k === 'test' || k === 'start' ? ` ${k}` : ` run ${k}`}\``);
    if (cmds.length) parts.push(`comandos: ${cmds.join(' · ')}`);
  } catch { /* sin package.json */ }
  return parts.length ? `Proyecto → ${parts.join(' · ')}.` : '';
}
