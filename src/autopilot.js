// Driver model following the optimised racing line.
// Steering: feed-forward from line curvature (+ the kart's measured understeer)
// plus Stanley-style correction of heading and cross-track error.
// Speed: brakes for the deceleration actually required by the speed profile ahead.

import { lineGeometry } from './linegeom.js';

const g = 9.81;

// brakeOn: brake when the speed profile ahead needs more than this share of the no-lock decel;
// brakeGain / brakeMax: pedal per unit of that need, and its cap (1 = flat on the brake);
// tcSlip / tcCut: rear slip allowed before easing off the throttle, and how hard it eases;
// overLift: throttle lift per m/s over the target speed.
// Steering: lookBase / lookGain place the reference point (m, m per m/s) ahead of the front axle;
// cteTol: lateral error barely corrected below it (m); preview: s of line averaged for the
// feed-forward curvature; stanley / yawDamp / understeer: correction gains; steerLag: hands (s)
export const DRIVER = {
  brakeOn: 0.88, brakeGain: 0.62, brakeMax: 0.64, tcSlip: 1.15, tcCut: 2, overLift: 4,
  lookBase: 0.3, lookGain: 0.06, cteTol: 0.3, preview: 0.2, stanley: 1.6, yawDamp: 0.03, understeer: 0.015, steerLag: 0.025,
};

export class Autopilot {
  constructor(track, speedScale = 1.0) {
    this.track = track;
    this.scale = speedScale;
    const n = (this.n = track.n);
    this.px = new Float32Array(n); this.py = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.px[i] = track.x[i] + track.nx[i] * track.race[i];
      this.py[i] = track.y[i] + track.ny[i] * track.race[i];
    }
    // line heading and curvature, from neighbours 2 m away along the line (see linegeom.js),
    // then averaged over +/- 2 samples
    this.hd = new Float32Array(n); this.k = new Float32Array(n);
    const geo = lineGeometry(this.px, this.py, 2), raw = geo.k;
    this.hd.set(geo.hd);
    // distance along the line (samples are 1 m apart on the centerline, much closer on an inside apex)
    this.ls = new Float64Array(n);
    for (let i = 1; i < n; i++) this.ls[i] = this.ls[i - 1] + geo.seg[i - 1];
    this.lineLen = this.ls[n - 1] + geo.seg[n - 1];
    for (let i = 0; i < n; i++) { let s = 0; for (let d = -2; d <= 2; d++) s += raw[(i + d + n) % n]; this.k[i] = s / 5; }
    this.brakeG = track.envelope?.braking_g || 0.59;
    // pedal habits, learned by tools/learn_line.mjs (track.driver); the defaults are the old fixed rules
    this.drv = { ...DRIVER, ...(track.driver || {}) };
    this.hits = 0;
    this.thr = 0; this.brk = 0;
  }

  // metres along the line from sample i to sample j (forward)
  dist(i, j) { const d = this.ls[j] - this.ls[i]; return d < 0 ? d + this.lineLen : d; }

  control(kart, dt) {
    const T = this.track, n = this.n, P = kart.P, D = this.drv;
    const v = Math.max(kart.u, 0);
    const c = Math.cos(kart.psi), s = Math.sin(kart.psi);
    // reference point: ahead of the front axle
    const look = P.a + D.lookBase + D.lookGain * v;
    const fx = kart.x + look * c, fy = kart.y + look * s;
    let i = kart.loc.i, best = 1e9;
    for (let d = -6; d <= 120; d++) {
      const j = (kart.loc.i + d + n) % n;
      if (d > 0 && this.dist(kart.loc.i, j) > look + 4) break;
      const e = (this.px[j] - fx) ** 2 + (this.py[j] - fy) ** 2;
      if (e < best) { best = e; i = j; }
    }
    const h = this.hd[i];
    const ex = fx - this.px[i], ey = fy - this.py[i];
    const cte0 = -Math.sin(h) * ex + Math.cos(h) * ey; // + = left of the line
    // the line is a corridor, not a rail: deviations under ~cteTol are barely corrected
    const cte = cte0 * Math.min(1, Math.abs(cte0) / D.cteTol);
    let he = kart.psi - h; he = Math.atan2(Math.sin(he), Math.cos(he));
    this.iCte = Math.max(-0.12, Math.min(0.12, (this.iCte || 0) + 0.35 * cte * dt));
    // feed-forward from the mean curvature over the next ~0.2 s of line (a driver looks ahead,
    // so small ripples in the line do not turn into steering corrections)
    const c0 = Math.max(0.5, 1 + v * 0.1 - D.preview * v), c1 = 1 + v * 0.1 + Math.max(1, D.preview * v);
    let kff = 0, nk = 0;
    for (let jf = i, d = 0; d < c1; jf = (jf + 1) % n, d = this.dist(i, jf)) if (d >= c0) { kff += this.k[jf]; nk++; }
    kff = nk ? kff / nk : this.k[i];
    const ay = v * v * kff;
    const delta = P.L * kff + D.understeer * ay   // kinematic + measured understeer
      - he - Math.atan2(D.stanley * cte, v + 1.5)  // Stanley correction
      - this.iCte                                  // integral: removes steady understeer bias
      - D.yawDamp * (kart.r - v * kff);            // yaw damping
    // hands on the wheel: smoothing time constant steerLag (no instant jumps)
    this.st = (this.st || 0) + (Math.max(-1, Math.min(1, delta / P.maxSteer)) - (this.st || 0)) * (1 - Math.exp(-dt / D.steerLag));
    const steer = this.st;

    // ---- speed ----
    const vt = T.ideal[(i + 1) % n] * this.scale;
    let aReq = 0;
    for (let d = 1; d <= 200; d++) {
      const j = (i + d) % n, dd = this.dist(i, j);
      if (dd > 45) break;
      if (dd < 1.5) continue;
      const vj = T.ideal[j] * this.scale;
      if (vj < v) aReq = Math.max(aReq, (v * v - vj * vj) / (2 * dd));
    }
    let throttle, brake = 0;
    const aMax = this.brakeG * g;
    if (aReq > D.brakeOn * aMax) {
      throttle = 0;
      brake = Math.min(D.brakeMax, (aReq / aMax) * D.brakeGain);
    } else {
      // flat out below the target; above it, lift quickly so a corner is not overspeeded
      throttle = v < vt ? 1 : Math.max(0.1, 1 - (v - vt) * D.overLift);
    }
    // feel the rear: ease off when the rear tyres slide past the allowed slip
    const rs = kart.rearSlip || 0;
    if (v > 3 && rs > D.tcSlip) throttle *= Math.max(0.3, 1 - (rs - D.tcSlip) * D.tcCut);
    const f = 1 - Math.exp(-dt / 0.04);
    this.thr += (throttle - this.thr) * f;
    this.brk += (brake - this.brk) * f;
    return { steer, throttle: this.thr, brake: this.brk };
  }
}
