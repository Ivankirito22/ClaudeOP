// Núcleo de claude-router.
// El modelo principal orquesta y delega en subagentes con otro modelo (Haiku / Sonnet / Opus)
// DENTRO del mismo prompt. Todo va por Claude Code (`claude -p`): usa tu login, sin API key.
import { FLOW_CATALOG } from './intent.mjs';
import { SPECIALISTS, specialistDefs } from './stack.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reminder } from './rules.mjs';
import { checkpoint } from './git.mjs';
import { docsIndex, digestState, firstRunPrefix, contextFiles, readable } from './docs.mjs';

export const MODELS = {
  haiku: process.env.CR_HAIKU || 'claude-haiku-5-5',
  sonnet: process.env.CR_SONNET || 'claude-sonnet-5-5',
  opus: process.env.CR_OPUS || 'claude-opus-5-5',
};
export const TIERS = ['haiku', 'sonnet', 'opus'];

export const tierOf = (model = '') =>
  /haiku/i.test(model) ? 'haiku' : /opus/i.test(model) ? 'opus' : /sonnet/i.test(model) ? 'sonnet' : 'other';

// ---------- Cómo se lanza `claude` (Windows usa claude.cmd => shell) ----------
const isWin = process.platform === 'win32';
const custom = process.env.CR_CLAUDE_BIN ? process.env.CR_CLAUDE_BIN.split(' ') : null; // solo para tests
const BIN = custom ? custom[0] : 'claude';
const BASE = custom ? custom.slice(1) : [];
const useShell = isWin && !custom;
const q = (a) => (useShell && (a === '' || /[\s"&|<>^%()]/.test(a)) ? `"${a.replace(/"/g, '\\"')}"` : a);

export function claudeCmd(args) {
  const all = [...BASE, ...args];
  return { file: BIN, args: useShell ? all.map(q) : all, shell: useShell };
}
function claudeSync(args) {
  const c = claudeCmd(args);
  return spawnSync(c.file, c.args, { shell: c.shell, encoding: 'utf8', timeout: 20000 });
}

export function getVersion() {
  const r = claudeSync(['--version']);
  if (r.error) return { installed: false, v: null, text: null };
  const m = String(r.stdout || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return { installed: true, v: m ? m.slice(1, 4).map(Number) : null, text: m ? m.slice(1, 4).join('.') : null };
}
export function atLeast(v, min) {
  if (!v) return true; // versión desconocida: asumimos que sí
  for (let i = 0; i < 3; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

export function authStatus() {
  const r = claudeSync(['auth', 'status']);
  if (r.error) return { installed: false, loggedIn: false };
  let info = {};
  try { info = JSON.parse(r.stdout); } catch { /* texto plano */ }
  return {
    installed: true,
    loggedIn: r.status === 0,
    method: info.authMethod || null,
    email: info.email || info.account?.email || null,
  };
}
export const authLogout = () => claudeSync(['auth', 'logout']);

// ---------- Subagentes ----------
const READ = ['Read', 'Grep', 'Glob', 'Bash'];

export function buildAgents(customAgents = {}) {
  const out = {
    explorador: {
      description: 'Read-only explorer (cheap). Searching/reading many files, listing usages, finding dead-code candidates, summarizing structure.',
      prompt: 'You are a fast read-only code explorer. Search and read what is asked, then return a concise, factual report with exact file paths and line numbers. Never modify files.',
      tools: READ,
      model: MODELS.haiku,
    },
    limpiador: {
      description: 'Mechanical editor (cheap). Removing dead code/unused imports/variables, formatting, renames, boilerplate, comments, simple find-and-replace refactors with exact instructions.',
      prompt: 'You perform precise mechanical edits exactly as instructed. Do not change behavior, do not redesign. Make minimal edits, then report briefly what you changed (file + what).',
      tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
      model: MODELS.haiku,
    },
    probador: {
      description: 'Test runner (cheap). Runs tests/build/lint and reports ONLY failures, so the main context stays small.',
      prompt: 'You run the requested tests/build/lint commands. Report: the command run, pass/fail, and for failures ONLY the failing test names plus the first relevant error lines (max 30 lines total). Never paste full logs. Do not modify files.',
      tools: READ,
      model: MODELS.haiku,
    },
    documentador: {
      description: 'Docs writer (cheap). Writes or updates comments, docstrings, README and other documentation from the code as it is.',
      prompt: 'You write concise, accurate documentation derived from the actual code. Do not change code behavior. Report which files you touched.',
      tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob'],
      model: MODELS.haiku,
    },
    investigador: {
      description: 'Web researcher (cheap). Looks things up online (docs, errors, libraries) and returns a short sourced summary.',
      prompt: 'You research the question on the web and return a short answer (max 15 lines) with the key facts and the source URLs. Prefer official documentation.',
      tools: ['WebSearch', 'WebFetch', 'Read'],
      model: MODELS.haiku,
    },
    revisor: {
      description: 'Code reviewer (mid-tier). Reviews diffs or risky changes for bugs, edge cases, security and readability. Read-only; returns a prioritized list.',
      prompt: 'You are a careful code reviewer. Examine the code/diff given, and return a prioritized list of concrete issues (file:line, problem, suggested fix). Do not modify files.',
      tools: READ,
      model: MODELS.sonnet,
    },
    depurador: {
      description: 'Root-cause debugger (mid-tier). Reproduces a failure, traces it to its real cause and proposes the minimal fix. Use before patching any non-obvious bug.',
      prompt: 'You are a methodical debugger. Reproduce the failure (run the failing command/test), form hypotheses, verify each with evidence from the code or by running small checks, and return: root cause (file:line), why it happens, and the smallest fix. Do not modify project files; temporary debug output must be removed or avoided.',
      tools: READ,
      model: MODELS.sonnet,
    },
    verificador: {
      description: 'Independent verifier (mid-tier). Final check that the finished work really satisfies the request and the done-criterion: reads the changes, runs build/tests if present, returns PASS/FAIL with concrete gaps.',
      prompt: 'You are an independent verifier who did NOT write this code. Given the request and the done-criterion, inspect the actual changes (git diff / files) and run available build/test commands. Return: verdict PASS or FAIL, then a short list of concrete gaps (file:line, what is missing or wrong). Be skeptical: do not assume it works. Do not modify files.',
      tools: READ,
      model: MODELS.sonnet,
    },
    arquitecto: {
      description: 'Deep-reasoning advisor (expensive). ONLY for hard decisions: architecture, tricky bugs, complex algorithms/performance, risky refactors. Read-only: returns a concrete plan.',
      prompt: 'You are a senior software architect. Analyze the problem deeply using the code, then return a concrete, step-by-step plan or diagnosis with exact files/functions to change. Do not modify files.',
      tools: READ,
      model: MODELS.opus,
    },
  };
  for (const [name, def] of Object.entries(customAgents || {})) {
    if (!def || !def.prompt || !def.description || name.startsWith('-')) continue;
    out[name] = {
      description: def.description,
      prompt: def.prompt,
      model: MODELS[def.model] || def.model || MODELS.sonnet,
      ...(def.tools ? { tools: def.tools } : {}),
    };
  }
  return out;
}

export const SUBAGENT_STYLE =
  'Return only what the caller needs: findings, file paths with line numbers, results. No preamble, no restating the task, no pleasantries. Max ~25 lines unless asked for more. Never paste large file contents or logs; summarize them.';

// ---------- Perfiles y política ----------
export const PROFILES = {
  balanced: {
    label: 'Equilibrado',
    main: 'sonnet',
    desc: 'Sonnet hace el trabajo normal, Haiku lo mecánico, Opus solo decisiones difíciles.',
    rules: 'Profile BALANCED: delegate mechanical/exploratory work to the haiku agents; call arquitecto only for genuinely hard decisions.',
  },
  eco: {
    label: 'Económico',
    main: 'sonnet',
    desc: 'Máximo ahorro: casi todo lo mecánico a Haiku, preguntas rápidas con Haiku de principal, Opus solo si ya falló un intento.',
    rules: 'Profile ECONOMY: minimize cost. Delegate everything mechanical or exploratory to the haiku agents. Call arquitecto only after you already failed once on the same problem.',
  },
  quality: {
    label: 'Calidad',
    main: 'opus',
    desc: 'Opus de principal y revisión final; lo mecánico sigue yendo a Haiku para ahorrar.',
    rules: 'Profile QUALITY: you run on the strongest model. Still delegate mechanical edits and broad exploration to the haiku agents to save tokens, keep hard reasoning yourself, and finish by having revisor review all changes.',
  },
};

export const DEFAULT_ALLOW = [
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git branch:*)',
  'Bash(ls:*)', 'Bash(dir:*)', 'Bash(cat:*)', 'Bash(grep:*)', 'Bash(find:*)', 'Bash(node --version)',
  'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npm run build:*)', 'Bash(npm run lint:*)', 'Bash(npx tsc:*)',
  'Bash(pytest:*)', 'Bash(python -m pytest:*)', 'Bash(dotnet build:*)', 'Bash(dotnet test:*)',
  'Bash(mvn test:*)', 'Bash(mvn -q test:*)', 'Bash(gradle test:*)',
  'WebSearch', 'WebFetch',
];
export const DEFAULT_DENY = ['Bash(git push:*)', 'Bash(git reset --hard:*)', 'Bash(git clean:*)'];

export const effectiveVerify = (verify, profile) =>
  verify && verify !== 'auto' ? verify : profile === 'quality' ? 'siempre' : profile === 'eco' ? 'nunca' : 'auto';

const VERIFY_TEXT = {
  siempre: 'ALWAYS finish by delegating to verificador (plus probador when tests/build exist) to check the result against your done-criterion; fix what they report and state the verdict in one line.',
  auto: 'Finish by delegating to verificador when your change touches more than 2 files or is risky; for small edits just run probador if tests exist.',
  nunca: 'Skip the final verification step unless the user asks for it (economy mode), but still run probador when tests exist and the change is non-trivial.',
};

export function buildPolicy(profile, userName = 'tú', agents = buildAgents(), opts = {}) {
  const p = PROFILES[profile] || PROFILES.balanced;
  const { verify = 'auto', lessons = true, stack = '', blockPush = true, docs = '' } = opts;
  const list = Object.entries(agents)
    .map(([n, a]) => `- ${n} (${tierOf(a.model)}): ${a.description}`)
    .join('\n');
  const specialists = Object.keys(agents).filter((n) => SPECIALISTS[n]);
  return `You are the orchestrator of a cost-aware multi-model workflow. Inside the SAME user request you hand sub-steps to subagents that run on other models (Agent tool, subagent_type). Always pick the cheapest model that can do each sub-step well.
${stack ? `Project stack: ${stack}.\n` : ''}
Available subagents:
${list}

Routing rules (MUST follow; doing a cheap-tier job yourself wastes the user's money):
- Broad reading/searching/summarizing: explorador. Do not read many files yourself.
- Mechanical edits (dead code, unused imports, renames, formatting): limpiador, with exact paths and the exact change.
- Running tests/build/lint: probador (it reports only failures).
- Docs/comments/README: documentador. Web lookups: investigador.
- Non-obvious bug: depurador finds the root cause BEFORE you patch. Reviewing a diff or risky change: revisor.
- Hard decisions (architecture, tricky bugs, complex algorithms/performance, risky refactors): arquitecto. Ask for a concrete plan, then implement it yourself or hand the mechanical parts to limpiador. If the user says something already failed, consult arquitecto before retrying.
${specialists.length ? `- Specialists loaded ONLY for this request because it touches their technology (${specialists.join(', ')}): hand them the implementation of more than ~20 lines in their language/tool, in parallel with each other when they work on different files, with complete instructions; then review their result yourself. They are not otherwise available.\n` : ''}- You (the main model) do the normal implementation work and the final integration.
${p.rules}

Parallelism: when sub-steps are independent (e.g. probador + revisor, several explorador queries, several investigador lookups), issue ALL their Agent calls in ONE message so they run at the same time. Never run in parallel agents that edit the same files.

${FLOW_CATALOG}

Quality loop: for any non-trivial task, first state in ONE line the "done" criterion; at the end check it. ${VERIFY_TEXT[effectiveVerify(verify, profile)]}

Delegation rules: do not delegate trivial one-step work. Subagents do not see this conversation, so give each one complete, self-contained instructions. Verify subagent results before reporting. Announce each delegation in one short line.
${docs ? `\nProject documentation (MD files; CLAUDE.md and .claude/contexto.md are loaded automatically when present):\n${docs}\nRead the ones relevant to the task BEFORE touching that area (use explorador when several are needed, never read them all yourself). If your change makes a document wrong (commands, structure, API, behavior), update it in the same task (documentador).\n` : ''}${lessons ? '\nLessons: when you fix a bug or discover a project pitfall, append ONE line (max 120 chars, no duplicates) to .claude/lecciones.md (create it if missing). Read it only if the task touches that area.\n' : ''}${blockPush ? '\nSafety: git push, reset --hard and clean are disabled in this session. If one is needed, tell the user to run it themselves. A checkpoint of the folder is saved before every instruction, so the user can undo your changes.\n' : ''}
Token hygiene: never re-read files already read in this session; Grep/Glob first, then Read with offset/limit; never print whole large files or logs (summarize with line numbers); batch independent tool calls; stop exploring once you have enough; keep answers short.

Style: reply in Spanish, informal, brief, results first. START EVERY reply to the user with "${userName}," (even short ones, after tool use, and in long sessions). The user relies on this to know you are still following these rules.`;
}

// ---------- Utilidades de prompt ----------
const QUICK_START = /^(qu[eé]|c[oó]mo|por qu[eé]|d[oó]nde|cu[aá]l(es)?|cu[aá]ndo|expl[ií]ca|para qu[eé]|what|how|why|where|which)(?![\p{L}\p{N}])/iu;
const EDIT_WORDS = /(arregla|crea|escribe|implementa|borra|elimina|cambia|refactor|a[ñn]ade|modifica|optimiza|instala|fix|create|write|implement|delete|remove|add|change)/i;
export const isQuick = (prompt) =>
  prompt.length < 160 && !prompt.includes('\n') && QUICK_START.test(prompt.trim().replace(/^[¿¡\s]+/, '')) && !EDIT_WORDS.test(prompt);

const ARCH_RE = /(dise[ñn]a (la |el )?(arquitectura|sistema)|redise[ñn]a|migra(r|ci[oó]n) (a|de|el|la)|desde cero|reescribe (todo|el proyecto)|refactoriza (todo|el proyecto))/i;
const FAILED_RE = /(sigue (fallando|sin funcionar|igual|roto)|otra vez (falla|mal|no)|no funciona (todav|a[uú]n)|still (fails|broken|not working))/i;

export function augmentPrompt(prompt, { reinforce = false, carry = null, name = 'tú', periodic = false, docsPrefix = null } = {}) {
  const notes = [];
  let text = prompt;
  if (FAILED_RE.test(prompt)) {
    text += '\n\n(Nota del router: esto ya falló antes; consulta a arquitecto antes de reintentar.)';
    notes.push('escalado a arquitecto');
  } else if (ARCH_RE.test(prompt)) {
    text += '\n\n(Nota del router: es una decisión de diseño grande; pide un plan a arquitecto antes de tocar código.)';
    notes.push('plan con arquitecto');
  }
  if (docsPrefix) { text = docsPrefix + '\n\n' + text; notes.push('leyendo los MDs del proyecto (explorador)'); }
  if (reinforce) { text = reminder(name) + '\n\n' + text; notes.push(periodic ? 'recordatorio periódico de reglas' : 'reglas reforzadas'); }
  if (carry) { text = 'Contexto de la conversación anterior (resumen):\n' + carry + '\n\n---\n' + text; notes.push('contexto resumido'); }
  return { text, notes };
}

export const COMPACT_PROMPT =
  'Resume esta conversación para continuarla en una sesión nueva sin perder nada importante. Máximo 250 palabras, en viñetas: objetivo actual, decisiones tomadas, archivos tocados y por qué, estado actual y pendientes exactos, y cualquier regla o preferencia que el usuario haya pedido. Sin preámbulos.';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function summarize(name, input = {}) {
  if (name === 'Bash') return String(input.command || '').slice(0, 90);
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern).slice(0, 60);
  return '';
}

// ---------- Sesión ----------
const TMP_DIRS = new Set(); // carpetas temporales de las sesiones; un solo listener las limpia al salir
process.on('exit', () => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* nada */ } }
});
export class Session extends EventEmitter {
  constructor({ cwd = process.cwd(), profile = 'balanced', permission = 'acceptEdits', settings = {}, customAgents = {}, stack = null } = {}) {
    super();
    this.cwd = cwd;
    this.profile = profile;
    this.permission = permission;
    // Por referencia: lo que cambie la interfaz (/nombre, /presupuesto, /verificar…) llega a Claude en la siguiente instrucción.
    const defaults = { userName: 'tú', compactAt: 150000, maxBudget: null, remindEvery: 5, verify: 'auto', lessons: true, checkpoints: true, blockPush: true, allow: [], contextDocs: true };
    for (const [k, v] of Object.entries(defaults)) if (settings[k] === undefined) settings[k] = v;
    this.settings = settings;
    this.stack = stack || { tags: [], hints: [], agents: {}, summary: '' };
    this.activeSpecialists = []; // especialistas cargados para la instrucción en curso
    this.extraAllow = []; // permisos añadidos con /permitir (por proyecto)
    this.sinceRemind = 0;
    this.runStats = null;
    this.lastRun = null;
    this.docs = []; // MDs del proyecto (los rellena la interfaz con scanDocs)
    this.customAgents = customAgents;
    this.sessionId = null;
    this.child = null;
    this.busy = false;
    this.silent = false;
    this.cancelled = false;
    this.carry = null; // resumen de la sesión compactada (se antepone a la siguiente instrucción)
    this.reinforce = false; // antepone un recordatorio de reglas a la siguiente instrucción
    this.compactions = 0;
    this.version = getVersion();
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-router-'));
    TMP_DIRS.add(this.tmp);
    this.costBase = 0;
    this.resetStats();
  }

  // Los especialistas solo existen durante la instrucción que toca su tecnología (cada subagente listado cuesta tokens)
  get agents() { return buildAgents({ ...specialistDefs(this.activeSpecialists), ...this.customAgents }); }
  get allowList() { return [...new Set([...DEFAULT_ALLOW, ...(this.settings.allow || []), ...this.extraAllow])]; }
  get totalCost() { return this.costBase + this.sessionCost; }

  resetStats() {
    this.msgUsage = new Map(); // message.id -> {tier, usage} (dedupe)
    this.agentByToolId = new Map();
    this.sessionCost = 0;
    this.lastCtx = 0;
  }

  newSession() {
    this.costBase = this.totalCost;
    this.sessionId = null;
    this.carry = null;
    this.sessionCost = 0;
    this.sinceRemind = 0;
    this.lastCtx = 0;
    this.agentByToolId.clear();
    this.emit('stats', this.stats);
  }

  get stats() {
    const tiers = { haiku: { msgs: 0, inp: 0, out: 0 }, sonnet: { msgs: 0, inp: 0, out: 0 }, opus: { msgs: 0, inp: 0, out: 0 }, other: { msgs: 0, inp: 0, out: 0 } };
    let cacheRead = 0;
    let inputAll = 0;
    for (const { tier, usage } of this.msgUsage.values()) {
      const t = tiers[tier] || tiers.other;
      const read = usage.cache_read_input_tokens || 0;
      const inp = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + read;
      t.msgs += 1;
      t.inp += inp;
      t.out += usage.output_tokens || 0;
      cacheRead += read;
      inputAll += inp;
    }
    return { tiers, cost: this.totalCost, cacheRatio: inputAll ? cacheRead / inputAll : 0, ctx: this.lastCtx };
  }

  supports(min) { return atLeast(this.version.v, min); }

  writeConfig() {
    const agents = this.agents;
    this.agentsFile = path.join(this.tmp, 'agents.json');
    this.policyFile = path.join(this.tmp, 'policy.txt');
    this.subStyleFile = path.join(this.tmp, 'subagent-style.txt');
    fs.writeFileSync(this.agentsFile, JSON.stringify(agents, null, 2));
    fs.writeFileSync(this.policyFile, buildPolicy(this.profile, this.settings.userName, agents, {
      verify: this.settings.verify, lessons: this.settings.lessons !== false, stack: this.stack.summary, blockPush: this.settings.blockPush !== false,
      docs: this.settings.contextDocs !== false ? docsIndex(this.docs) : '',
    }));
    fs.writeFileSync(this.subStyleFile, SUBAGENT_STYLE);
  }

  buildArgs(mainTier) {
    this.writeConfig();
    const args = [
      '-p',
      '--model', MODELS[mainTier],
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', this.permission,
      '--agents', this.agentsFile, // ruta a fichero: evita problemas de comillas en cmd
      '--append-system-prompt-file', this.policyFile,
    ];
    if (this.supports([2, 1, 211])) args.push('--forward-subagent-text');
    if (this.supports([2, 1, 257])) args.push('--system-prompt-snapshot', 'off'); // el cambio de perfil/nombre surte efecto al reanudar
    if (this.supports([2, 1, 261])) args.push('--append-subagent-system-prompt-file', this.subStyleFile); // subagentes escuetos: menos tokens en tu contexto
    if (this.supports([2, 1, 281])) args.push('--exclude-dynamic-system-prompt-sections'); // mejor reutilización de caché
    args.push('--allowedTools', this.allowList.join(','));
    if (this.settings.blockPush !== false) args.push('--disallowedTools', DEFAULT_DENY.join(','));
    if (this.settings.maxBudget) args.push('--max-budget-usd', String(this.settings.maxBudget));
    if (this.sessionId) args.push('--resume', this.sessionId);
    return args;
  }

  handleEvent(ev) {
    if (ev.session_id) this.sessionId = ev.session_id;

    if (ev.type === 'system' && ev.subtype === 'init') {
      if (!this.silent) this.emit('init', { model: ev.model });
      return;
    }

    if (ev.type === 'assistant') {
      const m = ev.message || {};
      const tier = tierOf(m.model);
      const parent = ev.parent_tool_use_id || null;
      const agent = parent ? this.agentByToolId.get(parent)?.agentType || 'subagente' : null;
      if (m.id) this.msgUsage.set(m.id, { tier, usage: m.usage || {} });
      if (this.runStats && m.id) this.runStats.msgs.set(m.id, { tier, sub: !!parent, out: m.usage?.output_tokens || 0 });
      if (!parent && m.usage) {
        this.lastCtx = (m.usage.input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0) + (m.usage.cache_read_input_tokens || 0);
      }
      if (this.runStats) {
        for (const b of m.content || []) {
          if (b.type !== 'tool_use' || this.runStats.seen.has(b.id)) continue;
          this.runStats.seen.add(b.id);
          if (b.name === 'Agent' || b.name === 'Task') {
            this.runStats.delegations++;
            this.runStats.delegList.push(b.input?.subagent_type || 'agente');
          } else if (EDIT_TOOLS.has(b.name)) {
            if (parent) this.runStats.subEdits++; else this.runStats.mainEdits++;
          }
        }
      }
      if (!this.silent) {
        this.emit('active', { tier, model: m.model, agent });
        for (const b of m.content || []) {
          if (b.type === 'text' && b.text && b.text.trim()) {
            this.emit('text', { tier, agent, text: b.text });
          } else if (b.type === 'tool_use') {
            if (b.name === 'Agent' || b.name === 'Task') {
              const info = { agentType: b.input?.subagent_type || 'agente', description: b.input?.description || '' };
              this.agentByToolId.set(b.id, info);
              this.emit('delegate', { ...info, expectedTier: tierOf(this.agents[info.agentType]?.model), from: agent });
            } else {
              this.emit('tool', { tier, agent, name: b.name, detail: summarize(b.name, b.input) });
            }
          }
        }
      }
      this.emit('stats', this.stats);
      return;
    }

    if (ev.type === 'result') {
      const before = this.sessionCost;
      if (typeof ev.total_cost_usd === 'number') this.sessionCost = ev.total_cost_usd;
      this.gotResult = true;
      this.lastResult = typeof ev.result === 'string' ? ev.result : '';
      if (this.runStats) {
        const rs = this.runStats;
        const out = { haiku: 0, sonnet: 0, opus: 0 };
        let total = 0;
        let sub = 0;
        for (const m of rs.msgs.values()) {
          if (out[m.tier] !== undefined) out[m.tier] += m.out;
          total += m.out;
          if (m.sub) sub += m.out;
        }
        const delta = this.sessionCost - rs.costStart;
        this.lastRun = {
          ok: !ev.is_error,
          error: !!ev.is_error,
          cost: delta >= 0 ? delta : this.sessionCost, // si el contador se reinicia, usa el valor tal cual
          out,
          delegated: total ? sub / total : 0,
          delegations: rs.delegations,
          delegList: rs.delegList,
          mainEdits: rs.mainEdits,
          subEdits: rs.subEdits,
          ms: ev.duration_ms,
          turns: ev.num_turns,
        };
        void before;
      }
      if (!this.silent) {
        this.emit('result', {
          isError: !!ev.is_error,
          text: ev.result,
          turns: ev.num_turns,
          ms: ev.duration_ms,
          cost: this.totalCost,
          run: this.lastRun,
          bigContext: this.lastCtx > this.settings.compactAt,
        });
      }
      this.emit('stats', this.stats);
    }
  }

  // Lanza claude y procesa su stream. Resuelve cuando termina el proceso.
  _exec(args, prompt) {
    return new Promise((resolve) => {
      let done = false;
      let stderr = '';
      let buf = '';
      const finish = (extra = {}) => {
        if (done) return;
        done = true;
        this.child = null;
        resolve({ stderr, ...extra });
      };
      let child;
      try {
        const c = claudeCmd(args);
        child = spawn(c.file, c.args, { cwd: this.cwd, shell: c.shell, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      } catch (e) {
        return finish({ code: -1, error: e.message });
      }
      this.child = child;
      const feed = (line) => {
        line = line.trim();
        if (!line) return;
        try { this.handleEvent(JSON.parse(line)); } catch { /* línea no JSON */ }
      };
      child.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          feed(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => finish({
        code: -1,
        error: e.code === 'ENOENT' ? 'No encuentro "claude". Instala Claude Code y comprueba que `claude` funciona en tu cmd.' : e.message,
      }));
      child.on('close', (code) => { feed(buf); finish({ code }); });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }

  _report(r) {
    if (this.cancelled) return this.emit('cancelled');
    if (r.error) return this.emit('failure', r.error);
    if (r.code !== 0 && !this.gotResult) {
      this.emit('failure', r.stderr.trim().split('\n').slice(-6).join('\n') || `claude terminó con código ${r.code}`);
    }
  }

  _begin() {
    if (this.busy) throw new Error('Ya hay una tarea en curso');
    this.busy = true;
    this.cancelled = false;
    this.gotResult = false;
    this.lastResult = '';
    this.runStats = null;
    this.emit('busy', true);
  }
  _end() {
    this.busy = false;
    this.silent = false;
    this.emit('busy', false);
  }

  async run(prompt, opts = {}) {
    this._begin();
    try {
      const prof = PROFILES[this.profile] || PROFILES.balanced;
      this.activeSpecialists = (opts.specialists || []).filter((k) => SPECIALISTS[k]).slice(0, 4);
      let main = opts.main || prof.main;
      let why = opts.main ? 'elegido por ti' : null;
      if (!opts.main && this.profile === 'eco' && isQuick(prompt)) { main = 'haiku'; why = 'pregunta rápida'; }

      // Red de seguridad: foto de la carpeta antes de que Claude toque nada
      if (this.settings.checkpoints !== false && opts.checkpoint !== false) {
        const label = 'antes: ' + (opts.label || prompt).replace(/\s+/g, ' ').slice(0, 60);
        let c = null;
        try { c = checkpoint(this.cwd, label); } catch { /* sin git: seguimos */ }
        this.emit('checkpoint', c);
      }

      // Recordatorio periódico de reglas: mejor prevenir la deriva que detectarla
      this.sinceRemind += 1;
      let periodic = false;
      if (!this.reinforce && this.sessionId && this.settings.remindEvery > 0 && this.sinceRemind >= this.settings.remindEvery) {
        this.reinforce = true;
        periodic = true;
      }
      // Primera instrucción de una sesión nueva sin resumen de contexto al día: lectura barata de los MDs con explorador (Haiku)
      let docsPrefix = null;
      if (this.settings.contextDocs !== false && !opts.noDocs && !this.sessionId && !this.carry && readable(this.docs).length && !digestState(this.cwd, this.docs).fresh) {
        docsPrefix = firstRunPrefix(this.docs, contextFiles(this.cwd));
      }
      const aug = augmentPrompt(prompt, { reinforce: this.reinforce, carry: this.carry, name: this.settings.userName, periodic, docsPrefix });
      if (this.reinforce) this.sinceRemind = 0;
      this.reinforce = false;
      this.carry = null;
      this.runStats = { msgs: new Map(), seen: new Set(), delegations: 0, delegList: [], mainEdits: 0, subEdits: 0, costStart: this.sessionCost };
      this.lastRun = null;
      this.emit('route', { main, why, notes: aug.notes, changed: main !== prof.main });
      const r = await this._exec(this.buildArgs(main), aug.text);
      this._report(r);
      if (!this.lastRun) this.lastRun = { ok: false, error: true, cost: 0, delegated: 0, delegations: 0, delegList: [], mainEdits: 0, subEdits: 0, out: { haiku: 0, sonnet: 0, opus: 0 }, ms: 0, turns: 0 };
      this.lastRun.label = opts.label || null;
    } finally {
      this.runStats = null;
      this._end();
    }
  }

  // Compactación propia: Haiku resume la sesión (sin herramientas) y la siguiente instrucción arranca limpia con ese resumen.
  async compact() {
    if (!this.sessionId) return null;
    this._begin();
    this.silent = true;
    this.emit('compacting');
    let summary = '';
    try {
      const args = ['-p', '--model', MODELS.haiku, '--output-format', 'stream-json', '--verbose', '--tools', '', '--resume', this.sessionId];
      const r = await this._exec(args, COMPACT_PROMPT);
      summary = (this.lastResult || '').trim();
      if (this.cancelled) this.emit('cancelled');
      else if (!summary) this.emit('failure', r.error || 'No pude resumir la sesión (resumen vacío).');
    } finally {
      this._end();
    }
    if (!summary) return null;
    this.costBase = this.totalCost;
    this.sessionCost = 0;
    this.sessionId = null;
    this.carry = summary;
    this.reinforce = true;
    this.sinceRemind = 0;
    this.lastCtx = 0;
    this.agentByToolId.clear();
    this.compactions += 1;
    this.emit('compacted', { chars: summary.length, summary });
    this.emit('stats', this.stats);
    return summary;
  }

  // Pregunta corta a Haiku, sin herramientas y sin tocar la sesión (para el enrutador). Devuelve el texto o null.
  classify(prompt, timeoutMs = 20000) {
    return new Promise((resolve) => {
      let child;
      let out = '';
      let buf = '';
      let result = null;
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.classifyChild = null;
        resolve(v);
      };
      const feed = (line) => {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result' && !ev.is_error) result = String(ev.result || '');
        } catch { /* no JSON */ }
      };
      try {
        const c = claudeCmd(['-p', '--model', MODELS.haiku, '--output-format', 'stream-json', '--verbose', '--tools', '']);
        child = spawn(c.file, c.args, { cwd: os.tmpdir(), shell: c.shell, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      } catch { return done(null); }
      this.classifyChild = child;
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ya terminó */ } done(null); }, timeoutMs);
      child.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { out = buf.slice(0, i).trim(); if (out) feed(out); buf = buf.slice(i + 1); }
      });
      child.on('error', () => done(null));
      child.on('close', () => { if (buf.trim()) feed(buf.trim()); done(result); });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }

  cancel() {
    if (this.classifyChild) { try { this.classifyChild.kill(); } catch { /* ya terminó */ } }
    if (!this.child) return false;
    this.cancelled = true;
    try {
      if (isWin) spawnSync('taskkill', ['/pid', String(this.child.pid), '/T', '/F']);
      else this.child.kill('SIGTERM');
    } catch { /* ya terminó */ }
    return true;
  }
}
