// Rental kart physics, solid rear axle. Two karts (KARTS below): Sodikart RT10 with a Honda GX270 4T
// and rear brake only, and the Sodi Sport with a Rotax 125 2T and brakes on all four wheels.
// Body frame: x forward, y left, z up. World (track) frame: x east, y north.

import { SURF, KERB_W } from './track.js';

// GX270 curve (19.1 N m @ 2500) scaled x1.19 to the circuit's quoted 10 cv.
// An extra +15% from driver feedback on launch was removed: it made the whole lap 2-3 s
// faster than the real reference (49.5 s, advanced driver).
const TQ_GX270 = [ // rpm, N m at crank
  [0, 9.5], [1000, 14.9], [1500, 19.3], [2000, 21.8], [2500, 22.7], [3000, 22.1],
  [3600, 20.2], [4000, 18.4], [4500, 15.5],
];

const RT10 = {
  id: 'rt10',
  // menu card; strokes: 4T fires every 2 revs (sound, engine shake); ledRpm: first shift light;
  // proLap: real lap by an advanced driver on this kart (README), s
  info: { name: 'Sodikart RT10', short: 'RT10 270', engine: 'Honda GX270 4T', hp: 10, number: 27,
    desc: 'El kart de alquiler: regulador a 4400 rpm, neumáticos duros y freno solo atrás.' },
  strokes: 4, ledRpm: 1500, proLap: 49.5,
  // mass properties are derived from kart + driver in massProps() below
  kartMass: 153,      // Sodikart RT10 270, empty (manufacturer)
  driverMass: 75,     // kg, adjustable in game
  m: 228, Iz: 45, a: 0.63, b: 0.42, h: 0.296, Ixx: 14, Iyy: 28, // (75 kg values, recomputed)
  L: 1.05,            // wheelbase
  tf: 1.02, tr: 1.20, // track widths
  Rf: 0.128, Rr: 0.140,
  wF: 0.114, wR: 0.180, // tread widths: 10x4.50 front, 11x7.10 rear (track limits)
  maxSteer: 0.40,     // mean road-wheel angle at full lock (rad)
  ackermann: 0.7,
  // tyres (hard rental compound)
  // 1.09: peak lateral 1.05 g (1.01-1.05 g by speed), hard rental tyres; was 1.20 (~1.13 g), which
  // left the lap 2-3 s faster than the real reference
  mu: 1.09, loadSens: 0.06,
  // rear 11x7.10 tyres are much wider than the 10x4.50 fronts: more grip, stiffer
  front: { muS: 1.0, alphaPeak: 0.115 },
  rear: { muS: 1.03, alphaPeak: 0.105 },
  kappaPeak: 0.10,
  // shape: grip after the peak. 1.25 fell only to ~92 %, so wheelspin cost almost nothing (91 % at 4x
  // the peak slip) and the trained autopilot learned to drive with the rear spinning at ~4x. 1.5 with
  // muSlide 0.88 left a full slide at ~62 % of the peak: any slide past the limit was unrecoverable and
  // the autopilot spun. 1.35 falls to ~85 % shape, ~75 % with sliding friction (PHYSICS_AUDIT 1 target)
  mfC: 1.35,
  // sliding friction: rubber loses grip with sliding speed. Only sliding beyond sSlide x the peak
  // slip counts (the inside rear on the solid axle runs just past its peak in a steady corner),
  // so the grip envelope is unchanged; a slide or a locked wheel at speed drops towards
  // muSlide x the shape tail (~0.81 of peak). 0.82/2.5 punished small slides so hard that the
  // autopilot spun and a 100 kg driver lost ~1.1 s/10 kg; 0.88/5 gives ~0.6 s/10 kg and a locked
  // rear still brakes less than the best unlocked stop (0.545 g vs 0.564 g)
  muSlide: 0.88, vSlide: 5, sSlide: 1.5, // asymptote, decay sliding speed (m/s), onset
  relax: 0.14,        // lateral relaxation length (m)
  relaxK: 0.10,       // longitudinal relaxation length (m)
  crrK: 1,            // rolling resistance of these tyres over the surface's (SURF crr: hard rental tyres)
  // chassis
  // vertical: kart tyres + chassis flex act as the only 'suspension'
  kF: 60000, kR: 38000, cF: 900, cR: 700,  // N/m and N s/m per corner
  ride: 0.05,
  // tyre enveloping: the tyre bridges bumps shorter than its contact length, so the ground it
  // feels is the road filtered over this length (m). Halves the 0.4 m kerb ridges, keeps the hump
  envelope: 0.12,
  caster: 0.035,      // m of vertical jacking per rad of steer at the front wheels
  jack: 500,          // N/rad of steering-induced (caster/KPI) inside-rear unloading
  // engine & driveline
  tq: TQ_GX270,
  Ie: 0.035, Ia: 0.22,
  G: 3.50,            // engine rpm / axle rpm
  eff: 0.92,
  idleRpm: 1650, govRpm: 4400,
  govBand: 120,       // rpm over which the governor / rev limiter cuts the torque
  // closed-throttle friction and pumping at the crank: (1 - throttle)(f0 + f1 rpm) + fc, N m
  fric0: 1.0, fric1: 0.0009, fricC: 0.3,
  clutchIn: 2050, clutchSpan: 800, clutchCap: 60, // centrifugal: cap ∝ (rpm-in)^2, stall ≈ 2550 rpm
  brakeMax: 330,      // N m at rear axle
  brakeFront: 0,      // N m per front wheel (0: no front brakes, front wheels roll freely)
  Iwf: 0.025,         // front wheel + hub + disc inertia, kg m^2 (only used with front brakes)
  // aerodynamics: kart + upright driver (no downforce: a rental kart makes <1 % of its weight).
  // The driver's share of the area scales with body size, so it follows the driver's mass.
  CdAkart: 0.22, CdAdriver: 0.33,          // frontal CdA, m^2 (0.55 with a 75 kg driver)
  CdAsideKart: 0.40, CdAsideDriver: 0.45,  // side-on CdA, m^2
  zcp: 0.55,          // centre of pressure height (driver's torso), m
  xcp: 0.32,          // centre of pressure, m ahead of the rear axle (behind the CG: weathervane)
  // kart body CG (m ahead of the rear axle, m high) and seated driver CG; see massProps()
  xk: 0.48, hk: 0.22, xd: 0.30, hd: 0.45,
  Iz0: 40, Ixx0: 9, Iyy0: 20, // the empty kart's own inertias about its CG (yaw, roll, pitch), kg m^2
  size: [1, 1],       // bumper outline scale (length, width) over the RT10's 1865 x 1350 mm (OUTLINE)
  altitude: 871,      // m, Pedrezuela track (track.json origin.z_ref): air density from ISA
  airTemp: 20,        // deg C
};

