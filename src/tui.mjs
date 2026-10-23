// Vista de terminal (blessed) sobre el controlador común. Se abre con `cla --terminal`.
// Ojo: en Windows el ratón NO llega a Node de forma fiable; la interfaz por defecto es la web (src/web.mjs).
// Aquí todo funciona con teclado: Tab/↑↓ para moverte por el menú, Enter para pulsar, Ctrl+B para ir al menú.
import { createRequire } from 'node:module';
import path from 'node:path';
import { TIERS } from './core.mjs';
import { createApp, COLOR, kfmt, bar, pct } from './app.mjs';

const require = createRequire(import.meta.url);
const blessed = require('blessed');

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SIDE_W = 32;

export function start(cwd = process.cwd()) {
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: 'claude-router',
    ignoreLocked: ['C-c', 'C-q', 'C-x', 'C-l', 'C-b'], // funcionan aunque estés escribiendo
  });

  const header = blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: 1, tags: true, style: { bg: 'blue', fg: 'white' } });
  const sidebar = blessed.box({
    parent: screen, top: 1, left: 0, width: SIDE_W, height: '100%-4',
    border: 'line', label: ' Acciones (Ctrl+B · ↑↓ · Enter) ', tags: true,
    scrollable: true, alwaysScroll: true,
    scrollbar: { ch: ' ', style: { bg: 'cyan' } },
    style: { border: { fg: 'gray' } },
  });
  const panel = blessed.box({
    parent: screen, top: 1, left: SIDE_W, right: 0, height: 5,
    border: 'line', label: ' Modelos y memoria ', tags: true, style: { border: { fg: 'gray' } },
  });
  const logBox = blessed.log({
    parent: screen, top: 6, left: SIDE_W, right: 0, bottom: 3,
    border: 'line', label: ' Chat ', tags: true,
    scrollable: true, alwaysScroll: true, mouse: true, scrollOnInput: true,
    scrollbar: { ch: ' ', style: { bg: 'cyan' } },
    style: { border: { fg: 'gray' } },
  });
  const input = blessed.textbox({
    parent: screen, bottom: 0, left: 0, right: 0, height: 3,
    border: 'line', label: ' Tu instrucción · Enter envía · ↑↓ historial · Ctrl+B menú · Ctrl+X cancela · Ctrl+Q sale · /ayuda ',
    keys: true, mouse: true,
    style: { border: { fg: 'cyan' } },
  });

  let spin = 0;
  let spinTimer = null;
  const hist = [];
  let hi = 0;
  let snap = null;
  let menuMode = false; // true = el teclado maneja el menú
  let cursor = 0; // fila del menú seleccionada
  let rows = []; // [{ kind:'group'|'item', group, item }]
  let groupsState = {}; // name -> open
  let boxes = [];

  const log = (t = ' ') => {
    for (const line of String(t).split('\n')) logBox.log(line === '' ? ' ' : line);
    screen.render();
  };
  const focusInput = () => setImmediate(() => { if (menuMode) return; if (!input._reading) input.readInput(); screen.render(); });

  const ui = {
    log,
    setInput: (v) => { input.setValue(v || ''); },
    focusInput,
    changed: () => { render(); },
    quit: () => { screen.destroy(); process.exit(0); },
    spawn: (file, args, opts) => screen.spawn(file, args, opts),
    usePrefill: true,
    verboseTray: true,
    shortcuts: 'Ctrl+B menú (↑↓ Enter, Espacio pliega) · Ctrl+X cancela · Ctrl+L limpia el chat · Ctrl+Q sale · ↑↓ historial · AvPág desplaza',
  };

  const app = createApp(cwd, ui);

  // ---------- Pintado ----------
  function renderHeader() {
    const s = snap;
    const authBadge = !s.auth.installed ? '{red-fg}● claude no encontrado{/}'
      : s.auth.loggedIn ? `{green-fg}● sesión ${s.auth.method || 'activa'}{/}` : '{red-fg}● sin login{/}';
    const live = s.busy
      ? `${SPIN[spin % SPIN.length]} {${COLOR[s.active?.tier || 'other']}-fg}${s.active ? s.active.tier : 'pensando'}${s.active?.agent ? ' · ' + s.active.agent : ''}{/}`
      : s.pending?.main ? `{${COLOR[s.pending.main]}-fg}próxima: ${s.pending.main}{/}` : s.queueRunning ? '{yellow-fg}cola…{/}' : '{gray-fg}en espera{/}';
    const where = blessed.escape(path.basename(cwd) || cwd) + (s.stack ? ` {gray-fg}(${blessed.escape(s.stack)}){/}` : '');
    header.setContent(` {bold}claude-router{/bold} v${s.version}  ${where}  |  {bold}${s.profile.label}{/bold}  |  ${s.permission}  |  ${authBadge}  |  ${live}${s.tray.length ? '  |  {green-fg}bandeja: ' + blessed.escape(s.tray.map((t) => t.label).join(' + ')) + '{/}' : ''}${s.update ? '  |  {yellow-fg}⬆ ' + s.update + '{/}' : ''}`);
  }

  function renderPanel() {
    const s = snap;
    const narrow = screen.width - SIDE_W < 84;
    const tiers = s.tiers.map((t) => `{${COLOR[t.tier]}-fg}● ${t.tier}{/} ${t.msgs}${narrow ? 'm' : ' ' + bar(t.share, 5)} ${kfmt(t.out)}`).join(narrow ? '  ' : '   ');
    const ratio = s.ctx / s.compactAt;
    const cc = ratio >= 1 ? 'red' : ratio >= 0.6 ? 'yellow' : 'green';
    let deleg = '{gray-fg}delegado: sin datos{/}';
    if (s.delegated) {
      const dc = s.delegated.n === 0 ? 'gray' : s.delegated.pct >= 0.3 ? 'green' : 'yellow';
      deleg = `deleg. {${dc}-fg}${pct(s.delegated.pct)}{/} (${s.delegated.n} subag.)`;
    }
    const d = s.drift;
    const status = d.total === 0 ? '{gray-fg}sin datos{/}' : d.level === 0 ? '{green-fg}✔ ok{/}' : d.level === 1 ? '{yellow-fg}⚠ 1 fallo{/}' : `{red-fg}✖ ${d.strikes} fallos{/}`;
    panel.setContent([
      tiers,
      `{gray-fg}~$${s.cost.toFixed(2)} · caché ${Math.round(s.cacheRatio * 100)}%{/}   ctx {${cc}-fg}${kfmt(s.ctx)}{/}${narrow ? '' : ' ' + bar(Math.min(ratio, 1), 8)}   ${deleg}`,
      `nombre «${blessed.escape(s.userName)}» ${status}   ${s.repo ? `{green-fg}git ✔{/} ${s.ckptCount} fotos` : '{yellow-fg}sin git{/}'}   cola ${s.queueLen}   verif. ${s.verify}${narrow ? '' : `   recuerdo c/${s.remindEvery || '—'}`}`,
    ].join('\n'));
  }

  // ---------- Menú lateral (teclado) ----------
  function buildMenu() {
    const groups = app.menu();
    for (const g of groups) if (!(g.name in groupsState)) groupsState[g.name] = g.open;
    rows = [];
    for (const g of groups) {
      rows.push({ kind: 'group', group: g });
      if (groupsState[g.name]) for (const it of g.items) rows.push({ kind: 'item', group: g, item: it });
    }
    for (const b of boxes) b.destroy();
    boxes = rows.map((r, i) => {
      const b = blessed.box({ parent: sidebar, top: i, left: 0, width: '100%-3', height: 1, tags: true, mouse: true, clickable: true });
      b.on('click', () => { cursor = i; activate(); });
      return b;
    });
    paintMenu();
  }
  function paintMenu() {
    rows.forEach((r, i) => {
      const sel = menuMode && i === cursor;
      const txt = r.kind === 'group'
        ? `{bold}{cyan-fg}${groupsState[r.group.name] ? '▾' : '▸'} ${blessed.escape(r.group.title.toUpperCase())}{/}`
        : ` ${r.item.inTray ? '{green-fg}✓{/} ' : ''}${blessed.escape(r.item.label)}`;
      boxes[i].setContent(sel ? `{inverse}${txt}{/inverse}` : txt);
    });
    screen.render();
  }
  function activate() {
    const r = rows[cursor];
    if (!r) return;
    if (r.kind === 'group') {
      groupsState[r.group.name] = !groupsState[r.group.name];
      app.setCollapsed(Object.keys(groupsState).filter((n) => !groupsState[n]));
      buildMenu();
    } else {
      setMenuMode(false);
      app.press(r.item.id);
    }
  }
  function setMenuMode(on) {
    menuMode = on;
    if (on) {
      if (input._reading) { input.cancel(); }
      sidebar.style.border.fg = 'cyan';
      screen.focusPop && screen.focusPop();
      sidebar.focus();
      paintMenu();
    } else {
      sidebar.style.border.fg = 'gray';
      paintMenu();
      focusInput();
    }
  }

  function render() {
    snap = app.snapshot();
    renderHeader();
    renderPanel();
    const labelsChanged = app.menu().flatMap((g) => g.items.map((i) => i.label + (i.inTray ? '+' : ''))).join('|');
    if (labelsChanged !== render.last) { render.last = labelsChanged; buildMenu(); } else screen.render();
  }

  // ---------- Eventos de la pantalla ----------
  app.session.on('busy', (b) => {
    clearInterval(spinTimer);
    if (b) spinTimer = setInterval(() => { spin++; if (snap) { renderHeader(); screen.render(); } }, 120);
  });

  input.on('submit', (val) => {
    input.clearValue();
    screen.render();
    const t = (val || '').trim();
    if (t) hist.push(t);
    app.handle(val);
    hi = hist.length;
    focusInput();
  });
  input.on('cancel', () => { if (!menuMode) focusInput(); });
  input.key(['pageup'], () => { logBox.scroll(-8); screen.render(); });
  input.key(['pagedown'], () => { logBox.scroll(8); screen.render(); });
  input.key(['up'], () => {
    if (!hist.length) return;
    hi = Math.max(0, hi - 1);
    input.setValue(hist[hi]);
    screen.render();
  });
  input.key(['down'], () => {
    if (!hist.length) return;
    hi = Math.min(hist.length, hi + 1);
    input.setValue(hist[hi] || '');
    screen.render();
  });
  screen.key(['C-b'], () => setMenuMode(!menuMode));
  screen.key(['escape'], () => { if (menuMode) setMenuMode(false); });
  screen.key(['up', 'k'], () => { if (menuMode) { cursor = (cursor - 1 + rows.length) % rows.length; paintMenu(); } });
  screen.key(['down', 'j'], () => { if (menuMode) { cursor = (cursor + 1) % rows.length; paintMenu(); } });
  screen.key(['enter', 'space'], () => { if (menuMode) activate(); });
  screen.key(['C-q', 'C-c'], () => app.quit());
  screen.key(['C-x'], () => app.cancel());
  screen.key(['C-l'], () => { logBox.setContent(''); screen.render(); });
  screen.on('mouse', (d) => {
    if (d.action !== 'wheelup' && d.action !== 'wheeldown') return;
    if (d.x < SIDE_W && d.y >= 1 && d.y < screen.height - 3) {
      sidebar.scroll(d.action === 'wheeldown' ? 3 : -3);
      screen.render();
    }
  });

  snap = app.snapshot();
  buildMenu();
  app.boot();
}
