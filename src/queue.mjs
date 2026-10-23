// Cola de tareas ("modo noche"): encolas instrucciones y se ejecutan una detrás de otra.
// Para si una falla, si la cancelas, o si el gasto estimado de la cola supera el tope.
export class TaskQueue {
  constructor(items = [], save = () => {}) {
    this.items = items.filter((i) => i && i.text);
    this.save = save;
    this.running = false;
    this.stopRequested = false;
  }

  add(text, opts = {}) {
    const t = String(text || '').trim();
    if (!t) return null;
    const item = { text: t, label: opts.label || null, main: opts.main || null };
    this.items.push(item);
    this.save(this.items);
    return item;
  }

  remove(n) {
    if (!Number.isInteger(n) || n < 1 || n > this.items.length) return null;
    const [it] = this.items.splice(n - 1, 1);
    this.save(this.items);
    return it;
  }

  clear() {
    const n = this.items.length;
    this.items = [];
    this.save(this.items);
    return n;
  }

  stop() { this.stopRequested = true; }

  // session: { run(prompt,opts), totalCost, busy } · hooks: before(item,i,total), after(item,res), between()
  async runAll(session, { limitUsd = null, before = () => {}, after = () => {}, between = async () => {} } = {}) {
    if (this.running) throw new Error('La cola ya se está ejecutando');
    this.running = true;
    this.stopRequested = false;
    const startCost = session.totalCost;
    const total = this.items.length;
    let done = 0;
    let stopReason = null;
    try {
      while (this.items.length) {
        if (this.stopRequested) { stopReason = 'detenida'; break; }
        if (limitUsd && session.totalCost - startCost >= limitUsd) { stopReason = `tope de ~$${limitUsd} alcanzado`; break; }
        const item = this.items[0];
        before(item, done + 1, total);
        const res = await session.run(item.text, { label: item.label || item.text.slice(0, 40), ...(item.main ? { main: item.main } : {}) }).then(() => session.lastRun || {}, (e) => ({ ok: false, error: e.message }));
        if (session.cancelled) { stopReason = 'cancelada por ti'; break; }
        if (res.ok === false) { stopReason = res.error ? `error: ${res.error}` : 'una tarea terminó con error'; after(item, res); break; }
        this.items.shift();
        this.save(this.items);
        done++;
        after(item, res);
        await between();
      }
    } finally {
      this.running = false;
    }
    return { done, total, remaining: this.items.length, cost: session.totalCost - startCost, stopReason };
  }
}