// Sodi Sport Rotax: Sodikart's 2019 rental chassis with the Rotax 125 Junior MAX evo (circuit: 15 karts,
// "Rotax 2T 125 cc, 22 cv, neumáticos de competición, frenos delanteros, 95 km/h"). Sources: README.
// Torque: Rotax's 2021 Junior MAX evo datasheet curve (17 kW and 19 N m at 8500 rpm, no exhaust valve),
// digitised every 500 rpm, x0.95 to the circuit's 22 cv (16.2 kW). Below 5000 rpm extrapolated.
const TQ_ROTAX = [ // rpm, N m at crank
  [0, 7.6], [2000, 9.5], [3000, 10.5], [4000, 11.4], [5000, 12.5], [5500, 12.5], [6000, 12.4], [6500, 13.6],
  [7000, 15.4], [7500, 17.1], [8000, 18.3], [8500, 18.2], [9000, 17.2], [9500, 15.7], [10000, 14.3],
  [10500, 13.3], [11000, 13.0], [11500, 12.4], [12000, 10.5], [12500, 9.3], [13000, 8.0], [13500, 7.0],
  [14000, 7.2], [14500, 6.5],
];
const ROTAX = {
  ...RT10,
  id: 'rotax',
  info: { name: 'Sodi Sport Rotax', short: 'Rotax 125', engine: 'Rotax 125 2T', hp: 22, number: 15,
    desc: 'Rotax 125 Junior MAX evo. Para pilotos con experiencia: dos tiempos que empuja de verdad a partir de 7000 rpm, limitador a 14 000, neumáticos de competición y frenos también delante.' },
  // proLap: fast amateur laps on these karts in videos from 2021-2025 (harder tyres) run 42.5-44.7 s,
  // ~0.89-0.91 of the same drivers' RT10 laps
  strokes: 2, ledRpm: 10000, proLap: 43.5,
  kartMass: 128,      // 125 kg with the Rotax MAX evo (Sodikart) + the circuit's front brakes and fluids
  // no roll bar or plate, lighter frame: CG a touch lower; own inertias scaled with the mass (128/153)
  hk: 0.21, Iz0: 34, Ixx0: 7.6, Iyy0: 17,
  size: [1970 / 1865, 1450 / 1350], // Sodi Sport 1970 x 1450 mm
  tf: 1.06, tr: 1.20,
  Rr: 0.136,          // 11x7.10-5 slick: Rotax's gearing tables use a 0.85 m rear circumference
  // engine & driveline: Rotax Junior MAX evo, centrifugal clutch (free below 2500 rpm, fully in by
  // 4000), hard limiter ~14000 rpm, 12/86 chain (7.17): ~92-96 km/h at 13000-13500 rpm
  tq: TQ_ROTAX,
  isoCurve: true,     // rated at ISO conditions: x0.92 in Pedrezuela's thinner air (powerFactor)
  Ie: 0.0045,         // crank + ignition rotor + clutch drum, kg m^2
  G: 86 / 12,
  eff: 0.95,          // chain drive straight to the axle
  idleRpm: 2100, govRpm: 14000, govBand: 150,
  fric0: 0.4, fric1: 0.00025, fricC: 0.2, // a 2T brakes far less than the GX270 off throttle
  clutchIn: 2500, clutchSpan: 1500, clutchCap: 40,
  // tyres: club slicks (the circuit: "neumáticos de competición", a harder compound since 2021).
  // Lot & Dal Bianco 2016 race-kart fit (VSD 54:210): mu 1.5, peak at ~0.09-0.10 rad, kappa 0.09;
  // logged Rotax karts hold ~1.4-1.7 g on prime slicks. The circuit went to a harder, longer-lasting
  // compound in 2021 and the compound is not published: mu is set by the lap instead. Same-driver laps
  // here put the Rotax at 0.887-0.913 of the RT10. 1.32 without the altitude derating learned 41.34 s
  // (0.866); 1.26 (~1.15 g on the skidpad) with it learned 42.47 s (0.889; best real Sodi Sport lap 42.51)
  mu: 1.26, loadSens: 0.10,
  front: { muS: 1.02, alphaPeak: 0.095 },
  rear: { muS: 1.0, alphaPeak: 0.085 },
  kappaPeak: 0.09,
  // slicks lose more past the peak than rental tyres (Lot: ~0.87 at 2.3x, ~0.76 at 3.5x the peak slip)
  mfC: 1.4, muSlide: 0.85,
  relax: 0.11, relaxK: 0.075, // shorter: lower, softer carcass at 0.6 bar
  crrK: 1.2,          // slicks at 0.6 bar: ~0.019 on asphalt (coast-down fits 0.013-0.027)
  // brakes: one hydraulic circuit (16 mm master cylinder): rear 4-piston caliper + the circuit's front
  // brakes, ~57 % of the brake force at the front. Full pedal locks; ~1.0 g just short of it
  brakeMax: 160, brakeFront: 100, Iwf: 0.012,
  // aero: bigger PROFLEX bumpers + the radiator (~0.05 m^2) on the kart, a more reclined seat for the
  // driver: CdA 0.54 with 75 kg (Biancolini 2007: 0.46-0.52 for a race kart with CIK bodywork). No lift
  CdAkart: 0.26, CdAdriver: 0.28, CdAsideKart: 0.44, zcp: 0.52,
};

