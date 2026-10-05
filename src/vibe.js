// What the driver feels through the seat and the steering wheel, sampled at every physics step.
// A rental kart has no suspension: every crack, ripple and kerb ridge reaches the driver as a buzz
// at 10-80 Hz, far above what a 60 fps camera can show as motion. So the camera gets two parts:
//  - the slow part, straight from the physics: chassis heave/pitch/roll (already in the kart model's
//    pose) plus the head moving on the neck, a spring-damper driven by the seat's accelerations;
//  - the fast part as a per-frame shake whose size follows the measured buzz (high-passed tyre
//    loads) and the engine (single cylinder: imbalance grows with rpm squared, rough at idle).
// The same numbers drive the pad's rumble motors: strong = seat (rear tyres, bumps, hits),
// weak = steering wheel (front tyres) and engine.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export class Vibe {
  constructor() { this.reset(); }

  reset() {
    this.lpF = [0, 0, 0, 0];   // low-passed tyre loads (N)
    this.eF = 0; this.eR = 0;  // high-passed load energy since the last frame, front / rear (N^2 s)
    this.n = 0; this.t = 0;
    this.vs = null;            // seat vertical speed (m/s) at the previous step
    this.az = 0; this.ax = 0; this.ay = 0; // seat accelerations summed since the last frame
    this.hit = 0;
    this.out = { buzzF: 0, buzzR: 0, engine: 0, az: 0, ax: 0, ay: 0, hit: 0 };
  }

  // every physics step
  sample(kart, dt) {
    const P = kart.P, V = kart.vd;
    // tyre loads above ~8 Hz: road texture, cracks, ridges (the chassis modes are ~5 Hz)
    const a = 1 - Math.exp(-dt * 2 * Math.PI * 8);
    for (let k = 0; k < 4; k++) {
      const f = kart.wheels[k].Fz;
      this.lpF[k] += (f - this.lpF[k]) * a;
      const h = f - this.lpF[k];
      if (k < 2) this.eF += h * h * dt; else this.eR += h * h * dt;
    }
    // seat: a little behind the CG, on the chassis
    const xs = (P.xd ?? 0.3) - (P.b ?? 0.42);
    const vs = V.vz + V.vth * xs;
    if (this.vs !== null) this.az += vs - this.vs; // integral of the acceleration
    this.vs = vs;
    // what the body feels: tyre and air forces, not the slope's share of gravity
    this.ax += (kart.axT ?? kart.ax ?? 0) * dt; this.ay += (kart.ayT ?? kart.ay ?? 0) * dt;
    this.hit = Math.max(this.hit, kart.hit || 0);
    this.t += dt; this.n++;
  }

  // once per rendered frame: averages since the last frame, then start again
  frame(kart) {
    const o = this.out, T = this.t;
    if (T > 0) {
      const Fs = kart.P.m * 9.81 / 4;
      // RMS of the high-passed load per wheel, as a fraction of the static load
      o.buzzF = Math.sqrt(this.eF / (2 * T)) / Fs;
      o.buzzR = Math.sqrt(this.eR / (2 * T)) / Fs;
      o.az = this.az / T; o.ax = this.ax / T; o.ay = this.ay / T;
    } else o.buzzF = o.buzzR = o.az = o.ax = o.ay = 0; // physics not running (start lights)
    o.hit = this.hit;
    // engine: rough below ~1.5x idle (few, big firing pulses), then crank imbalance ~ rpm^2
    const P = kart.P, rpm = kart.rpm, gov = P.govRpm || 4400, idle = P.idleRpm || 1650;
    const rough = 1 - clamp((rpm - idle) / (0.6 * idle), 0, 1);
    o.engine = clamp(0.45 * rough + 0.75 * (rpm / gov) ** 2 * (0.55 + 0.45 * (kart.throttle || 0)), 0, 1);
    this.eF = this.eR = 0; this.az = this.ax = this.ay = 0; this.t = 0; this.n = 0; this.hit = 0;
    return o;
  }
}
