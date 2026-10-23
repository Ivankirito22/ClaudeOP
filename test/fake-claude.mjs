#!/usr/bin/env node
// Imita a `claude` para probar el router sin gastar nada ni necesitar login.
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }
if (a[0] === 'mcp' || a[0] === 'plugin') {
  if (process.env.FAKE_MCP_LOG) fs.appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify(a) + '\n');
  if (process.env.FAKE_MCP_FAIL) { console.error('error: no se pudo'); process.exit(1); }
  if (a[1] === 'list') console.log('blender: uvx blender-mcp - ✓ Connected');
  else console.log('OK ' + a.join(' '));
  process.exit(0);
}
if (a[0] === 'auth' && a[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => setTimeout(run, Number(process.env.FAKE_SLOW || 0) * 1000));
async function run() {
  const out = (o) => console.log(JSON.stringify({ session_id: 'sess-1', ...o }));
  out({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' });

  // Enrutador (Haiku): devuelve JSON con el tipo de petición y los flujos que encajan (tolera faltas)
  if (input.includes('enrutador de un asistente')) {
    if (process.env.FAKE_ROUTER_LOG) { try { fs.appendFileSync(process.env.FAKE_ROUTER_LOG, JSON.stringify(a) + '\n'); } catch { /* nada */ } }
    if (process.env.FAKE_NO_FAST && a.includes('--strict-mcp-config')) { console.error("error: unknown option '--strict-mcp-config'"); process.exit(1); }
    if (process.env.FAKE_ROUTER_FAIL) process.exit(1);
    if (Number(process.env.FAKE_ROUTER_MS || 0)) { setTimeout(routerAnswer, Number(process.env.FAKE_ROUTER_MS)); return; }
    routerAnswer();
    return;
  }
  function routerAnswer() {
    const req = (input.split('<<<')[1] || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const flows = [];
    if (/optimi[zs]/.test(req)) flows.push('/optimizar');
    if (/\b(crea|creame|modela|modelo)\b/.test(req)) flows.push('/feature');
    const tech = [];
    if (/pyth[oó]n|\.py\b|pytest/.test(req)) tech.push('python');
    if (/c\+\+|\bcpp\b/.test(req)) tech.push('cpp');
    if (/c#|unity/.test(req)) tech.push('csharp');
    if (/\bcss\b|html/.test(req)) tech.push('web');
    if (/blender|bpy/.test(req)) tech.push('blender');
    if (/node/.test(req)) tech.push('node');
    const kind = /\?/.test(req) ? 'pregunta' : /color|rojo/.test(req) ? 'pequeno' : 'tarea';
    const txt = JSON.stringify({ kind, flows, tech });
    out({ type: 'assistant', message: { id: 'r1', model: 'claude-haiku-5-5', content: [{ type: 'text', text: txt }], usage: { input_tokens: 300, output_tokens: 20 } } });
    out({ type: 'result', subtype: 'success', is_error: false, result: txt, total_cost_usd: 0.0005, num_turns: 1, duration_ms: 300 });
  }

  // Modo resumen (compactación): sin herramientas
  if (a.includes('--tools')) {
    const sum = 'Resumen: objetivo X, archivos a.js, pendiente Y';
    out({ type: 'assistant', message: { id: 's1', model: 'claude-haiku-5-5', content: [{ type: 'text', text: sum }], usage: { input_tokens: 500, output_tokens: 30 } } });
    out({ type: 'result', subtype: 'success', is_error: false, result: sum, total_cost_usd: 0.001, num_turns: 1, duration_ms: 400 });
    return;
  }

  // Modos de prueba: FALLA => resultado con error; SOLOEDIT => el principal edita 5 veces sin delegar
  if (input.includes('FALLA')) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', total_cost_usd: 0.002, num_turns: 1, duration_ms: 100 });
    return;
  }
  // SOBREESCRIBE <ruta>: el principal intenta un Write; pasa por el guardia de verdad (src/guard.mjs)
  const ow = /SOBREESCRIBE (\S+)/.exec(input) || /reescribir entero (\S+?) y se bloque/.exec(input);
  if (ow) {
    const { decide } = await import('../src/guard.mjs');
    const r = process.env.CR_GUARD_DIR && a.includes('--settings') ? decide({ tool_name: 'Write', cwd: process.cwd(), tool_input: { file_path: ow[1] } }, process.env.CR_GUARD_DIR) : { allow: true };
    if (r.allow) fs.writeFileSync(ow[1], 'reescrito por Claude\n');
    out({ type: 'assistant', message: { id: 'w1', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'wr1', name: 'Write', input: { file_path: ow[1] } }], usage: { input_tokens: 50, output_tokens: 10 } } });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'wr1', is_error: !r.allow, content: r.allow ? 'ok' : r.reason }] } });
    const txt = r.allow ? 'Frivan, reescrito' : 'Frivan, no pude: me lo bloquearon';
    out({ type: 'assistant', message: { id: 'w2', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: txt }], usage: { input_tokens: 10, output_tokens: 5 } } });
    out({ type: 'result', subtype: 'success', is_error: false, result: txt, total_cost_usd: 0.01, num_turns: 2, duration_ms: 300 });
    return;
  }
  if (input.includes('SOLOEDIT')) {
    out({
      type: 'assistant',
      message: {
        id: 'e1', model: 'claude-sonnet-5-5',
        content: [1, 2, 3, 4, 5].map((n) => ({ type: 'tool_use', id: 'ed' + n, name: 'Edit', input: { file_path: `f${n}.js` } })),
        usage: { input_tokens: 100, output_tokens: 40 },
      },
    });
    out({ type: 'assistant', message: { id: 'e2', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Frivan, hecho solo' }], usage: { input_tokens: 10, output_tokens: 5 } } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Frivan, hecho solo', total_cost_usd: 0.05, num_turns: 2, duration_ms: 900 });
    return;
  }

  runDefault();
  async function runDefault() {
    const t0 = Date.now();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const gap = Number(process.env.FAKE_STEP_MS || 0);
    out({
      type: 'assistant',
      message: {
        id: 'm1', model: 'claude-sonnet-5-5',
        content: [
          { type: 'text', text: 'Voy a delegar. args: ' + a.join(' ') + ' || input: ' + input.slice(0, process.env.FAKE_ECHO ? 9000 : 400) },
          { type: 'tool_use', id: 'tb1', name: 'Bash', input: { command: 'npm test -- --reporter=dot' } },
          { type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'limpiador', description: 'Quitar código muerto', prompt: 'Borra los imports sin usar de a.js' } },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    });
    await sleep(gap);
    out({
      type: 'assistant', parent_tool_use_id: 'tu1',
      message: { id: 'm2', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: 'a.js' } }], usage: { input_tokens: 50, output_tokens: 10 } },
    });
    out({ type: 'user', parent_tool_use_id: 'tu1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] } });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tb1', content: 'tests ok' }] } });
    out({
      type: 'assistant', parent_tool_use_id: 'tu1',
      message: { id: 'm3', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'hecho' }], usage: { input_tokens: 60, output_tokens: 5 } },
    });
    await sleep(gap);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'hecho' }] } });
    const final = (input.includes('SINNOMBRE') ? 'Listo, sin nombre. ' : 'Frivan, listo. ') + input.slice(0, 40).replace(/\n/g, ' ');
    out({
      type: 'assistant',
      message: { id: 'm4', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: final }], usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 15 } },
    });
    out({ type: 'result', subtype: 'success', is_error: false, result: final, total_cost_usd: 0.0123, num_turns: 3, duration_ms: Date.now() - t0 });
  }
}
