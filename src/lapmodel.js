// Lap model shared by the line optimiser (node) and the game (browser):
// measure the kart's performance envelope with the real physics on a flat virtual pad,
// then a quasi-steady-state (QSS) speed profile / lap time for any racing line.
import { Track } from './track.js';
import { Kart } from './kart.js';
import { lineGeometry } from './linegeom.js';

const g = 9.81, DT = 1 / 1000;

function flatTrack() {
  const R = 400, n = Math.round(2 * Math.PI * R);
  const F = { x: [], y: [], z: [], wl: [], wr: [], bl: [], br: [], kl: [], kr: [], race_offset: [], ideal_speed: [], sf_index: 0, step: 1, length: n };
  for (let i = 0; i < n; i++) {
    const a = i / R;
    F.x.push(R * Math.cos(a)); F.y.push(R * Math.sin(a)); F.z.push(0);
    F.wl.push(300); F.wr.push(300); F.bl.push(390); F.br.push(390);
    F.kl.push(0); F.kr.push(0); F.race_offset.push(0); F.ideal_speed.push(20);
  }
  return new Track(F, { near: { x0: -1000, y0: 1000, step: 1000, n: 3, z: new Array(9).fill(0) } }, { w: 1, h: 1, data: new Uint8Array(4) }, { ground: false, grip: false, rescan: 1e4 }); // a circle: the hint window always holds the nearest point
}
let flat = null;

export function measureEnvelope(P) {
  flat ||= flatTrack();
  const fresh = (v0) => {
    const k = new Kart(flat, P); k.reset(0); k.psi = Math.PI / 2;
    k.u = v0; k.wa = v0 / k.P.Rr; if (v0 > 0) k.we = k.P.G * k.wa;
    return k;
  };
  // accel(v): full throttle straight line, net of drag/rolling
  const accTab = new Float32Array(31);
  {
    const k = fresh(0); let lastV = 0;
    for (let t = 0; t < 40; t += DT) {
      k.step(DT, { steer: 0, throttle: 1, brake: 0 });
      const vi = Math.floor(k.u);
      if (vi > lastV && vi < 31) { accTab[vi] = k.ax; lastV = vi; }
    }
    for (let i = 1; i < 31; i++) if (!accTab[i]) accTab[i] = Math.min(accTab[i - 1], 0);
    accTab[0] = accTab[1];
  }
  // braking: highest pedal level that locks no wheel from 60 km/h (rear axle, or a braked front wheel)
  let brakeG = 0;
  for (let lv = 0.3; lv <= 1.0; lv += 0.02) {
    const k = fresh(60 / 3.6); let t = 0, locked = false;
    while (k.u > 2 && t < 8) {
      k.step(DT, { steer: 0, throttle: 0, brake: lv }); t += DT;
      if (Math.abs(k.wa) < 0.5 || Math.abs(k.wheels[0].spin) < 0.5 || Math.abs(k.wheels[1].spin) < 0.5) locked = true;
    }
    if (locked) break;
    brakeG = (60 / 3.6 - 2) / t / g;
  }
  // lateral: steady skidpad max at several speeds
  const latV = [6, 9, 12, 15, 19], latT = [];
  for (const vv of latV) {
    const k = fresh(vv); let t = 0, iE = 0, m = 0;
    while (t < 14) {
      const e = vv - k.u; iE += e * DT;
      k.step(DT, { steer: Math.min(1, t / 12), throttle: Math.max(0, Math.min(1, 0.3 + e * 1.5 + iE * 0.6)), brake: 0 });
      t += DT; if (t > 1) m = Math.max(m, Math.abs(k.ayf) / g);
      if (Math.abs(Math.atan2(k.v, Math.max(0.1, k.u))) > 0.35) break;
    }
    latT.push(m);
  }
  return { accTab, brakeG, latV, latT, latG: Math.max(...latT) };
}