export const KARTS = { rt10: RT10, rotax: ROTAX };
export const KART = RT10; // the default kart (and the one the tools tune unless told otherwise)
export const kartById = (id) => KARTS[id] || RT10;

function torqueCurve(TQ, rpm) {
  if (rpm <= 0) return TQ[0][1];
  for (let i = 1; i < TQ.length; i++) {
    if (rpm < TQ[i][0]) {
      const [r0, t0] = TQ[i - 1], [r1, t1] = TQ[i];
      return t0 + (t1 - t0) * (rpm - r0) / (r1 - r0);
    }
  }
  return TQ[TQ.length - 1][1];
}
// Kart and driver as two bodies. Positions measured forward from the rear axle / up from the ground.
// RT10: CG 0.48 m ahead of the rear axle, 0.22 m high. Seated driver: 0.30 m ahead, 0.45 m high
// (torso/head above the seat). With 75 kg this gives 60 % rear weight and a 0.30 m CG height.
export function massProps(P, driverMass = P.driverMass) {
  const mk = P.kartMass, md = Math.max(30, Math.min(150, driverMass));
  const { xk, hk, xd, hd } = P;
  const m = mk + md;
  const x = (mk * xk + md * xd) / m, h = (mk * hk + md * hd) / m;
  // own inertias about each body's CG + parallel-axis terms
  const Iz = P.Iz0 + md * 0.045 + mk * (xk - x) ** 2 + md * (xd - x) ** 2;
  const Ixx = P.Ixx0 + md * 0.035 + mk * (hk - h) ** 2 + md * (hd - h) ** 2;
  const Iyy = P.Iyy0 + md * 0.05 + mk * ((xk - x) ** 2 + (hk - h) ** 2) + md * ((xd - x) ** 2 + (hd - h) ** 2);
  // aero: the driver's frontal/side area grows like body surface, ~ mass^(2/3)
  const size = (md / 75) ** (2 / 3);
  const CdA = P.CdAkart + P.CdAdriver * size, CdAy = P.CdAsideKart + P.CdAsideDriver * size;
  return { driverMass: md, m, b: x, a: P.L - x, h, Iz, Ixx, Iyy, CdA, CdAy, xcpCG: P.xcp - x };
}

// ISA air density (kg/m^3) at an altitude (m) and air temperature (deg C)
export const airPressure = (altitude) => 101325 * (1 - 2.25577e-5 * altitude) ** 5.25588;
export function airDensity(altitude, tempC) {
  return airPressure(altitude) / (287.05 * (tempC + 273.15));
}
// Engine power in this air over the ISO 15550 / 1585 reference (100 kPa, 25 deg C), for a naturally
// aspirated petrol engine: (p / 100 kPa) (298 K / T)^0.5. 0.92 at Pedrezuela (871 m, 20 deg C)
export const powerFactor = (altitude, tempC) => (airPressure(altitude) / 100000) * Math.sqrt(298.15 / (tempC + 273.15));

