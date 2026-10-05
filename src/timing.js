// Lap timing: laps, 3 sectors, live delta to best lap, ghost recording.
//
// Sector colours (one driver, so F1's "overall vs personal" becomes "record vs best lap"):
//   purple  new record for that sector (fastest valid time ever, kept per setup)
//   green   faster than the same sector of your best lap
//   yellow  slower than the same sector of your best lap
//   invalid the lap was already void (track limits or a reset): the time does not count

export class Timing {
  constructor(track, key = 'pedrezuela.best.v2') {
    this.key = key;
    this.dry = false; // demo sessions: times are shown but never saved
    this.track = track;
    this.L = track.length;
    this.s0 = track.s[track.sfIndex];
    this.sectors = [0, this.L / 3, (2 * this.L) / 3];
    this.reset();
    this.load();
  }

  // best laps are stored per setup (e.g. driver weight)
  setKey(key) { this.key = key; this.load(); }
  load() {
    try { this.best = JSON.parse(localStorage.getItem(this.key) || 'null'); } catch { this.best = null; }
    let r = null;
    try { r = JSON.parse(localStorage.getItem(this.key + '.sectors') || 'null'); } catch {}
    this.rec = Array.isArray(r) && r.length === 3 ? r.map((v) => (v > 0 ? v : Infinity)) : [Infinity, Infinity, Infinity];
    // saves from before sector records: the best lap's sectors are the starting records
    for (let k = 0; k < 3; k++) { const b = this.bestSector(k); if (b != null && b < this.rec[k]) this.rec[k] = b; }
  }
  clearSaved() {
    this.best = null; this.rec = [Infinity, Infinity, Infinity];
    try { localStorage.removeItem(this.key); localStorage.removeItem(this.key + '.sectors'); } catch {}
  }
  // duration of sector k in the saved best lap
  bestSector(k) {
    const b = this.best?.splits;
    if (!b || b.length < 2) return null;
    return k === 0 ? b[0] : k === 1 ? b[1] - b[0] : this.best.time - b[1];
  }
  // sum of the sector records: the lap you would do joining your best sectors
  recordSum() { return this.rec.every(Number.isFinite) ? this.rec[0] + this.rec[1] + this.rec[2] : null; }

  reset() {
    this.lapStart = null; this.prevRel = null; this.lap = 0;
    this.cur = { splits: [], trace: new Float32Array(Math.ceil(this.L) + 2).fill(NaN), ghost: [] };
    this.last = null; this.sector = 0; this.events = []; this.invalid = false; this.voidWhy = null; this.offTime = 0;
    this.sessionBest = null; // fastest valid lap of this session
  }

  rel(s) { return (s - this.s0 + this.L) % this.L; }

  update(t, kart, dt) {
    const rel = this.rel(kart.loc.s);
    if (this.prevRel !== null) {
      const crossed = this.prevRel > this.L - 30 && rel < 30;
      if (crossed) {
        if (this.lapStart !== null) this.finishLap(t);
        this.lapStart = t; this.lap++; this.sector = 0; this.invalid = false; this.voidWhy = null; this.offTime = 0;
        this.events.push({ type: 'newlap' });
        this.cur = { splits: [], trace: new Float32Array(Math.ceil(this.L) + 2).fill(NaN), ghost: [] };
      } else if (this.lapStart !== null) {
        for (let k = 1; k < 3; k++) {
          if (this.prevRel < this.sectors[k] && rel >= this.sectors[k] && this.cur.splits.length === k - 1) {
            const st = t - this.lapStart;
            this.cur.splits.push(st);
            this.sectorEvent(k - 1, st - (k > 1 ? this.cur.splits[k - 2] : 0));
            this.sector = k;
          }
        }
      }
    }
    this.prevRel = rel;
    if (this.lapStart !== null) {
      const lt = t - this.lapStart;
      const m = Math.floor(rel);
      if (Number.isNaN(this.cur.trace[m])) this.cur.trace[m] = lt;
      const g = this.cur.ghost;
      if (!g.length || lt - g[g.length - 4] >= 0.05) g.push(lt, kart.x, kart.y, kart.psi);
      // track limits: all four wheels completely beyond the track edge (kerbs count as track) voids the lap
      if (kart.beyondLimits) { this.offTime += dt; this.invalid = true; this.voidWhy ||= 'Límites de pista'; }
    }
  }

  sectorEvent(k, dur) {
    const ref = this.bestSector(k) ?? (Number.isFinite(this.rec[k]) ? this.rec[k] : null);
    let status;
    if (this.invalid) status = 'invalid';
    else if (dur < this.rec[k]) {
      status = 'purple'; this.rec[k] = dur;
      if (!this.dry) try { localStorage.setItem(this.key + '.sectors', JSON.stringify(this.rec)); } catch {}
    } else status = ref != null && dur < ref ? 'green' : 'yellow';
    this.events.push({ type: 'sector', k, dur, status, delta: ref != null ? dur - ref : null });
  }

  finishLap(t) {
    const time = t - this.lapStart;
    if (this.cur.splits.length === 2) this.sectorEvent(2, time - this.cur.splits[1]);
    const lap = { time, splits: this.cur.splits.slice(), invalid: this.invalid, n: this.lap };
    this.last = lap;
    const improved = !lap.invalid && (!this.best || time < this.best.time);
    if (!lap.invalid && (!this.sessionBest || time < this.sessionBest.time)) this.sessionBest = lap;
    this.events.push({ type: 'lap', n: lap.n, time, invalid: lap.invalid, why: this.voidWhy, improved, delta: this.best ? time - this.best.time : null });
    if (improved) {
      this.best = { time, splits: lap.splits, trace: Array.from(this.cur.trace), ghost: this.cur.ghost.slice() };
      if (!this.dry) try { localStorage.setItem(this.key, JSON.stringify(this.best)); } catch {}
    }
  }

  current(t) { return this.lapStart === null ? null : t - this.lapStart; }

  // live delta vs best at same track position
  delta(t, kart) {
    if (this.lapStart === null || !this.best?.trace) return null;
    const m = Math.floor(this.rel(kart.loc.s));
    const ref = this.best.trace[m];
    if (ref == null || Number.isNaN(ref)) return null;
    return t - this.lapStart - ref;
  }

  ghostPose(t) {
    const g = this.best?.ghost;
    if (!g || this.lapStart === null) return null;
    const lt = t - this.lapStart;
    const n = g.length / 4;
    let lo = 0, hi = n - 1;
    if (lt > g[(n - 1) * 4]) return null;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (g[mid * 4] <= lt) lo = mid; else hi = mid; }
    const a = lo * 4, b = hi * 4, f = Math.min(1, Math.max(0, (lt - g[a]) / (g[b] - g[a] || 1)));
    let dp = g[b + 3] - g[a + 3];
    dp = Math.atan2(Math.sin(dp), Math.cos(dp));
    return { x: g[a + 1] + (g[b + 1] - g[a + 1]) * f, y: g[a + 2] + (g[b + 2] - g[a + 2]) * f, psi: g[a + 3] + dp * f };
  }
}

export const fmt = (t) => {
  if (t == null || !Number.isFinite(t)) return '-:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
};
export const fmtD = (d) => (d == null ? '' : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(3)}`);
