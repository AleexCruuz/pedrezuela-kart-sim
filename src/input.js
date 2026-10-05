// Keyboard + Gamepad (pads and most USB wheels expose themselves as gamepads) + phone tilt and touch pedals.

// Largest steering the kart holds without spinning, by speed (m/s), at ~95 % of the value measured
// with test/keyboard.mjs: on full throttle (the solid axle pushes the rear out) and off it.
// Keyboard/pad/mouse input is scaled to it so a held key sits at the limit, not past it; peak
// lateral grip is at that same angle, so nothing is lost. Re-measure when the tyres or engine change
// (node game/test/keyboard.mjs --kart <id>). brakeAsThr: pedal level that loads the rear like full
// throttle (rear brake only on the RT10: braking tightens the limit as throttle does); kbBrake: the
// keyboard's brake pedal, just short of locking a wheel; brakeCut: share of the limit taken away at
// that pedal (the rotax brakes hard enough to unload the rear well past what full throttle does).
const LIMITS = {
  rt10: {
    on: [[0, 0.8], [4, 0.57], [6, 0.57], [8, 0.66], [11, 0.71], [14, 0.76], [17, 0.76], [19, 0.81]],
    off: [[0, 1], [4, 0.95], [6, 0.86], [8, 0.81], [11, 0.86], [14, 0.9], [17, 0.95], [19, 0.95]],
    brakeAsThr: 0.47, kbBrake: 0.47, brakeCut: 0,
  },
  // slicks: more grip but a sharper peak; off throttle the 2T barely brakes and the weight still comes
  // off the rear, so 30-40 km/h is tighter off throttle. Front + rear brakes lock from ~0.72 pedal (90 km/h)
  rotax: {
    on: [[0, 0.75], [4, 0.52], [6, 0.48], [8, 0.52], [11, 0.57], [14, 0.57], [17, 0.62], [19, 0.66]],
    off: [[0, 1], [4, 0.95], [6, 0.85], [8, 0.57], [11, 0.57], [14, 0.71], [17, 0.76], [19, 0.81]],
    brakeAsThr: 0.72, kbBrake: 0.68, brakeCut: 0.5,
  },
};
let LIM = LIMITS.rt10;
export function useKartLimits(id) { LIM = LIMITS[id] || LIMITS.rt10; }
const lerpTable = (L, v) => {
  for (let i = 1; i < L.length; i++) {
    if (v < L[i][0]) { const [a, la] = L[i - 1], [b, lb] = L[i]; return la + (lb - la) * (v - a) / (b - a); }
  }
  return L[L.length - 1][1];
};
export function steerLimit(v, throttle = 1) {
  const t = Math.max(0, Math.min(1, throttle));
  return lerpTable(LIM.off, v) + (lerpTable(LIM.on, v) - lerpTable(LIM.off, v)) * t;
}