const RPM = 60 / (2 * Math.PI);
const g = 9.81;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class Kart {
  constructor(track, P = KART) {
    this.track = track;
    this.loc = track.newLoc();
    this.windX = 0; this.windY = 0; // calm
    this.setProfile(P);
    this.reset(track.sfIndex - 35);
  }

  // switch to another kart (KARTS): its parameters, with the same driver weight and air
  setProfile(P, driverMass = this.P?.driverMass ?? P.driverMass) {
    const air = this.P ? { tempC: this.P.airTemp, altitude: this.P.altitude } : {};
    this.P = { ...P, front: { ...P.front }, rear: { ...P.rear } }; // per-kart copy
    Object.assign(this.P, massProps(this.P, driverMass));
    P = this.P;
    this.B = Math.tan(Math.PI / (2 * P.mfC)); // magic formula B so peak is at s=1
    this.wheels = [0, 1, 2, 3].map((k) => ({
      x: k < 2 ? P.a : -P.b,
      y: (k % 2 === 0 ? 1 : -1) * (k < 2 ? P.tf : P.tr) / 2,
      R: k < 2 ? P.Rf : P.Rr,
      ax: k < 2 ? P.front : P.rear,
      delta: 0, alpha: 0, kappa: 0, Fz: 0, Fx: 0, Fy: 0, slip: 0,
      surf: SURF.track, grip: 1, loc: this.track.newLoc(), z: 0, spin: 0, free: true,
    }));
    this.hull = P.size[0] === 1 && P.size[1] === 1 ? HULL : hullOf(OUTLINE.map(([x, y]) => [x * P.size[0], y * P.size[1]]));
    this._poly = null;
    this.setAir(air);
    return P;
  }

  // air temperature (deg C) and altitude (m): density for the drag
  setAir({ tempC = this.P.airTemp, altitude = this.P.altitude } = {}) {
    this.P.airTemp = tempC; this.P.altitude = altitude;
    this.P.rho = airDensity(altitude, tempC);
    // a datasheet curve (ISO conditions) loses power with altitude and heat; the RT10's was fitted on track
    this.P.powerK = this.P.isoCurve ? powerFactor(altitude, tempC) : 1;
    return this.P.rho;
  }

  // steady wind: speed (m/s) and the compass direction it blows FROM (deg, 0 = north, 90 = east)
  setWind(speed = 0, fromDeg = 0) {
    const a = fromDeg * Math.PI / 180;
    this.windX = -speed * Math.sin(a); this.windY = -speed * Math.cos(a); // world: x east, y north
  }

  // change the driver's weight (kg): mass, CG position/height and inertias follow
  setDriverMass(kg) {
    Object.assign(this.P, massProps(this.P, kg));
    for (let k = 0; k < 4; k++) this.wheels[k].x = k < 2 ? this.P.a : -this.P.b;
    this.reset(this.loc.i);
    return this.P;
  }

  reset(i, off = 0) {
    const p = this.track.pose(i, off);
    this.x = p.x; this.y = p.y; this.psi = p.psi;
    this.u = 0; this.v = 0; this.r = 0;
    this.wa = 0; this.we = this.P.idleRpm / RPM;
    this.axf = 0; this.ayf = 0;
    this.steer = 0; this.throttle = 0; this.brake = 0;
    this.track.locate(this.x, this.y, -1, this.loc);
    this.z = this.track.groundZ(this.x, this.y, this.loc);
    for (const w of this.wheels) { w.alpha = 0; w.loc.i = this.loc.i; w.free = true; }
    this.hit = 0; this.offTrack = false; this.beyondLimits = false; this.rumble = 0;
    this.slip = 0; this.rearSlip = 0; this.frontSlip = 0; this.ax = 0; this.ay = 0; this.hitImpulse = 0; this.clutchLocked = false;
    this.Fxa = 0; this.Fya = 0;
    const sag = (this.P.m * g / 4) / ((this.P.kF + this.P.kR) / 2);
    this.vd = { z: this.z + this.P.ride - sag, vz: 0, th: 0, vth: 0, ph: 0, vph: 0 };
    for (const w of this.wheels) { w.z = this.z; w.zg0 = undefined; w.Fz = this.P.m * g / 4; }
    this.sag = sag;
  }

  // chassis pose for rendering
  get bodyZ() { return this.vd.z - this.P.ride + this.sag; }
  get pitch() { return this.vd.th; }
  get roll() { return this.vd.ph; }

  get speed() { return Math.hypot(this.u, this.v); }
  get rpm() { return this.we * RPM; }

  // Rigid chassis on four springs (tyre + frame flex in series). States: heave z (world),
  // pitch th (nose up +), roll ph (left side up +). Wheel loads come out of the springs,
  // so load transfer, wheel lift, kerb hops and caster jacking all emerge from it.
  vertical(dt) {
    const P = this.P, V = this.vd;
    let F = 0, Mth = 0, Mph = 0;
    for (let k = 0; k < 4; k++) {
      const w = this.wheels[k];
      const front = k < 2;
      // caster/KPI: the steered inner front wheel pushes the chassis up on the inside
      const jack = front ? P.caster * Math.sin(w.delta) * (k === 0 ? 1 : -1) : 0;
      w.ze = w.zg0 === undefined ? w.z : w.ze + (w.z - w.ze) * (1 - Math.exp(-dt * this.speed / P.envelope));
      const zg = w.ze + jack;
      // ground vertical speed under the tyre; a step change (kart pushed sideways by a
      // barrier, onto a kerb edge) must not act like the ground moving at tens of m/s
      const vg = w.zg0 === undefined ? 0 : clamp((zg - w.zg0) / dt, -1.5, 1.5);
      w.zg0 = zg;
      const zc = V.z + V.th * w.x + V.ph * w.y;
      const vc = V.vz + V.vth * w.x + V.vph * w.y;
      const comp = zg + P.ride - zc;
      const kk = front ? P.kF : P.kR, cc = front ? P.cF : P.cR;
      let f = comp > 0 ? kk * comp + cc * (vg - vc) : 0;
      f = clamp(f, 0, 4 * P.m * g / 4); // tyre/frame load cannot exceed ~4x static
      w.Fz = f; w.comp = comp;
      F += f; Mth += f * w.x; Mph += f * w.y;
    }
    // chassis floor / bumper touching the ground (stops the kart digging in or tipping over)
    const w0 = this.wheels;
    for (const [fx, fy] of FLOOR) {
      const tx = (fx + P.b) / (P.a + P.b), ty = 0.5 + fy / 1.1;                    // bilinear between wheels
      const zg = (w0[3].z * (1 - ty) + w0[2].z * ty) * (1 - tx) + (w0[1].z * (1 - ty) + w0[0].z * ty) * tx;
      const zc = V.z + V.th * fx + V.ph * fy, vc = V.vz + V.vth * fx + V.vph * fy;
      const ex = zg + P.ride - zc - (this.sag + 0.04);
      if (ex > 0) {
        const f = Math.max(0, 150000 * ex - 2500 * vc);
        F += f; Mth += f * fx; Mph += f * fy;
        this.scrape = Math.max(this.scrape || 0, ex);
      }
    }
    const m = P.m;
    V.vz += (F / m - g) * dt;
    // m·a·h treats every horizontal force as acting at ground level; the air pushes at the centre
    // of pressure (zcp above the ground), so drag lifts the nose and side wind rolls the kart away
    V.vth += ((Mth + m * (this.ax || 0) * P.h - P.zcp * this.Fxa) / P.Iyy) * dt;
    V.vph += ((Mph + m * (this.ay || 0) * P.h - P.zcp * this.Fya) / P.Ixx) * dt;
    // a rental kart never exceeds these even when it jumps a bank: keep the model sane
    V.vz = clamp(V.vz, -2.5, 2); V.vth = clamp(V.vth, -3, 3); V.vph = clamp(V.vph, -3, 3);
    V.z += V.vz * dt; V.th += V.vth * dt; V.ph += V.vph * dt;
  }

  // longitudinal transient slip after one step at axle speed wa
  kappaNext(w, wa, vl, dt) {
    const s = this.P.relaxK;
    return clamp((w.kappa + dt * (wa * w.R - vl) / s) / (1 + dt * Math.abs(vl) / s), -1.5, 1.5);
  }

  // normalised combined-slip magic formula; vl = wheel speed along its heading
  tyre(w, Fz, muS, tanA, kappa, vl) {
    const P = this.P;
    let mu = P.mu * muS * w.ax.muS * (1 - P.loadSens * (Fz / 650 - 1));
    const sx = kappa / P.kappaPeak;
    const sy = tanA / Math.tan(w.ax.alphaPeak);
    const s = Math.hypot(sx, sy);
    if (s < 1e-6) return [0, 0, 0];
    if (s > P.sSlide) {
      // sliding speed in excess of the one at the onset slip
      const vs = Math.abs(vl) * Math.hypot(kappa, tanA) * (1 - P.sSlide / s);
      mu *= P.muSlide + (1 - P.muSlide) * Math.exp(-vs / P.vSlide);
    }
    const Bs = this.B * s;
    const F = Fz * mu * Math.sin(P.mfC * Math.atan(Bs));
    return [F * sx / s, F * sy / s, s];
  }

  step(dt, inp) {
    const P = this.P, T = this.track;
    this.prevX = this.x; this.prevY = this.y; this.prevPsi = this.psi;
    this.steer = inp.steer; this.throttle = inp.throttle; this.brake = inp.brake;
    const c = Math.cos(this.psi), s = Math.sin(this.psi);

    // ---- terrain at CG: height & gradient ----
    T.locate(this.x, this.y, this.loc.i, this.loc);
    const e = 0.5;
    const hx1 = T.height(this.x + e, this.y, this.loc.i), hx0 = T.height(this.x - e, this.y, this.loc.i);
    const hy1 = T.height(this.x, this.y + e, this.loc.i), hy0 = T.height(this.x, this.y - e, this.loc.i);
    const gx = (hx1 - hx0) / (2 * e), gy = (hy1 - hy0) / (2 * e);
    this.z = T.groundZ(this.x, this.y, this.loc);
    const slopeLong = gx * c + gy * s;   // dz per metre forward
    const slopeLat = -gx * s + gy * c;   // dz per metre to the left

    // ---- steering (Ackermann) ----
    const dm = this.steer * P.maxSteer;
    let dL = dm, dR = dm;
    if (Math.abs(dm) > 1e-4) {
      const Rt = P.L / Math.tan(Math.abs(dm));
      const inner = Math.atan(P.L / (Rt - P.tf / 2)), outer = Math.atan(P.L / (Rt + P.tf / 2));
      const di = Math.abs(dm) + (inner - Math.abs(dm)) * P.ackermann;
      const dout = Math.abs(dm) + (outer - Math.abs(dm)) * P.ackermann;
      if (dm > 0) { dL = di; dR = dout; } else { dL = -dout; dR = -di; }
    }
    this.wheels[0].delta = dL; this.wheels[1].delta = dR;

    // ---- wheels: position, surface and ground height (kerb relief, asphalt roughness) ----
    let rumble = 0, offCount = 0, beyond = 0;
    for (let k = 0; k < 4; k++) {
      const w = this.wheels[k];
      const wx = this.x + w.x * c - w.y * s, wy = this.y + w.x * s + w.y * c;
      T.locate(wx, wy, w.loc.i >= 0 ? w.loc.i : this.loc.i, w.loc);
      w.surf = T.surface(wx, wy, w.loc);
      w.grip = w.surf === SURF.track ? T.grip(w.loc) : 1;
      w.z = T.groundZ(wx, wy, w.loc) + T.roughness(w.loc);
      if (w.surf !== SURF.track && w.surf !== SURF.kerb) offCount++;
      // track limits: kerbs count as track; the edge is the kerb's outer edge, or the white line
      const left = w.loc.d > 0;
      const edge = (left ? w.loc.wl : w.loc.wr) + ((left ? w.loc.kerbL : w.loc.kerbR) ? KERB_W : 0);
      if (Math.abs(w.loc.d) - (k < 2 ? P.wF : P.wR) / 2 > edge) beyond++;
      rumble += w.surf.rumble;
    }
    this.vertical(dt);

    // ---- tyre forces ----
    let FX = 0, FY = 0, MZ = 0;
    let rearFx = 0, rearK = 0, slipMax = 0;
    const eps = 0.05;
    for (let k = 0; k < 4; k++) {
      const w = this.wheels[k];
      const vwx = this.u - this.r * w.y, vwy = this.v + this.r * w.x;
      const cd = Math.cos(w.delta), sd = Math.sin(w.delta);
      const vl = vwx * cd + vwy * sd, vt = -vwx * sd + vwy * cd;
      w.vl = vl; w.vt = vt;
      // transient slip (relaxation length): sigma*da/dt + |vl|*a = -vt  (implicit Euler)
      const avl = Math.abs(vl);
      w.alpha = clamp((w.alpha - dt * vt / P.relax) / (1 + dt * avl / P.relax), -2, 2);

      let fx, fy, sl;
      if (k >= 2) {
        const kap = this.kappaNext(w, this.wa, vl, dt);
        [fx, fy, sl] = this.tyre(w, w.Fz, w.surf.mu * w.grip, w.alpha, kap, vl);
        const fx2 = this.tyre(w, w.Fz, w.surf.mu * w.grip, w.alpha, this.kappaNext(w, this.wa + eps, vl, dt), vl)[0];
        rearFx += fx; rearK += (fx2 - fx) / eps;
      } else if (w.free && !(this.brake > 0 && P.brakeFront > 0)) {
        // unbraked front wheel on its own stub axle: rolls freely, no longitudinal slip
        [fx, fy, sl] = this.tyre(w, w.Fz, w.surf.mu * w.grip, w.alpha, 0, vl);
        w.spin = vl / w.R;
      } else {
        // front brake: the wheel spins on its own (inertia Iwf), braked by the caliper and driven
        // back by the tyre; implicit in the tyre's slip stiffness, like the rear axle below
        const mu = w.surf.mu * w.grip, Tb = this.brake * P.brakeFront, om = w.spin;
        [fx, fy, sl] = this.tyre(w, w.Fz, mu, w.alpha, this.kappaNext(w, om, vl, dt), vl);
        const dF = (this.tyre(w, w.Fz, mu, w.alpha, this.kappaNext(w, om + eps, vl, dt), vl)[0] - fx) / eps;
        const sw = Math.sign(om);
        let on;
        if (sw === 0 && Tb > 0 && Math.abs(w.R * fx) <= Tb) on = 0; // held still (locked)
        else {
          on = om + dt * (-w.R * fx - Tb * (sw || -Math.sign(fx))) / (P.Iwf + dt * w.R * Math.max(0, dF));
          if (Tb > 0 && sw !== 0 && Math.sign(on) !== sw) on = 0;
        }
        w.spin = on;
        w.kappa = this.kappaNext(w, on, vl, dt);
        // back to free rolling once released and the slip has died away
        if (Tb <= 0 && Math.abs(w.kappa) < 2e-3) { w.free = true; w.kappa = 0; } else w.free = false;
      }
      // standstill damping (tyre carcass), fades out above walking pace
      const damp = 1 - smooth(0.3, 1.5, Math.hypot(vl, vt));
      if (damp > 0) {
        const lim = P.mu * w.surf.mu * w.Fz;
        fy = clamp(fy - damp * 2500 * vt * w.Fz / 600, -lim, lim);
      }
      fx -= w.surf.crr * P.crrK * w.Fz * Math.tanh(vl * 4);
      w.Fx = fx; w.Fy = fy; w.slip = sl;
      slipMax = Math.max(slipMax, sl);
      const bx = fx * cd - fy * sd, by = fx * sd + fy * cd;
      FX += bx; FY += by;
      MZ += w.x * by - w.y * bx;
    }
    this.slip = slipMax;
    this.rearSlip = Math.max(this.wheels[2].slip, this.wheels[3].slip);
    this.frontSlip = Math.max(this.wheels[0].slip, this.wheels[1].slip);
    this.rumble = rumble / 4;
    this.offTrack = offCount >= 4;
    this.beyondLimits = beyond === 4;

    // ---- driveline: engine, centrifugal clutch, solid axle, rear brake ----
    const rpm = this.we * RPM;
    let Te = this.throttle * P.powerK * torqueCurve(P.tq, rpm);
    Te *= clamp((P.govRpm + P.govBand - rpm) / P.govBand, 0, 1);  // governor / rev limiter
    Te -= (1 - this.throttle) * (P.fric0 + P.fric1 * rpm) + P.fricC; // friction/pumping (engine braking)
    Te += Math.max(0, (P.idleRpm - rpm)) * 0.03;                  // idle control
    const ce = clamp((rpm - P.clutchIn) / P.clutchSpan, 0, 1);
    const cap = P.clutchCap * ce * ce;
    const Rr = P.Rr;
    const Tb = this.brake * P.brakeMax;
    const tyreT = Rr * rearFx;
    const kImp = dt * Rr * Math.max(0, rearK); // implicit tyre stiffness term (dT/dω · dt)

    let wa = this.wa, we = this.we;
    const sw = Math.sign(wa);
    // brake: kinetic torque opposing rotation, static hold at zero
    const axleStep = (Tin, I) => {
      if (sw === 0 && Tb > 0 && Math.abs(Tin - tyreT) <= Tb) return 0;
      const Tbr = sw !== 0 ? Tb * sw : Tb * Math.sign(Tin - tyreT);
      const n = wa + dt * (Tin - tyreT - Tbr) / (I + kImp);
      return Tb > 0 && sw !== 0 && Math.sign(n) !== sw ? 0 : n;
    };
    // try locked clutch (engine and axle as one inertia)
    const Ilock = P.Ia + P.Ie * P.G * P.G;
    const waL = axleStep(P.G * P.eff * Te, Ilock);
    const Tcl = Te - P.Ie * P.G * (waL - wa) / dt;
    const locked = Math.abs(Tcl) <= cap && Math.abs(we - P.G * wa) < 3;
    if (locked) {
      wa = waL;
      we = P.G * wa;
    } else {
      const Tc = cap * Math.tanh((we - P.G * wa) * 0.5);
      we += dt * (Te - Tc) / P.Ie;
      wa = axleStep(P.G * P.eff * Tc, P.Ia);
    }
    we = Math.max(we, 0);
    if (!locked && we < P.idleRpm / RPM * 0.6) we = P.idleRpm / RPM * 0.6;
    this.wa = wa; this.we = we; this.clutchLocked = locked;
    for (let k = 2; k < 4; k++) { const w = this.wheels[k]; w.kappa = this.kappaNext(w, wa, w.vl, dt); }

    // ---- body dynamics ----
    // aerodynamics: air velocity relative to the centre of pressure (kart motion, yaw rate, wind),
    // frontal and side-on areas; acting behind the CG it also yaws the kart into the airflow
    const wbx = this.windX * c + this.windY * s, wby = -this.windX * s + this.windY * c;
    const vax = this.u - wbx, vay = this.v + this.r * P.xcpCG - wby;
    const qa = 0.5 * P.rho * Math.hypot(vax, vay);
    this.Fxa = -qa * P.CdA * vax; this.Fya = -qa * P.CdAy * vay;
    FX += this.Fxa - P.m * g * slopeLong;
    FY += this.Fya - P.m * g * slopeLat;
    MZ += P.xcpCG * this.Fya;
    const ax = FX / P.m, ay = FY / P.m;
    this.u += (ax + this.v * this.r) * dt;
    this.v += (ay - this.u * this.r) * dt;
    this.r += (MZ / P.Iz) * dt;
    // low-speed stiction so the kart does not creep
    if (Math.abs(this.u) < 0.08 && this.throttle < 0.05 && Math.abs(this.v) < 0.08) {
      this.u *= 0.9; this.v *= 0.9; this.r *= 0.9;
    }
    const k = Math.min(1, dt / 0.06);
    this.axf += (ax - this.axf) * k;
    this.ayf += (ay - this.ayf) * k;
    this.ax = ax; this.ay = ay;
    // accelerations from the tyres and drag only (gravity removed): what the grip envelope limits
    this.axT = ax + g * slopeLong; this.ayT = ay + g * slopeLat;

    this.x += (this.u * c - this.v * s) * dt;
    this.y += (this.u * s + this.v * c) * dt;
    this.psi += this.r * dt;

    this.collide(dt);
    // safety net: never let a numerical blow-up reach the player
    const bad = !Number.isFinite(this.x + this.y + this.u + this.v + this.r + this.vd.z) ||
      this.speed > 40 || Math.abs(this.r) > 15 || Math.abs(this.vd.vz) > 6 || Math.abs(this.vd.th) > 0.6 || Math.abs(this.vd.ph) > 0.6;
    if (bad) { this.reset(this.loc.i); this.recovered = (this.recovered || 0) + 1; }
  }

  // Barriers: the bumper outline (convex hull) against the solid barrier blocks (Track.blockContacts,
  // separating axes, every side of every block). The contact is compliant, like a TecPro block and
  // a plastic bumper giving way: a spring-damper force over a few tens of milliseconds, during
  // which the kart turns flat onto the barrier and the tyres keep working. A rigid impulse at the
  // first corner to touch spun the kart at up to 20 rad/s after a 60 km/h hit. Past MAXPEN the
  // kart is pushed out and stopped: no barrier can be crossed (blocks are 0.55 m deep).
  collide(dt) {
    const T = this.track, P = this.P, HULL = this.hull, poly = this._poly || (this._poly = HULL.map(() => [0, 0]));
    const place = () => {
      const c = Math.cos(this.psi), s = Math.sin(this.psi);
      for (let q = 0; q < HULL.length; q++) {
        const [bx, by] = HULL[q];
        poly[q][0] = this.x + bx * c - by * s; poly[q][1] = this.y + bx * s + by * c;
      }
      return [c, s];
    };
    let [c, s] = place();
    const hits = T.blockContacts(poly, this.x, this.y);
    const prev = this._touching || (this._touching = new Set()), now = new Set();
    let impact = 0;
    if (hits.length) {
      let vx = this.u * c - this.v * s, vy = this.u * s + this.v * c;
      let dvx = 0, dvy = 0, dr = 0;
      for (const h of hits) {
        const { nx, ny, pen } = h;               // n points from the block towards the kart
        const rx = h.px - this.x, ry = h.py - this.y;
        const vpx = vx - this.r * ry, vpy = vy + this.r * rx; // contact point velocity
        const vn = vpx * nx + vpy * ny;
        const tx = -ny, ty = nx, vt = vpx * tx + vpy * ty;
        const Fn = Math.max(0, BARRIER.k * pen - BARRIER.c * vn);
        const Ft = -BARRIER.mu * Fn * Math.tanh(vt / 0.3);  // scrubbing along the blocks
        const Fx = Fn * nx + Ft * tx, Fy = Fn * ny + Ft * ty;
        dvx += Fx / P.m * dt; dvy += Fy / P.m * dt;
        dr += (rx * Fy - ry * Fx) / P.Iz * dt;
        now.add(h.block);
        if (!prev.has(h.block) && vn < 0) impact = Math.max(impact, -vn); // a new contact
        this.lastHit = { nx, ny, J: Fn * dt };
      }
      vx += dvx; vy += dvy; this.r += dr;
      this.u = vx * c + vy * s; this.v = -vx * s + vy * c;
      // the rear axle is dragged down with the kart
      if (impact > 0) this.wa = Math.min(this.wa, Math.max(0, this.u) / P.Rr + 3);
    }
    this._touching = now;
    // hard stop: never deeper than MAXPEN into a block
    for (let pass = 0; pass < 3; pass++) {
      const best = T.blockContact(poly, this.x, this.y);
      if (!best || best.pen <= BARRIER.maxPen) break;
      const { nx, ny } = best, ex = best.pen - BARRIER.maxPen;
      this.x += nx * ex; this.y += ny * ex;
      let vx = this.u * c - this.v * s, vy = this.u * s + this.v * c;
      const rx = best.px - this.x, ry = best.py - this.y;
      const vn = (vx - this.r * ry) * nx + (vy + this.r * rx) * ny;
      if (vn < 0) { // remove the inward speed at the contact (plastic)
        const rn = rx * ny - ry * nx, J = -vn / (1 / P.m + (rn * rn) / P.Iz);
        vx += J * nx / P.m; vy += J * ny / P.m; this.r += rn * J / P.Iz;
        this.u = vx * c + vy * s; this.v = -vx * s + vy * c;
      }
      [c, s] = place();
    }
    this.hit = Math.max(this.hit * Math.exp(-dt / 0.25), Math.min(1, impact / 5));
    if (impact > 0.3) this.hitImpulse = (this.hitImpulse || 0) + impact;
  }
}

