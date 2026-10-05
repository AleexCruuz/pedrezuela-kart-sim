// Track data + spatial queries.
// Local frame: x east, y north, z up (metres). Index increases in race direction.

export const KERB_W = 0.9;
// asphalt grip across the track (fractions of the asphalt mu)
export const GRIP = { line: 0.03, dust: 0.06, marbles: 0.06 };

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Track {
  constructor(T, terrain, surface, opts = {}) {
    const n = (this.n = T.x.length);
    this.name = T.name;
    const F = (a) => Float32Array.from(a);
    this.x = F(T.x); this.y = F(T.y); this.z = F(T.z);
    this.wl = F(T.wl); this.wr = F(T.wr);
    this.bl = F(T.bl); this.br = F(T.br);
    this.extraBarriers = T.extra_barriers || [];
    this.kl = Uint8Array.from(T.kl); this.kr = Uint8Array.from(T.kr);
    // position along each kerb run and run length (for the ramps at both ends and block colours)
    const z0 = () => new Array(T.x.length).fill(0);
    this.klp = F(T.klp || z0()); this.kll = F(T.kll || z0()); this.krp = F(T.krp || z0()); this.krl = F(T.krl || z0());
    // rubber laid down by everyone's driving line (frozen: re-optimising the line does not move it)
    this.rubber = F(T.rubber_offset || T.race_offset);
    this.gripOn = opts.grip !== false;
    // distance from the centerline beyond which locate() falls back to a full scan. 7 m: just past
    // the widest track + kerb. With 18 m a wheel between the back-to-back legs of the hairpin at ~490
    // stayed on the far leg (8.9 m away, 25 samples back, outside the hint window) instead of the
    // near one (4 m), and the ground under it jumped 22 cm when it switched.
    this.rescan = opts.rescan ?? 7;
    this.camber = F(T.camber || new Array(T.x.length).fill(0)); // dz/dd, + = left higher
    this.sfIndex = T.sf_index;
    this.setKartData(T);

    // arc length, tangents and left normals
    this.s = new Float32Array(n);
    this.tx = new Float32Array(n); this.ty = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.s[i] = acc;
      acc += Math.hypot(this.x[j] - this.x[i], this.y[j] - this.y[i]);
      const p = (i - 1 + n) % n;
      const dx = this.x[j] - this.x[p], dy = this.y[j] - this.y[p];
      const l = Math.hypot(dx, dy);
      this.tx[i] = dx / l; this.ty[i] = dy / l;
    }
    this.length = acc;
    this.nx = this.ty.map((v) => -v);
    this.ny = this.tx;
    this.roundApexes();

    this.buildRubberCurvature();
    this.buildBarriers();
    this.buildBlocks();
    this.terr = terrain.near;
    if (opts.ground !== false) this.buildGround();
    this.surf = surface; // {w,h,data}
    this._tmp = this.newLoc();
  }

  // What depends on the kart (kartdata.js: trackFor): racing line, speeds, lap model and autopilot data
  setKartData(T) {
    const F = (a) => Float32Array.from(a);
    this.race = F(T.race_offset);
    this.ideal = F(T.ideal_speed);
    this.envelope = T.envelope;
    this.idealLap = T.ideal_lap;
    // learned on real laps (tools/learn_line.mjs): speed multipliers over the QSS profile, and the
    // QSS lap of that line, so a retune for another driver weight keeps what was learned
    this.speedFactor = T.speed_factor ? F(T.speed_factor) : null;
    // reference lap pedals per sample (tools/drivetrace.mjs): 1 flat out, -1 braking, 0 lifting
    this.drive = T.drive ? Int8Array.from(T.drive) : null;
    this.driver = T.driver || null; // learned pedal habits for the autopilot
    this.learnedLap = T.learned_lap; this.learnedQss = T.learned_qss;
    // the autopilot's fastest lap as driven (game/tools/record_lap.mjs): offset and pedals per sample
    this.driven = T.driven ? { lap: T.driven.lap, d: F(T.driven.d), thr: F(T.driven.thr), brk: F(T.driven.brk), v: F(T.driven.v) } : null;
  }

  // Where the cross-sections of samples i and j (q apart), on side sg (+1 left), meet: distances
  // [t, u] out along each, or null. Within 25 m, where the two normal lines cross; legs of a V
  // hairpin run back to back with opposite normals that never cross, so for those (any q) they meet
  // halfway across the gap, when the two lines nearly coincide.
  meet(i, j, sg, q) {
    const ax = sg * this.nx[i], ay = sg * this.ny[i], bx = sg * this.nx[j], by = sg * this.ny[j];
    const dx = this.x[j] - this.x[i], dy = this.y[j] - this.y[i];
    if (ax * bx + ay * by < -0.8) {
      const gap = dx * ax + dy * ay, side = Math.abs(dx * ay - dy * ax);
      return gap > 0 && side < 1.5 ? [gap / 2, gap / 2] : null;
    }
    if (q > 25) return null;
    const det = -ax * by + ay * bx;
    if (Math.abs(det) < 1e-6) return null;
    const t = (-dx * by + dy * bx) / det, u = (ax * dy - ay * dx) / det;
    return t > 0 && u > 0 ? [t, u] : null;
  }

  // Inside of the hairpins. Where the centreline turns tighter than the inner half-width (hairpins at
  // samples ~63, ~149 and ~498: radius 3.5-5 m, half-width 4.4-5.4 m) the offset edge folds back on
  // itself into a cusp, the inner kerb crosses over itself and the ground under it jumps 10 cm between
  // points 5 cm apart (the sections on either side of the fold disagree), launching the kart. The
  // real edge (ortho) is a rounded apex ~1 m out from that cusp, so the inner half-width is held to
  // the centreline radius minus APEX_R, which turns the cusp into an arc of that radius; the cut
  // fades out over a few metres. Applied here, not in track.json, so a regenerated track keeps it.
  // The test is geometric: the cross-sections (normal segments out to the kerb's outer edge plus
  // 0.3 m) of any two samples within 25 m must not cross; where they would, the inner half-width is
  // cut so they meet just beyond that reach. On a circle of radius R this is w + kerb + 0.3 <= R.
  roundApexes(REACH = 0.3) {
    const n = this.n, red = [new Float32Array(n), new Float32Array(n)]; // cut for wl, wr
    for (let side = 0; side < 2; side++) {
      const sg = side === 0 ? 1 : -1, W = side === 0 ? this.wl : this.wr, K = side === 0 ? this.kl : this.kr;
      for (let it = 0; it < 3; it++) for (let i = 0; i < n; i++) for (let q = 1; q <= 60; q++) {
        const j = (i + q) % n, m = this.meet(i, j, sg, q);
        if (!m) continue;
        const [t, u] = m;
        const ri = W[i] - red[side][i] + (K[i] ? KERB_W : 0) + REACH, rj = W[j] - red[side][j] + (K[j] ? KERB_W : 0) + REACH;
        if (t < ri && u < rj) { // crossing inside both reaches: pull both back to the crossing
          red[side][i] += ri - t + 0.02; // ri already has the cut so far taken off
          red[side][j] += rj - u + 0.02;
        }
      }
      for (let i = 0; i < n; i++) red[side][i] = Math.min(red[side][i], W[i] - 1.0); // keep >= 1 m of road
    }
    this.apexCut = 0;
    for (let side = 0; side < 2; side++) {
      const W = side === 0 ? this.wl : this.wr, cut = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let c = 0;
        for (let q = -6; q <= 6; q++) c = Math.max(c, red[side][(i + q + n) % n] * Math.exp(-((q / 3) ** 2)));
        cut[i] = c;
      }
      for (let i = 0; i < n; i++) { W[i] -= cut[i]; this.apexCut = Math.max(this.apexCut, cut[i]); }
    }
    // Beyond the kerb the ground blends from the track edge into the terrain over 1 m (groundZ). In a
    // hairpin that strip of one leg overlaps the other leg's, and the legs differ in height (15 cm at
    // ~149): the blend would jump where the nearest section switches. There it is shortened to end
    // where the cross-sections meet (the relaxed ground mesh already follows the edges there).
    this.blendL = new Float32Array(n).fill(1); this.blendR = new Float32Array(n).fill(1);
    for (let side = 0; side < 2; side++) {
      const sg = side === 0 ? 1 : -1, W = side === 0 ? this.wl : this.wr, K = side === 0 ? this.kl : this.kr;
      const B = side === 0 ? this.blendL : this.blendR;
      for (let i = 0; i < n; i++) for (let q = 1; q <= 60; q++) {
        const j = (i + q) % n, m = this.meet(i, j, sg, q);
        if (!m) continue;
        const [t, u] = m;
        const ei = W[i] + (K[i] ? KERB_W : 0), ej = W[j] + (K[j] ? KERB_W : 0);
        if (t < ei + 1 && u < ej + 1) {
          B[i] = Math.min(B[i], Math.max(0.05, t - ei));
          B[j] = Math.min(B[j], Math.max(0.05, u - ej));
        }
      }
    }
  }

  // signed curvature of the rubbered line (+ = left turn), smoothed over ~5 m
  buildRubberCurvature() {
    const n = this.n, px = new Float32Array(n), py = new Float32Array(n), raw = new Float32Array(n);
    for (let i = 0; i < n; i++) { px[i] = this.x[i] + this.nx[i] * this.rubber[i]; py[i] = this.y[i] + this.ny[i] * this.rubber[i]; }
    for (let i = 0; i < n; i++) {
      const a = (i - 2 + n) % n, b = (i + 2) % n;
      const ax = px[a], ay = py[a], bx = px[i], by = py[i], cx = px[b], cy = py[b];
      const cr = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      raw[i] = (2 * cr) / (Math.hypot(bx - ax, by - ay) * Math.hypot(cx - bx, cy - by) * Math.hypot(cx - ax, cy - ay) + 1e-9);
    }
    this.rubberK = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let d = -2; d <= 2; d++) s += raw[(i + d + n) % n]; this.rubberK[i] = s / 5; }
  }

  // Asphalt grip factor at index i (+ fraction t) and lateral offset d: rubber on the driving line,
  // dust off it, marbles thrown to the outside of the corners. Multiplies the asphalt mu.
  gripAt(i, t, d) {
    if (!this.gripOn) return 1;
    const j = (i + 1) % this.n;
    const off = d - (this.rubber[i] + (this.rubber[j] - this.rubber[i]) * t);
    const k = this.rubberK[i] + (this.rubberK[j] - this.rubberK[i]) * t;
    const a = Math.abs(off);
    let g = 1 + GRIP.line * (1 - smoothstep(0.4, 1.2, a)) - GRIP.dust * smoothstep(1.0, 2.5, a);
    if (off * k < 0) {
      // marbles collect in a band along the outside edge of the corner
      const edge = k > 0 ? this.wr[i] + (this.wr[j] - this.wr[i]) * t + d : this.wl[i] + (this.wl[j] - this.wl[i]) * t - d;
      g -= GRIP.marbles * smoothstep(0.02, 0.06, Math.abs(k)) * smoothstep(1.0, 2.0, a) * (1 - smoothstep(0.8, 1.8, edge));
    }
    return g;
  }

  grip(loc) { return this.gripAt(loc.i, loc.t, loc.d); }

  // Barrier faces (TecPro blocks / pit wall) as world segments in a spatial hash.
  // Face sits 0.5 m inside the stored barrier offsets bl/br.
  buildBarriers() {
    const n = this.n, segs = [];
    this.barrierFace = { 1: [], [-1]: [] };
    for (const side of [1, -1]) {
      const B = side > 0 ? this.bl : this.br, pts = this.barrierFace[side];
      for (let i = 0; i < n; i++) {
        const off = side * (B[i] - 0.5);
        pts.push([this.x[i] + this.nx[i] * off, this.y[i] + this.ny[i] * off]);
      }
      for (let i = 0; i < n; i++) {
        if (B[i] <= 0 || B[(i + 1) % n] <= 0) continue; // no barrier here
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
        const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
        if (L < 1e-3) continue;
        // normal towards the track: right of travel for the left barrier, left for the right one
        let nx = -dy / L, ny = dx / L;
        if (side > 0) { nx = -nx; ny = -ny; }
        segs.push({ ax, ay, dx: dx / L, dy: dy / L, L, nx, ny });
      }
    }
    this.segs = segs;
    const CELL = (this.cell = 4), grid = (this.grid = new Map());
    segs.forEach((g, k) => {
      const x0 = Math.floor((Math.min(g.ax, g.ax + g.dx * g.L) - 1) / CELL), x1 = Math.floor((Math.max(g.ax, g.ax + g.dx * g.L) + 1) / CELL);
      const y0 = Math.floor((Math.min(g.ay, g.ay + g.dy * g.L) - 1) / CELL), y1 = Math.floor((Math.max(g.ay, g.ay + g.dy * g.L) + 1) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const key = cx * 100003 + cy;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(k);
      }
    });
    this._hit = { nx: 0, ny: 0, pen: 0 };
  }

  // The barrier blocks themselves, as drawn (world.js) and as the kart collides with them: solid
  // boxes laid chord by chord along the face polylines. TecPro blocks of 1.5 m x 0.55 m, and the
  // concrete pit wall (left of the pit straight) in 1 m x 0.35 m pieces. Dividers seen from two
  // sections become a single row. Every block is solid from all sides, so a barrier can't be
  // crossed from behind (the faces alone only stopped a kart coming from their own section).
  buildBlocks() {
    const n = this.n, sf = this.sfIndex, BLOCK = 1.5, out = [];
    const isPit = (i, side) => side > 0 && ((i - (sf - 38) + n) % n) < 112;
    for (const side of [1, -1]) {
      const B = side > 0 ? this.bl : this.br, F = this.barrierFace[side];
      let i = 0;
      while (i < n) {
        if (B[i] <= 0) { i++; continue; }
        const pit = isPit(i, side), len = pit ? 1 : BLOCK;
        // walk along the face until the chord reaches the block length
        let j = i, acc = 0;
        while (acc < len && j < i + 4 && B[(j + 1) % n] > 0) { const a = F[j % n], b = F[(j + 1) % n]; acc += Math.hypot(b[0] - a[0], b[1] - a[1]); j++; }
        if (j === i) { i++; continue; }
        const a = F[i % n], b = F[j % n];
        const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
        if (L > 1e-3) {
          const dep = pit ? 0.35 : 0.55;
          const ux = dx / L, uy = dy / L;
          const vx = -uy * (side > 0 ? 1 : -1), vy = ux * (side > 0 ? 1 : -1); // away from the track
          out.push({ x: (a[0] + b[0]) / 2 + vx * dep / 2, y: (a[1] + b[1]) / 2 + vy * dep / 2,
            yaw: Math.atan2(dy, dx), len: L, dep, pit, i, ux, uy, vx, vy, ha: L / 2, hb: dep / 2 });
        }
        i = j;
      }
    }
    // hand-placed straight pieces (tools/manual_barriers.py): face from a to b, blocks behind it
    // on the side away from the track
    for (const e of this.extraBarriers) {
      const [ax, ay] = e.a, [bx, by] = e.b, L = Math.hypot(bx - ax, by - ay);
      const ux = (bx - ax) / L, uy = (by - ay) / L, k = Math.max(1, Math.round(L / BLOCK)), len = L / k;
      const loc = this.locate((ax + bx) / 2, (ay + by) / 2, -1);
      const mx = (ax + bx) / 2 - (this.x[loc.i] + this.nx[loc.i] * loc.d), my = (ay + by) / 2 - (this.y[loc.i] + this.ny[loc.i] * loc.d);
      const away = -uy * mx + ux * my > 0 ? 1 : -1;
      const vx = -uy * away, vy = ux * away, dep = 0.55;
      for (let q = 0; q < k; q++) {
        const cx = ax + ux * len * (q + 0.5), cy = ay + uy * len * (q + 0.5);
        out.push({ x: cx + vx * dep / 2, y: cy + vy * dep / 2, yaw: Math.atan2(uy, ux), len, dep, pit: false, i: loc.i,
          ux, uy, vx, vy, ha: len / 2, hb: dep / 2 });
      }
    }
    // dividers are seen from both sections: keep a single row
    const blocks = [];
    for (const b of out) if (!blocks.some((o) => (o.x - b.x) ** 2 + (o.y - b.y) ** 2 < 0.25)) blocks.push(b);
    // seams: an end that touches another block is not an edge the kart can be pushed around
    const ends = blocks.map((b) => [[b.x - b.ux * b.ha, b.y - b.uy * b.ha], [b.x + b.ux * b.ha, b.y + b.uy * b.ha]]);
    blocks.forEach((b, k) => {
      b.link = [0, 1].map((e) => blocks.some((o, m) => m !== k && ends[m].some(([x, y]) => (x - ends[k][e][0]) ** 2 + (y - ends[k][e][1]) ** 2 < 0.3 * 0.3)));
    });
    this.blocks = blocks;
    const CELL = (this.bcell = 4), grid = (this.bgrid = new Map());
    blocks.forEach((b, k) => {
      const r = b.ha + b.hb + 1.3; // block half-diagonal-ish + kart reach
      for (let cx = Math.floor((b.x - r) / CELL); cx <= Math.floor((b.x + r) / CELL); cx++)
        for (let cy = Math.floor((b.y - r) / CELL); cy <= Math.floor((b.y + r) / CELL); cy++) {
          const key = cx * 100003 + cy;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(k);
        }
    });
  }

  // Deepest overlap between a convex polygon (world points, counter-clockwise) and the barrier
  // blocks around (cx, cy), by separating axes. Returns { nx, ny, pen, px, py, block }: push the
  // polygon by n * pen; (px, py) is the contact point. Null when clear.
  blockContact(poly, cx, cy) {
    let best = null;
    for (const h of this.blockContacts(poly, cx, cy)) if (!best || h.pen > best.pen) best = h;
    return best;
  }

  // every block the polygon overlaps (same contact data as blockContact)
  blockContacts(poly, cx, cy) {
    const list = this.bgrid.get(Math.floor(cx / this.bcell) * 100003 + Math.floor(cy / this.bcell));
    const res = [];
    if (!list) return res;
    const m = poly.length;
    for (const k of list) {
      const b = this.blocks[k];
      let pen = Infinity, nx = 0, ny = 0, sep = false;
      const axis = (ax, ay, isLong) => {
        let kmin = Infinity, kmax = -Infinity;
        for (let q = 0; q < m; q++) { const p = poly[q][0] * ax + poly[q][1] * ay; if (p < kmin) kmin = p; if (p > kmax) kmax = p; }
        const bc = b.x * ax + b.y * ay, br = b.ha * Math.abs(b.ux * ax + b.uy * ay) + b.hb * Math.abs(b.vx * ax + b.vy * ay);
        const o = Math.min(kmax, bc + br) - Math.max(kmin, bc - br);
        if (o <= 0) { sep = true; return; }
        // push the polygon to whichever side its centre is on
        const dir = (kmin + kmax) / 2 >= bc ? 1 : -1;
        // along a row, an end joined to the next block is not a way out
        if (isLong && b.link[(ax * b.ux + ay * b.uy) * dir > 0 ? 1 : 0]) return;
        if (o < pen) { pen = o; nx = ax * dir; ny = ay * dir; }
      };
      axis(b.vx, b.vy, false); if (sep) continue;
      axis(b.ux, b.uy, true); if (sep) continue;
      for (let q = 0; q < m && !sep; q++) {
        const [x0, y0] = poly[q], [x1, y1] = poly[(q + 1) % m];
        const ex = x1 - x0, ey = y1 - y0, el = Math.hypot(ex, ey);
        axis(ey / el, -ex / el, false); // outward normal of a CCW polygon edge
      }
      if (sep || pen === Infinity) continue;
      // contact point: polygon corners inside the block, else block corners inside the polygon,
      // else the polygon corner deepest along the push
      let sx = 0, sy = 0, cnt = 0;
      for (let q = 0; q < m; q++) {
        const rx = poly[q][0] - b.x, ry = poly[q][1] - b.y;
        if (Math.abs(rx * b.ux + ry * b.uy) <= b.ha && Math.abs(rx * b.vx + ry * b.vy) <= b.hb) { sx += poly[q][0]; sy += poly[q][1]; cnt++; }
      }
      if (!cnt) for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const X = b.x + b.ux * b.ha * su + b.vx * b.hb * sv, Y = b.y + b.uy * b.ha * su + b.vy * b.hb * sv;
        let inside = true;
        for (let q = 0; q < m && inside; q++) {
          const [x0, y0] = poly[q], [x1, y1] = poly[(q + 1) % m];
          if ((x1 - x0) * (Y - y0) - (y1 - y0) * (X - x0) < 0) inside = false;
        }
        if (inside) { sx += X; sy += Y; cnt++; }
      }
      if (!cnt) {
        let lo = Infinity;
        for (let q = 0; q < m; q++) { const p = poly[q][0] * nx + poly[q][1] * ny; if (p < lo) { lo = p; sx = poly[q][0]; sy = poly[q][1]; } }
        cnt = 1;
      }
      res.push({ nx, ny, pen, px: sx / cnt, py: sy / cnt, block: b });
    }
    return res;
  }

  // point inside a barrier? returns push-out normal (towards track) and depth, else null
  // (qx, qy): the same point one step earlier. Continuous collision: only faces it came at from the
  // track side count. Filtering before picking the deepest face matters at a single-row divider,
  // where the back face (~0.55 m away) is always deeper and would otherwise hide the front one.
  barrierContact(px, py, maxDepth, qx, qy) {
    const list = this.grid.get(Math.floor(px / this.cell) * 100003 + Math.floor(py / this.cell));
    if (!list) return null;
    let best = null;
    for (const k of list) {
      const g = this.segs[k];
      const rx = px - g.ax, ry = py - g.ay;
      const t = rx * g.dx + ry * g.dy;
      if (t < -0.05 || t > g.L + 0.05) continue;
      const dist = rx * g.nx + ry * g.ny;           // >0 on the track side
      if (qx !== undefined && (qx - g.ax) * g.nx + (qy - g.ay) * g.ny < -0.08) continue; // already behind it
      if (dist < 0 && dist > -maxDepth && (!best || -dist > best.pen)) best = { nx: g.nx, ny: g.ny, pen: -dist, seg: g };
    }
    return best;
  }

  newLoc() {
    return { i: 0, t: 0, s: 0, d: 0, z: 0, wl: 4, wr: 4, bl: 8, br: 8, kerbL: 0, kerbR: 0, dist: 0 };
  }

  // Nearest point on centerline. hint<0 => full search.
  locate(px, py, hint = -1, out = this.newLoc()) {
    const n = this.n, X = this.x, Y = this.y;
    let best = -1, bd = 1e18, bt = 0;
    const scan = (k0, k1) => {
      for (let k = k0; k <= k1; k++) {
        const j = ((k % n) + n) % n, j2 = (j + 1) % n;
        const ax = X[j], ay = Y[j];
        const sx = X[j2] - ax, sy = Y[j2] - ay;
        const l2 = sx * sx + sy * sy;
        let t = ((px - ax) * sx + (py - ay) * sy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + sx * t - px, qy = ay + sy * t - py;
        const d2 = qx * qx + qy * qy;
        if (d2 < bd) { bd = d2; best = j; bt = t; }
      }
    };
    if (hint >= 0) scan(hint - 20, hint + 20);
    if (best < 0 || bd > this.rescan * this.rescan) { bd = 1e18; scan(0, n - 1); }

    // Smooth track coordinates: the point lies on the cross-section through C(t) along the normal
    // interpolated between the two nodes, N(t), the way the track mesh is built. Plain projection on
    // the polyline jumps at every node on the inside of a bend (~0.3 m of s at 3.4 m in on a 12 m
    // radius): on a slope that is a 1 cm step a metre under the inside wheels (corner 8, uphill).
    let j = best, t = bt, d = 0;
    {
      const NX = this.nx, NY = this.ny;
      let jj = j, ok = false;
      for (let hop = 0; hop < 3; hop++) {
        const j2 = (jj + 1) % n;
        const ex = X[j2] - X[jj], ey = Y[j2] - Y[jj], qx = px - X[jj], qy = py - Y[jj];
        const nax = NX[jj], nay = NY[jj], dx = NX[j2] - nax, dy = NY[j2] - nay;
        // cross(Q - tE, Na + tD) = 0  ->  a2 t^2 + a1 t + a0 = 0
        const a2 = -(ex * dy - ey * dx), a1 = (qx * dy - qy * dx) - (ex * nay - ey * nax), a0 = qx * nay - qy * nax;
        let tt;
        if (Math.abs(a2) < 1e-9) tt = -a0 / a1;
        else {
          const disc = a1 * a1 - 4 * a2 * a0;
          if (disc < 0) break;
          const r = Math.sqrt(disc), t1 = (-a1 + r) / (2 * a2), t2 = (-a1 - r) / (2 * a2);
          tt = Math.abs(t1 - 0.5) < Math.abs(t2 - 0.5) ? t1 : t2;
        }
        if (!Number.isFinite(tt)) break;
        if (tt < 0 && hop < 2) { jj = (jj - 1 + n) % n; continue; }
        if (tt > 1 && hop < 2) { jj = j2; continue; }
        if (tt < -0.02 || tt > 1.02) break;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const nx = nax + dx * tt, ny = nay + dy * tt, nl = Math.hypot(nx, ny);
        const dd = ((qx - ex * tt) * nx + (qy - ey * tt) * ny) / nl;
        if (Math.abs(dd) < 15) { j = jj; t = tt; d = dd; ok = true; }
        break;
      }
      if (!ok) { // far from the track or past the centre of a tight bend: plain projection
        const j2 = (j + 1) % n, sx = X[j2] - X[j], sy = Y[j2] - Y[j], l = Math.hypot(sx, sy);
        d = (sx * (py - (Y[j] + sy * t)) - sy * (px - (X[j] + sx * t))) / l;
      }
    }
    const j2 = (j + 1) % n;
    const l = Math.hypot(X[j2] - X[j], Y[j2] - Y[j]);
    const lerp = (A) => A[j] + (A[j2] - A[j]) * t;
    out.i = j; out.t = t;
    out.s = this.s[j] + l * t;
    out.d = d; // + = left of centerline
    out.dist = Math.sqrt(bd);
    out.z = lerp(this.z);
    out.cam = lerp(this.camber);
    out.wl = lerp(this.wl); out.wr = lerp(this.wr);
    out.bl = lerp(this.bl); out.br = lerp(this.br);
    const kk = t < 0.5 ? j : j2;
    out.kerbL = this.kl[kk]; out.kerbR = this.kr[kk];
    out.kpL = this.klp[j] + t * l; out.klL = this.kll[j];
    out.kpR = this.krp[j] + t * l; out.klR = this.krl[j];
    return out;
  }

  terrainZ(px, py) {
    const T = this.terr, N = T.n;
    let c = (px - T.x0) / T.step, r = (T.y0 - py) / T.step;
    c = Math.min(N - 1.001, Math.max(0, c)); r = Math.min(N - 1.001, Math.max(0, r));
    const c0 = c | 0, r0 = r | 0, fc = c - c0, fr = r - r0;
    const Z = T.z, i = r0 * N + c0;
    return (Z[i] * (1 - fc) + Z[i + 1] * fc) * (1 - fr) + (Z[i + N] * (1 - fc) + Z[i + N + 1] * fc) * fr;
  }

  // Seamless ground: a 1 m grid whose cells on the track/kerbs are fixed to the track surface,
  // far cells fixed to the IGN terrain, and everything in between relaxed like an elastic
  // membrane (Laplace). No steps between neighbouring sections, smooth banks up and down.
  buildGround() {
    const N = 321, STEP = 1, X0 = -160, Y0 = 160;
    const Z = new Float32Array(N * N), fixed = new Uint8Array(N * N), foot = new Uint8Array(N * N);
    const loc = this.newLoc();
    for (let r = 0; r < N; r++) {
      let hint = -1;
      for (let c = 0; c < N; c++) {
        const x = X0 + c * STEP, y = Y0 - r * STEP, k = r * N + c;
        this.locate(x, y, hint, loc);
        if (loc.dist > 3) this.locate(x, y, -1, loc); // true nearest section near other sections
        hint = loc.i;
        const ad = Math.abs(loc.d), w = loc.d > 0 ? loc.wl : loc.wr;
        const edge = loc.z + (loc.d > 0 ? 1 : -1) * Math.min(ad, w) * loc.cam;
        if (ad <= w + KERB_W + 0.4) { Z[k] = edge; fixed[k] = 1; foot[k] = ad <= w + 0.2 ? 2 : 1; }
        else if (ad > 16) { Z[k] = this.terrainZ(x, y); fixed[k] = 1; }
        else { const t = smoothstep(w, w + 16, ad); Z[k] = edge * (1 - t) + this.terrainZ(x, y) * t; }
      }
    }
    for (let it = 0; it < 120; it++) {           // Gauss-Seidel relaxation
      for (let r = 1; r < N - 1; r++) for (let c = 1; c < N - 1; c++) {
        const k = r * N + c;
        if (!fixed[k]) Z[k] = 0.25 * (Z[k - 1] + Z[k + 1] + Z[k - N] + Z[k + N]);
      }
    }
    this.ground = { N, STEP, X0, Y0, z: Z, foot };
  }

  groundAt(px, py) {
    const G = this.ground, N = G.N;
    let c = (px - G.X0) / G.STEP, r = (G.Y0 - py) / G.STEP;
    c = Math.min(N - 1.001, Math.max(0, c)); r = Math.min(N - 1.001, Math.max(0, r));
    const c0 = c | 0, r0 = r | 0, fc = c - c0, fr = r - r0, Z = G.z, i = r0 * N + c0;
    return (Z[i] * (1 - fc) + Z[i + 1] * fc) * (1 - fr) + (Z[i + N] * (1 - fc) + Z[i + N + 1] * fc) * fr;
  }

  // Rounded kerb hump, 30 mm at the crown, flush with the asphalt on the inside and rising with
  // zero slope (sin^1.5): the wheel rolls up it. The old 45 mm sin^0.7 profile rose 13 mm in the
  // first 4 cm, a step that launched the kart instead of a kerb you can use.
  kerbProfile(u) { // u 0..1 across the kerb, returns height (m)
    return 0.03 * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.1)), 1.5);
  }

  // kerbs start and end with a 0.8 m ramp instead of a vertical step
  kerbRamp(pos, len) { return len > 0 ? smoothstep(0, 0.8, pos) * smoothstep(0, 0.8, len - pos) : 1; }

  // transverse ridges on the kerb (period 0.4 m, 3 mm): felt as a rumble through the wheel,
  // not a jump (8 mm made the kart hop on every kerb)
  kerbRidge(s, u) {
    if (u < 0.12) return 0;
    const r = 0.5 + 0.5 * Math.sin((2 * Math.PI * s) / 0.4);
    return 0.003 * r * r;
  }

  // Surface relief under a wheel (m, added to groundZ): the asphalt is never flat. Built on first use
  // (buildRelief) as a table over track coordinates (s, d), so it costs one bilinear lookup per wheel.
  // Off the track it switches by surface (surface() leaves its result in loc.surf): grass and dirt
  // are lumpy, the kerbs are smooth precast concrete with their own ridges.
  roughness(loc) {
    const R = this.relief || this.buildRelief();
    const sf = loc.surf;
    const k = sf ? sf.relief ?? 1 : 1;
    if (k === 0) return 0;
    // fold d into the table width (far run-off repeats it; nobody drives a straight line there)
    let d = (loc.d - R.d0) % R.span; if (d < 0) d += R.span;
    let s = loc.s % this.length; if (s < 0) s += this.length;
    const fs = s / R.ds, fd = d / R.dd;
    const i0 = fs | 0, j0 = fd | 0, ts = fs - i0, td = fd - j0;
    const i1 = i0 + 1 === R.ns ? 0 : i0 + 1, j1 = j0 + 1 === R.nd ? 0 : j0 + 1;
    const H = R.h, a = H[j0 * R.ns + i0], b = H[j0 * R.ns + i1], c = H[j1 * R.ns + i0], e = H[j1 * R.ns + i1];
    let z = ((a + (b - a) * ts) * (1 - td) + (c + (e - c) * ts) * td) * R.unit;
    if (sf && sf.lumps) z = z * k + sf.lumps * lumps(loc.s, loc.d);
    else z *= k;
    return z;
  }

  // The relief table. Everything is seeded, so every session and every tool feels the same track.
  //  - Asphalt profile: ISO 8608 displacement PSD Gd(n) = G0 (n/0.1)^-2 between 12 m and 0.2 m
  //    wavelength (longer waves are in the LiDAR elevation). G0 8e-6 m^3 is the smooth half of class
  //    A ('very good' road): ~1 mm RMS, ~0.25 mm of it in the short waves that buzz through a
  //    suspension-less kart. Plane waves with a whole number of cycles per lap (seamless at s = 0),
  //    each slanted at a random angle so the left and right wheels feel related but different bumps.
  //  - Cracks: thin transverse dips, 1.5-3.5 mm deep, across part of the width, every ~20 m.
  //  - Patches: repaired rectangles 1-4 m long, 1.5-4 mm proud (some sunk), sharp-edged lengthwise.
  //  - Braking ripples: a washboard of ~0.9 m waves, up to 1.2 mm, along the rubbered line where
  //    everybody brakes into the tight corners.
  // R.cracks / R.patches are kept so the scenery can draw them where the wheels feel them.
  buildRelief() {
    const L = this.length, ns = Math.ceil(L / 0.04), ds = L / ns;
    const d0 = -7.2, dd = 0.3, nd = 48, span = nd * dd;
    const unit = 1e-5; // Int16 in 0.01 mm
    const acc = new Float32Array(ns * nd);
    const rnd = mulberry32(0x5eed2701);
    // 1) random profile
    const G0 = 8e-6, n0 = 0.1, nLo = 1 / 12, nHi = 1 / 0.2, M = 56;
    const cs = new Float32Array(ns), sn = new Float32Array(ns);
    const used = new Set();
    for (let m = 0; m < M; m++) {
      const nA = nLo * (nHi / nLo) ** (m / M), nB = nLo * (nHi / nLo) ** ((m + 1) / M);
      let cyc = Math.round(Math.sqrt(nA * nB) * L);
      while (used.has(cyc)) cyc++;
      used.add(cyc);
      const n = cyc / L, amp = Math.sqrt(2 * G0 * (n / n0) ** -2 * (nB - nA));
      const ks = 2 * Math.PI * n;
      // lateral wavenumber: random slant, kept to wavelengths the 0.3 m lanes can hold
      const kd = Math.max(-2 * Math.PI / 1.2, Math.min(2 * Math.PI / 1.2, ks * Math.tan((rnd() * 2 - 1) * 1.0)));
      const ph = rnd() * 2 * Math.PI;
      for (let i = 0; i < ns; i++) { const a = ks * i * ds; cs[i] = Math.cos(a); sn[i] = Math.sin(a); }
      for (let j = 0; j < nd; j++) {
        const p = kd * (d0 + j * dd) + ph, sp = amp * Math.sin(p), cp = amp * Math.cos(p), row = j * ns;
        for (let i = 0; i < ns; i++) acc[row + i] += sn[i] * cp + cs[i] * sp; // amp sin(ks s + p)
      }
    }
    const put = (s, d, z) => { // add z at (s, d), nearest lane, s wrapped
      let fd = (d - d0) / dd;
      if (fd < 0 || fd > nd - 1) return;
      const j = Math.round(fd), i = ((Math.round(s / ds) % ns) + ns) % ns;
      acc[j * ns + i] += z;
    };
    // 2) cracks
    const cracks = [];
    for (let s = rnd() * 20; s < L - 1; s += 6 + rnd() * 28) {
      const i = this.indexAt(s), wl = this.wl[i], wr = this.wr[i];
      const a = -wr + rnd() * (wl + wr) * 0.6, b = Math.min(wl, a + 1 + rnd() * (wl + wr) * 0.8);
      const c = { s, a, b, skew: (rnd() * 2 - 1) * 0.35, depth: 0.0015 + rnd() * 0.002 };
      cracks.push(c);
      for (let d = a; d <= b; d += dd * 0.5) {
        const end = Math.min(1, (d - a) / 0.4, (b - d) / 0.4); // tapering ends
        const sc = s + (d - a) * c.skew;
        for (let q = -2; q <= 2; q++) put(sc + q * ds, d, -c.depth * end * Math.exp(-((q * ds / 0.03) ** 2)) * 0.5);
      }
    }
    // 3) patches
    const patches = [];
    for (let s = 8 + rnd() * 30; s < L - 5; s += 18 + rnd() * 45) {
      const i = this.indexAt(s), wl = this.wl[i], wr = this.wr[i];
      const ls = 1 + rnd() * 3, ld = 0.8 + rnd() * 1.8;
      const dc = -wr + ld / 2 + rnd() * Math.max(0, wl + wr - ld);
      const h = (rnd() < 0.75 ? 1 : -1) * (0.0015 + rnd() * 0.0025);
      const p = { s, ls, d: dc, ld, h, rot: (rnd() * 2 - 1) * 0.15 };
      patches.push(p);
      for (let ss = -0.1; ss <= ls + 0.1; ss += ds) for (let d = -ld / 2 - 0.15; d <= ld / 2 + 0.15; d += dd * 0.5) {
        const ex = Math.min(ss, ls - ss), ey = ld / 2 - Math.abs(d);
        const f = smoothstep(-0.03, 0.03, ex) * smoothstep(-0.1, 0.1, ey);
        // half-lane steps: both put() calls land on the same lane, so weight 0.5
        if (f > 0) put(s + ss + d * p.rot, dc + d, h * f * 0.5);
      }
    }
    // 4) braking ripples before the tight corners of the rubbered line (radius < 30 m)
    const K = this.rubberK, n = this.n;
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n;
      if (Math.abs(K[i]) < 1 / 30 || Math.abs(K[p]) >= 1 / 30) continue; // corner entry
      const sE = this.s[i], lam = 0.8 + rnd() * 0.25, amp = 0.0006 + rnd() * 0.0006;
      for (let ss = -20; ss < -1; ss += ds) {
        const s = sE + ss, k = this.indexAt(s), w = smoothstep(-20, -10, ss) * (1 - smoothstep(-3, -1, ss));
        for (let dl = -1.6; dl <= 1.6; dl += dd) {
          const lat = 1 - smoothstep(0.6, 1.6, Math.abs(dl));
          put(s, this.rubber[k] + dl, amp * w * lat * Math.sin(2 * Math.PI * ss / lam));
        }
      }
    }
    const h = new Int16Array(ns * nd);
    for (let k = 0; k < h.length; k++) h[k] = Math.max(-32767, Math.min(32767, Math.round(acc[k] / unit)));
    this.relief = { h, ns, nd, ds, dd, d0, span, unit, cracks, patches };
    return this.relief;
  }

  // sample index at arc length s (wrapped)
  indexAt(s) {
    s = ((s % this.length) + this.length) % this.length;
    let lo = 0, hi = this.n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.s[m] <= s) lo = m; else hi = m - 1; }
    return lo;
  }

  // ground height at a point, given its locate() result
  groundZ(px, py, loc) {
    const ad = Math.abs(loc.d);
    const w = loc.d > 0 ? loc.wl : loc.wr;
    if (ad <= w) return loc.z + loc.d * loc.cam;
    const sgn = loc.d > 0 ? 1 : -1;
    const edge = loc.z + sgn * w * loc.cam;
    const kerb = loc.d > 0 ? loc.kerbL : loc.kerbR;
    if (kerb && ad < w + KERB_W) {
      const u = (ad - w) / KERB_W;
      const ramp = loc.d > 0 ? this.kerbRamp(loc.kpL, loc.klL) : this.kerbRamp(loc.kpR, loc.klR);
      return edge + ramp * (this.kerbProfile(u) + this.kerbRidge(loc.s, u));
    }
    if (this.ground) {                            // continuous relaxed ground beyond the edge
      const kk = loc.t < 0.5 ? loc.i : (loc.i + 1) % this.n;
      const t = smoothstep(w + (kerb ? KERB_W : 0), w + (kerb ? KERB_W : 0) + (loc.d > 0 ? this.blendL[kk] : this.blendR[kk]), ad);
      return edge * (1 - t) + this.groundAt(px, py) * t;
    }
    const t = smoothstep(w + KERB_W, w + 10, ad);
    return edge * (1 - t) + this.terrainZ(px, py) * t;
  }

  // surface height at an index and lateral offset (for meshes)
  surfZ(i, off) { return this.z[i] + off * this.camber[i]; }

  height(px, py, hint = -1) {
    const loc = this.locate(px, py, hint, this._tmp);
    return this.groundZ(px, py, loc);
  }

  // surface type under a point (also left in loc.surf for roughness())
  surface(px, py, loc) { return (loc.surf = this.surfaceType(px, py, loc)); }

  surfaceType(px, py, loc) {
    const ad = Math.abs(loc.d);
    const w = loc.d > 0 ? loc.wl : loc.wr;
    if (ad <= w) return SURF.track;
    const kerb = loc.d > 0 ? loc.kerbL : loc.kerbR;
    if (kerb && ad < w + KERB_W) return SURF.kerb;
    const S = this.surf;
    const c = Math.floor((px + 160) * 2), r = Math.floor((160 - py) * 2);
    if (c < 0 || r < 0 || c >= S.w || r >= S.h) return SURF.dirt;
    const k = (r * S.w + c) * 4;
    if (S.data[k] > 127) return SURF.runoff;
    if (S.data[k + 1] > 127) return SURF.grass;
    return SURF.dirt;
  }

  // position/heading at an index (+lateral offset)
  pose(i, off = 0) {
    i = ((i % this.n) + this.n) % this.n;
    return {
      x: this.x[i] + this.nx[i] * off,
      y: this.y[i] + this.ny[i] * off,
      psi: Math.atan2(this.ty[i], this.tx[i]),
    };
  }
}