export class Input {
  constructor() {
    this.keys = new Set();
    this.steer = 0; this.throttle = 0; this.brake = 0;
    this.source = 'teclado';
    this.pressed = new Set(); // edge-triggered actions this frame
    addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    this.padPrev = [];
    this.kbSteer = 0;
    // mouse steering (toggle with N): x position steers, left button throttle, right brake
    this.mouse = { on: false, x: innerWidth / 2, thr: false, brk: false };
    addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; });
    addEventListener('mousedown', (e) => { if (!this.mouse.on) return; if (e.button === 0) this.mouse.thr = true; if (e.button === 2) this.mouse.brk = true; });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.thr = false; if (e.button === 2) this.mouse.brk = false; });
    addEventListener('contextmenu', (e) => { if (this.mouse.on) e.preventDefault(); });
    // phone: tilt steers (roll of the screen's horizontal axis), on-screen pedals for gas and brake
    this.tilt = { on: false, ok: false, roll: 0, flip: 1, sens: 1 };
    this.touch = { thr: false, brk: false };
    this.onMotion = this.onMotion.bind(this);
  }

  // Must run inside a user gesture: iOS asks for motion permission. Resolves to whether the
  // sensor is delivering gravity readings (some browsers answer the permission oddly, so the
  // readings themselves decide).
  enableTilt() {
    const D = window.DeviceMotionEvent;
    if (!D) return Promise.resolve(false);
    const ask = typeof D.requestPermission === 'function' ? D.requestPermission().catch(() => 'denied') : Promise.resolve('granted');
    if (!this.tilt.listening) { addEventListener('devicemotion', this.onMotion); this.tilt.listening = true; }
    return ask.then(() => new Promise((ok) => {
      const t0 = performance.now();
      const wait = () => (this.tilt.ok ? ok(true) : performance.now() - t0 > 1500 ? ok(false) : setTimeout(wait, 100));
      wait();
    }));
  }

  onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    // device axes -> screen axes (x right, y up) for the current screen rotation
    const a = ((screen.orientation?.angle ?? window.orientation ?? 0) * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const sx = g.x * c - g.y * s, sy = g.x * s + g.y * c, sz = g.z;
    // the reading points up on Android and down on iOS; a phone held facing the driver has
    // "up" along screen-up and out of the screen, which fixes the sign
    const f = sy + sz;
    if (Math.abs(f) > 4) this.tilt.flip = Math.sign(f);
    const n = Math.hypot(sx, sy, sz) || 9.81;
    this.tilt.roll = Math.asin(Math.max(-1, Math.min(1, (this.tilt.flip * sx) / n)));
    this.tilt.ok = true;
  }

  toggleMouse() { this.mouse.on = !this.mouse.on; this.mouse.thr = this.mouse.brk = false; return this.mouse.on; }

  // Edge-triggered pad buttons, read once per frame (also while in menus).
  // A=0, B=1, Y=3, start=9, d-pad 12-15.
  pollButtons() {
    const pad = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
    if (!pad) return;
    pad.buttons.forEach((b, i) => {
      if (b.pressed && !this.padPrev[i]) this.pressed.add('pad' + i);
      this.padPrev[i] = b.pressed;
    });
  }

  take(code) { const h = this.pressed.has(code); this.pressed.delete(code); return h; }

  // Vibration out: pad motors (strong = low-frequency seat motor, weak = high-frequency one), or the
  // phone's vibrator in tilt mode. strong/weak 0..1; call every frame, 0/0 stops. The pad effect is
  // renewed every ~50 ms with a 120 ms duration, so it never stops between frames nor runs on
  // after the game stops sending. The phone only has on/off: short pulses while the rumble is big
  // (kerbs, grass, hits), more often the bigger it is.
  rumble(strong, weak, dt) {
    const pad = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
    const act = pad?.vibrationActuator;
    this._rt = (this._rt || 0) + dt;
    if (act && act.playEffect) {
      const on = strong > 0.02 || weak > 0.02;
      if (on && this._rt >= 0.05) {
        this._rt = 0; this._padOn = true;
        act.playEffect('dual-rumble', { startDelay: 0, duration: 120, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) }).catch(() => {});
      } else if (!on && this._padOn) { this._padOn = false; act.reset?.().catch?.(() => {}); }
    } else if (this.tilt.on && navigator.vibrate) {
      const m = Math.max(strong, weak * 0.5);
      if (m > 0.25 && this._rt >= 0.2 - 0.12 * Math.min(1, m)) { this._rt = 0; navigator.vibrate(Math.round(12 + 30 * Math.min(1, m))); }
    }
  }

  update(dt, speed) {
    const k = this.keys;
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const pad = pads[0];
    let usedPad = false;
    if (pad) {
      const ax = pad.axes[0] || 0;
      const rt = pad.buttons[7]?.value || 0, lt = pad.buttons[6]?.value || 0;
      if (Math.abs(ax) > 0.06 || rt > 0.02 || lt > 0.02) usedPad = true;
      if (usedPad) {
        this.source = pad.id.toLowerCase().includes('wheel') ? 'volante' : 'mando';
        const dz = 0.04;
        const a = Math.abs(ax) < dz ? 0 : (Math.abs(ax) - dz) / (1 - dz) * Math.sign(ax);
        const curve = this.source === 'volante' ? 1 : 1.6;
        let st = -Math.sign(a) * Math.abs(a) ** curve;
        if (this.source !== 'volante') st *= Math.min(1, steerLimit(speed, this.throttle) * 1.08); // pad assist
        const f = 1 - Math.exp(-dt / 0.025); // light filtering removes pad jitter
        this.steer += (st - this.steer) * f;
        this.throttle += (rt - this.throttle) * f;
        this.brake += (lt - this.brake) * f;
      }
    }
    if (!usedPad) {
      // braking loads the rear tyres like throttle does (mostly rear braking): same tighter limit
      const lim = steerLimit(speed, Math.max(this.throttle, this.brake / LIM.brakeAsThr)) * (1 - LIM.brakeCut * Math.min(1, this.brake / LIM.kbBrake));
      const up = k.has('ArrowUp') || k.has('KeyW') || this.mouse.thr || this.touch.thr;
      const dn = k.has('ArrowDown') || k.has('KeyS') || k.has('Space') || this.mouse.brk || this.touch.brk;
      if (this.tilt.on && this.tilt.ok) {
        // tilt: turning the phone like a wheel (clockwise = right). Full lock at 28 deg of roll
        // at sensitivity 1 (14 deg at 2, 56 deg at 0.5).
        this.source = 'inclinación';
        const DZ = 0.025, FULL = 0.49 / this.tilt.sens;
        const r = this.tilt.roll;
        const m = Math.min(1, Math.max(0, (Math.abs(r) - DZ) / (FULL - DZ)));
        // full tilt reaches the steering the kart holds without spinning (as the keyboard does);
        // lim * 1.08 went past it on throttle and a hard tilt spun the kart
        const goal = Math.sign(r) * m ** 1.25 * Math.min(1, lim);
        this.steer += (goal - this.steer) * (1 - Math.exp(-dt / 0.04));
      } else if (this.mouse.on) {
        // mouse: analogue steering from horizontal position (centre = straight)
        this.source = 'ratón';
        let m = (this.mouse.x - innerWidth / 2) / (innerWidth * 0.32);
        m = Math.max(-1, Math.min(1, m));
        m = Math.abs(m) < 0.02 ? 0 : m;
        const goal = -Math.sign(m) * Math.abs(m) ** 1.3 * Math.min(1, lim * 1.05);
        this.steer += (goal - this.steer) * (1 - Math.exp(-dt / 0.03));
      } else {
        if (k.size) this.source = 'teclado';
        const left = k.has('ArrowLeft') || k.has('KeyA');
        const right = k.has('ArrowRight') || k.has('KeyD');
        const target = (left ? 1 : 0) - (right ? 1 : 0);
        // keyboard: progressive. Lock builds up while the key is held (a tap = small
        // correction), returns to centre when released, reverses quickly.
        let ks = this.kbSteer;
        if (target !== 0) {
          const rate = ks * target < 0 ? 4.0 : 1.35 + 0.8 * (1 - lim);
          ks += target * rate * dt;
          ks = Math.max(-lim, Math.min(lim, ks));
        } else {
          const back = 2.6 * dt;
          ks = Math.abs(ks) <= back ? 0 : ks - Math.sign(ks) * back;
        }
        this.kbSteer = ks;
        this.steer += (ks - this.steer) * (1 - Math.exp(-dt / 0.035));
      }
      this.throttle += ((up ? 1 : 0) - this.throttle) * (1 - Math.exp(-dt / (up ? 0.08 : 0.05)));
      // keyboard brake stops just short of rear lock-up (a pedal lets you modulate): it locks from
      // 0.52 with the current tyres (mu 1.09), so 0.47 keeps a margin. In a turn the rear tyres also
      // carry side force and lock much earlier: ease off with steering, as a driver would on a pedal
      const kbBrake = LIM.kbBrake * (1 - 0.6 * Math.min(1, Math.abs(this.steer) / Math.max(0.3, lim)));
      this.brake += ((dn ? kbBrake : 0) - this.brake) * (1 - Math.exp(-dt / (dn ? 0.12 : 0.05)));
    }
    return { steer: this.steer, throttle: this.throttle, brake: this.brake };
  }
}