// Barrier contact: TecPro block + bumper stiffness (N/m), damping (N s/m), scrubbing friction, and
// the deepest the bumper may go into a block (m). k 2 MN/m with 228 kg: contact lasts ~35 ms and a
// 60 km/h head-on hit sinks ~4 cm; damping 21 kN s/m (~0.5 of critical) gives back ~15-20 % of the
// speed, as foam-filled blocks do. The blocks' plastic skin is slippery (mu 0.05): with 0.3 the
// nose snagged and a 50 deg, 60 km/h hit spun the kart 265 deg (test/impact.mjs).
export const BARRIER = { k: 2.0e6, c: 21000, mu: 0.05, maxPen: 0.25 };

// chassis floor contact points (body frame)
const FLOOR = [[0.8, 0.45], [0.8, -0.45], [-0.8, 0.6], [-0.8, -0.6], [0, 0.66], [0, -0.66]];

// bumper outline (body frame: x forward, y left), Sodikart RT10 1865 x 1350 mm
export const OUTLINE = [
  [0.99, 0], [0.95, 0.32], [0.95, -0.32], [0.8, 0.6], [0.8, -0.6], [0.45, 0.66], [0.45, -0.66],
  [0.05, 0.64], [0.05, -0.64], [-0.35, 0.71], [-0.35, -0.71], [-0.62, 0.7], [-0.62, -0.7],
  [-0.84, 0.42], [-0.84, -0.42], [-0.88, 0],
];

// its convex hull, counter-clockwise (Andrew's monotone chain): what collides with the barriers
export function hullOf(outline) {
  const p = outline.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (hi.length > 1 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
export const HULL = hullOf(OUTLINE);