// relief: scale of the asphalt relief table on this surface; lumps: amplitude (m) of the uneven
// ground off the track (lumps() below), on top of it
export const SURF = {
  track: { name: 'asfalto', mu: 1.0, crr: 0.016, rumble: 0, relief: 1 },
  kerb: { name: 'piano', mu: 0.93, crr: 0.02, rumble: 1, relief: 0.25 },
  runoff: { name: 'escapatoria', mu: 0.88, crr: 0.02, rumble: 0.15, relief: 1.6 },
  grass: { name: 'hierba', mu: 0.5, crr: 0.09, rumble: 0.5, relief: 1, lumps: 0.011 },
  dirt: { name: 'tierra', mu: 0.58, crr: 0.12, rumble: 0.7, relief: 1, lumps: 0.014 },
};

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// smooth value noise on a unit lattice, -1..1
function hash2(i, j) {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) & 0xffff) / 32767.5 - 1;
}
function vnoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
// uneven ground (grass tufts, ruts, stones): three octaves, 2.4 / 0.85 / 0.32 m, about 0.5 RMS
function lumps(s, d) {
  return 0.6 * vnoise(s / 2.4, d / 2.4) + 0.3 * vnoise(s / 0.85 + 17.3, d / 0.85 - 4.1) + 0.15 * vnoise(s / 0.32 - 9.7, d / 0.32 + 31.9);
}