export function makeLapModel(track, env, margin = 0.97) {
  const n = track.n, z = track.z;
  const accel = (v) => { const i = Math.min(29, Math.max(0, Math.floor(v))); const f = v - i; return env.accTab[i] * (1 - f) + env.accTab[i + 1] * f; };
  const latAt = (v) => {
    const { latV, latT } = env;
    if (v <= latV[0]) return latT[0];
    for (let i = 1; i < latV.length; i++) if (v < latV[i]) { const f = (v - latV[i - 1]) / (latV[i] - latV[i - 1]); return latT[i - 1] + (latT[i] - latT[i - 1]) * f; }
    return latT[latT.length - 1];
  };
  const LATv = (v) => latAt(v) * margin, BRK = env.brakeG * margin;
  // combined grip: share of the straight-line accel / braking left at lateral usage f. Default is the
  // friction ellipse; env.gg (calibrate_model.mjs) holds what the kart achieves on real laps
  // (solid axle, load transfer, yaw transients, the autopilot's traction control).
  const table = (T, f) => { const x = Math.min(1, f) * (T.length - 1), i = Math.min(T.length - 2, Math.floor(x)); return T[i] + (T[i + 1] - T[i]) * (x - i); };
  const accShare = env.gg?.acc ? (f) => table(env.gg.acc, f) : (f) => Math.sqrt(1 - f * f);
  const brkShare = env.gg?.brk ? (f) => table(env.gg.brk, f) : (f) => Math.sqrt(1 - f * f);
  const cam = track.camber || new Float32Array(n);
  const px = new Float64Array(n), py = new Float64Array(n), seg = new Float64Array(n), kap = new Float64Array(n), v = new Float64Array(n);
  const hd = new Float64Array(n), zl = new Float64Array(n), gr = new Float64Array(n); // heading, height and asphalt grip at the line (rubber, dust, marbles)
  function lapTime(a) {
    for (let i = 0; i < n; i++) { px[i] = track.x[i] + track.nx[i] * a[i]; py[i] = track.y[i] + track.ny[i] * a[i]; zl[i] = z[i] + a[i] * cam[i]; gr[i] = track.gripAt(i, 0, a[i]); }
    seg.set(lineGeometry(px, py, 2, hd, kap).seg);
    // banking: the tyres supply |v^2 k + g camber| (camber + = left higher, k + = left turn)
    for (let i = 0; i < n; i++) {
      const bank = -Math.sign(kap[i]) * cam[i] * g;
      let vv = 30;
      for (let it = 0; it < 4; it++) vv = Math.min(30, Math.sqrt(Math.max(0.5, LATv(vv) * gr[i] * g + bank) / Math.max(Math.abs(kap[i]), 1e-4)));
      v[i] = vv;
    }
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, vv = v[i];
      const f = Math.min(1, Math.abs(vv * vv * kap[i] + g * cam[i]) / (LATv(vv) * gr[i] * g));
      // gravity as potential energy: exact however close together the samples are
      const vn = Math.sqrt(Math.max(vv * vv + 2 * accel(vv) * accShare(f) * seg[i] - 2 * g * (zl[j] - zl[i]), 0.1));
      if (vn < v[j]) v[j] = vn;
    }
    for (let pass = 0; pass < 2; pass++) for (let i = n - 1; i >= 0; i--) {
      const j = (i - 1 + n) % n, vv = v[i];
      const f = Math.min(1, Math.abs(vv * vv * kap[i] + g * cam[i]) / (LATv(vv) * gr[i] * g));
      const vp = Math.sqrt(Math.max(vv * vv + 2 * BRK * gr[i] * g * brkShare(f) * seg[j] + 2 * g * (zl[i] - zl[j]), 0.1));
      if (vp < v[j]) v[j] = vp;
    }
    let t = 0;
    for (let i = 0; i < n; i++) t += seg[i] / ((v[i] + v[(i + 1) % n]) / 2);
    return t;
  }
  return { lapTime, v, accel, LATv, kap, seg };
}

// Recompute the ideal speed profile / lap time on the current racing line for a kart setup
// (e.g. after changing the driver's weight). ~5 s of CPU (137k physics steps).
export function retuneIdeal(track, P) {
  const env = measureEnvelope(P);
  env.gg = track.envelope?.gg;
  const lm = makeLapModel(track, env);
  const lap = lm.lapTime(Float64Array.from(track.race));
  const sf = track.speedFactor;
  track.ideal.set(Float32Array.from(lm.v, (x, i) => x * (sf ? sf[i] : 1)));
  // a learned line: scale its real lap by how much the QSS lap changed with the new setup
  track.idealLap = sf && track.learnedLap && track.learnedQss ? (track.learnedLap * lap) / track.learnedQss : lap;
  track.envelope = { lateral_g: env.latG, braking_g: env.brakeG, gg: env.gg };
  return { lap, env };
}
