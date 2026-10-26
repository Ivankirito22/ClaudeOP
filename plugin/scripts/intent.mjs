// Reconoce, en lo que escribes, los flujos que encajan ("optimiza el código" → Optimizar proyecto). Todo local y gratis: no llama a ningún modelo.

export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// weak: solo cuenta si aparece al principio de una frase de 6+ palabras que no es pregunta (verbos muy genéricos: "haz", "añade"…; así un cambio pequeño no dispara un flujo grande)
const P = (re, weak = false) => ({ re, weak });

const PATTERNS = {
  '/rendimiento': [P(/\b(rendimiento|performance|cuellos? de botella|bottlenecks?|va lento|esta lento|muy lento|lag|fps|tarda (mucho|demasiado))\b/)],
  '/optimizar': [P(/\boptimi[zc]\w*/), P(/\bmejora(r|me)? (el |la |todo el )?(codigo|proyecto|calidad)/)],
  '/limpiar': [P(/(codigo muerto|dead code|sin usar|no usad[oa]s?)/), P(/\blimpia(r)? (el )?(codigo|proyecto|imports)/)],
  '/md': [P(/claude\.md/), P(/\bcrea(r)? (un )?(archivo )?md\b/)],
  '/explicar': [P(/\bexplica(me|r)? (el )?(proyecto|repo|repositorio|todo)\b/), P(/como esta (organizado|estructurado)/), P(/por donde (empiezo|empezar)/)],
  '/probar': [P(/\b(ejecuta|corre|lanza|pasa)\w* (los |todos los )?(tests?|pruebas)/), P(/\bcompila\b/), P(/\b(haz|hacer) (un )?build\b/)],
  '/tests': [P(/\b(genera|escribe|crea|anade|agrega|haz)\w* (los |unos |mas |nuevos )?(tests?|pruebas unitarias)/)],
  '/documentar': [P(/\bdocumenta\w*/), P(/\banade comentarios/), P(/\bcomenta (el )?codigo/), P(/\b(jsdoc|docstrings?)\b/)],
  '/bugprofundo': [P(/\b(bugs?|crash|petar|peta|se rompe|se cuelga|no funciona|no va|falla|arregla\w*|soluciona\w*|depura\w*)\b/), P(/\b(errors?|errores|fallo|excepcion)\b/, true)],
  '/revisar': [P(/\brevisa\w*/), P(/\b(review|code review)\b/), P(/revision de codigo/)],
  '/seguridad': [P(/(seguridad|vulnerab|security|owasp|inyeccion|\bxss\b)/)],
  '/auditoria': [P(/\baudit\w*/), P(/(revision|analisis) completa?/)],
  '/refactor': [P(/\b(refactor\w*|reestructura\w*|reorganiza\w*)/)],
  '/decidir': [P(/(que|cual) (libreria|framework|herramienta|opcion|base de datos|enfoque) (usar|elegir|es mejor)/, true), P(/\b(compara\w*|elige entre|pros y contras)\b/, true)],
  '/pulir': [P(/\bpul(e|ir|o)\b|\bpule\w*/), P(/segunda pasada|repasa lo ultimo|toque final/)],
  '/release': [P(/\brelease\b/), P(/prepara (la |una )?(version|entrega|release)/), P(/\bchangelog\b|sacar version|publicar version/)],
  '/plugins': [P(/\bplugins?\b/), P(/servidores? mcp|\bmcp\b/)],
  '/investigar': [P(/\binvestiga\w*/), P(/busca (en )?(la )?(web|internet)/), P(/documentacion oficial/)],
  '/feature': [
    P(/\b(modela\w*|modelame|renderiza\w*|anima(r|me)?)\b/),
    P(/\bdisena\w* (un |una |el |la |los |las )?(modelo|personaje|nivel|pantalla|menu|interfaz|escena|sistema)/),
    P(/\b(crea|creame|crear|haz|hazme|hacer|anade|anademe|anadir|agrega|implementa\w*|construye\w*|genera\w*|desarrolla\w*|programa\w*|make|build|add|implement|create)\b/, true),
  ],
};

// Cuando una frase encaja con varios, el más específico gana
const SUPERSEDES = {
  '/rendimiento': ['/optimizar'],
  '/optimizar': ['/limpiar'],
  '/tests': ['/feature', '/probar'],
  '/documentar': ['/feature'],
  '/md': ['/feature', '/documentar'],
  '/auditoria': ['/revisar', '/seguridad'],
  '/refactor': ['/feature'],
  '/bugprofundo': ['/feature'],
};

// Orden de trabajo: primero lo que construye, luego lo que comprueba, al final la release
const RANK = ['/feature', '/bugprofundo', '/refactor', '/decidir', '/investigar', '/limpiar', '/optimizar', '/rendimiento', '/tests', '/documentar', '/md', '/plugins', '/explicar', '/probar', '/revisar', '/seguridad', '/auditoria', '/pulir', '/release'];
const rank = (cmd) => { const i = RANK.indexOf(cmd); return i < 0 ? 50 : i; };

export const MAX_FLOWS = 4;

// Devuelve los cmd reconocidos en `text` (sin tocar nada más)
export function detectCmds(text) {
  const t = norm(text);
  if (!t.trim()) return [];
  const question = /\?\s*$/.test(t) || /^[\s¿]*(que|como|por que|donde|cual|cuando|quien|cuanto)\b/.test(t);
  const found = new Set();
  for (const [cmd, pats] of Object.entries(PATTERNS)) {
    for (const { re, weak } of pats) {
      const m = re.exec(t);
      if (!m) continue;
      if (weak && (question || m.index > 40 || t.trim().split(/\s+/).length < 6)) continue;
      found.add(cmd);
      break;
    }
  }
  for (const [winner, losers] of Object.entries(SUPERSEDES)) {
    if (found.has(winner)) for (const l of losers) found.delete(l);
  }
  return [...found].sort((a, b) => rank(a) - rank(b));
}
