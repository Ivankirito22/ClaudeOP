// Tamaño actual del contexto de la sesión: lo que se reenvía en CADA turno (entrada + caché) según el último mensaje del asistente.
// Lee solo el final del transcript, así que cuesta lo mismo con una sesión de 10 MB que con una de 10 KB.
import fs from 'node:fs';

const TAIL = 256 * 1024;

export function contextTokens(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TAIL);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"usage"')) continue;
        let j; try { j = JSON.parse(lines[i]); } catch { continue; }
        const u = j.type === 'assistant' && !j.isSidechain && j.message && j.message.usage;
        if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      }
    } finally { fs.closeSync(fd); }
  } catch { /* sin transcript: sin aviso */ }
  return 0;
}

const WARN_FROM = 120000; // primer aviso
const WARN_STEP = 60000; // y luego uno por cada tramo más

// Devuelve el aviso (o '') y el tramo ya avisado, para no repetirlo en cada mensaje
export function contextWarning(tokens, lastBucket = 0) {
  if (tokens < WARN_FROM) return { text: '', bucket: 0 };
  const bucket = 1 + Math.floor((tokens - WARN_FROM) / WARN_STEP);
  if (bucket <= lastBucket) return { text: '', bucket: lastBucket };
  const k = Math.round(tokens / 1000);
  return {
    bucket,
    text: `[claudeop · coste] El contexto pesa ~${k}k tokens y se reenvía en CADA mensaje: es lo que más gasta. Actualiza ya .claude/claudeop/estado.md (criterio de «hecho», hecho, pendiente) por si se compacta, avisa al usuario en UNA línea de que la conversación es larga, y no leas archivos grandes ni pegues salidas largas.`,
  };
}
