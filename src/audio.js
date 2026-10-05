// Procedural audio: single-cylinder engine, 4-stroke (one firing every 2 revs, thumpy) or 2-stroke
// (one firing every rev, raspy and rich in high harmonics), tyre scrub, kerb rumble and wind.
// All WebAudio, no samples.

export class KartAudio {
  constructor() { this.ready = false; this.muted = false; }

  start() {
    if (this.ready) return;
    const ac = (this.ac = new (window.AudioContext || window.webkitAudioContext)());
    const master = (this.master = ac.createGain());
    master.gain.value = 0.55;
    master.connect(ac.destination);

    // engine: pulse train via PeriodicWave with a thumpy harmonic series
    const N = 24, re = new Float32Array(N), im = new Float32Array(N);
    for (let h = 1; h < N; h++) { im[h] = (1 / h ** 0.9) * (h % 2 ? 1 : 0.65); re[h] = h === 2 ? 0.4 : 0; }
    // 2T: sharper exhaust pulse (flatter harmonic fall-off), a buzz around the 3rd-5th harmonics
    const re2 = new Float32Array(N), im2 = new Float32Array(N);
    for (let h = 1; h < N; h++) { im2[h] = (1 / h ** 0.6) * (h >= 3 && h <= 5 ? 1.4 : 1); re2[h] = h % 2 ? 0 : 0.25 / h ** 0.5; }
    this.waves = { 4: ac.createPeriodicWave(re, im), 2: ac.createPeriodicWave(re2, im2) };
    this.strokes = 4;
    this.osc = ac.createOscillator(); this.osc.setPeriodicWave(this.waves[4]);
    this.osc2 = ac.createOscillator(); this.osc2.type = 'triangle'; // crank/mechanical
    const shaper = ac.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(2.2 * x); }
    shaper.curve = curve;
    this.engF = ac.createBiquadFilter(); this.engF.type = 'lowpass'; this.engF.Q.value = 2.5;
    this.engG = ac.createGain(); this.engG.gain.value = 0;
    const g2 = ac.createGain(); g2.gain.value = 0.18;
    this.osc.connect(shaper); this.osc2.connect(g2); g2.connect(shaper);
    shaper.connect(this.engF); this.engF.connect(this.engG); this.engG.connect(master);

    // exhaust/intake noise modulated with firing
    const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const mk = () => { const s = ac.createBufferSource(); s.buffer = noise; s.loop = true; s.start(); return s; };
    this.exF = ac.createBiquadFilter(); this.exF.type = 'bandpass'; this.exF.frequency.value = 450; this.exF.Q.value = 0.8;
    this.exG = ac.createGain(); this.exG.gain.value = 0;
    mk().connect(this.exF); this.exF.connect(this.exG); this.exG.connect(master);

    // tyre scrub
    this.tyF = ac.createBiquadFilter(); this.tyF.type = 'bandpass'; this.tyF.frequency.value = 1100; this.tyF.Q.value = 6;
    this.tyG = ac.createGain(); this.tyG.gain.value = 0;
    mk().connect(this.tyF); this.tyF.connect(this.tyG); this.tyG.connect(master);

    // rumble (kerbs/off-track) and wind
    this.ruF = ac.createBiquadFilter(); this.ruF.type = 'lowpass'; this.ruF.frequency.value = 120;
    this.ruG = ac.createGain(); this.ruG.gain.value = 0;
    mk().connect(this.ruF); this.ruF.connect(this.ruG); this.ruG.connect(master);
    this.wiF = ac.createBiquadFilter(); this.wiF.type = 'highpass'; this.wiF.frequency.value = 600;
    this.wiG = ac.createGain(); this.wiG.gain.value = 0;
    mk().connect(this.wiF); this.wiF.connect(this.wiG); this.wiG.connect(master);

    // impact
    this.hitG = ac.createGain(); this.hitG.gain.value = 0;
    const hf = ac.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 300;
    mk().connect(hf); hf.connect(this.hitG); this.hitG.connect(master);

    this.osc.start(); this.osc2.start();
    this.ready = true;
  }

  toggleMute() { this.muted = !this.muted; if (this.ready) this.master.gain.value = this.muted ? 0 : 0.55; }

  update(k) {
    if (!this.ready) return;
    const t = this.ac.currentTime, tc = 0.03;
    const two = k.P.strokes === 2;
    if (this.strokes !== k.P.strokes) { this.strokes = k.P.strokes; this.osc.setPeriodicWave(this.waves[two ? 2 : 4]); }
    const rpm = Math.max(600, k.rpm);
    const fire = rpm / (two ? 60 : 120); // Hz, firing frequency of a single cylinder
    this.osc.frequency.setTargetAtTime(fire, t, tc);
    this.osc2.frequency.setTargetAtTime(rpm / 60, t, tc);
    const load = k.throttle;
    this.engF.frequency.setTargetAtTime(two ? 400 + load * 1800 + rpm * 0.16 : 180 + load * 900 + rpm * 0.12, t, tc);
    this.engG.gain.setTargetAtTime(two ? 0.12 + 0.24 * load : 0.16 + 0.22 * load, t, tc);
    this.exF.frequency.setTargetAtTime(two ? 600 + rpm * 0.12 : 250 + rpm * 0.15, t, tc);
    this.exG.gain.setTargetAtTime(two ? 0.03 + 0.09 * load : 0.02 + 0.06 * load, t, tc);
    const v = k.speed;
    const scrub = Math.max(0, (k.slip || 0) - 0.85) * Math.min(1, v / 6);
    this.tyG.gain.setTargetAtTime(Math.min(0.25, scrub * 0.12), t, 0.05);
    this.tyF.frequency.setTargetAtTime(900 + 300 * Math.min(1, scrub), t, 0.05);
    this.ruG.gain.setTargetAtTime(Math.min(0.6, (k.rumble || 0) * Math.min(1, v / 8) * 0.6), t, 0.03);
    this.wiG.gain.setTargetAtTime(Math.min(0.12, v * v * 0.00018), t, 0.1);
    if (k.hit > 0.15) this.hitG.gain.setTargetAtTime(k.hit * 0.8, t, 0.005);
    else this.hitG.gain.setTargetAtTime(0, t, 0.08);
  }
}
