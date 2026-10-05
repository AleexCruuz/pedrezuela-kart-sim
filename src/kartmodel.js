// Sodikart RT10 (2023 rental livery at Ángel Burgueño: graphite bodywork, roll bar,
// white number plate) or Sodi Sport Rotax (orange/blue 'SPORT' livery, number on the nose, no roll
// bar, water-cooled Rotax with its radiator left of the seat, front brake discs; data/ref fleet photo)
// + seated driver with two-bone arm IK onto the steering wheel.
// Local frame: X right, Y up, Z back (forward = -Z). Origin on the ground under the CG.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------- geometry helpers ----------

// rounded-rectangle profile (w x h, corner r) as a closed list of [u,v]
function rrect(w, h, r, seg = 4) {
  const pts = [];
  r = Math.min(r, w / 2, h / 2);
  const cs = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, Math.PI / 2], [-w / 2 + r, -h / 2 + r, Math.PI], [w / 2 - r, -h / 2 + r, 1.5 * Math.PI]];
  for (const [cx, cy, a0] of cs) for (let i = 0; i <= seg; i++) {
    const a = a0 + (Math.PI / 2) * (i / seg);
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

// sweep a 2D profile (u = sideways, v = up) along a 3D path; profile may vary along it
function sweep(path, profileAt, { closed = false, caps = true } = {}) {
  const n = path.length, pos = [], idx = [];
  const m = profileAt(0).length;
  const up = V(0, 1, 0), t = V(), s = V(), u2 = V();
  for (let i = 0; i < n; i++) {
    const a = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    t.subVectors(b, a).normalize();
    s.crossVectors(t, up);
    if (s.lengthSq() < 1e-8) s.set(1, 0, 0); else s.normalize();
    u2.crossVectors(s, t).normalize();
    for (const [pu, pv] of profileAt(i / (n - 1))) {
      pos.push(path[i].x + s.x * pu + u2.x * pv, path[i].y + s.y * pu + u2.y * pv, path[i].z + s.z * pu + u2.z * pv);
    }
  }
  const rings = closed ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const i2 = (i + 1) % n;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      const a = i * m + j, b = i * m + j2, c = i2 * m + j, d = i2 * m + j2;
      idx.push(a, b, c, b, d, c);
    }
  }
  if (!closed && caps) {
    for (const [ring, flip] of [[0, false], [n - 1, true]]) {
      const c = pos.length / 3;
      let cx = 0, cy = 0, cz = 0;
      for (let j = 0; j < m; j++) { cx += pos[(ring * m + j) * 3]; cy += pos[(ring * m + j) * 3 + 1]; cz += pos[(ring * m + j) * 3 + 2]; }
      pos.push(cx / m, cy / m, cz / m);
      for (let j = 0; j < m; j++) {
        const a = ring * m + j, b = ring * m + (j + 1) % m;
        flip ? idx.push(c, b, a) : idx.push(c, a, b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// loft through cross-sections {z, y, w, h, r, x?} (smooth path + smoothly varying section)
function loft(sections, steps = 24) {
  const curve = new THREE.CatmullRomCurve3(sections.map((s) => V(s.x || 0, s.y, s.z)));
  const pts = curve.getPoints(steps);
  const interp = (f, key) => {
    const k = f * (sections.length - 1), i = Math.min(sections.length - 2, Math.floor(k)), t = k - i;
    const a = sections[i][key], b = sections[i + 1][key];
    const tt = t * t * (3 - 2 * t);
    return a + (b - a) * tt;
  };
  return sweep(pts, (f) => rrect(interp(f, 'w'), interp(f, 'h'), interp(f, 'r'), 5));
}

function roundedBox(w, h, d, r) {
  return loft([
    { z: d / 2, y: 0, w: w * 0.86, h: h * 0.86, r },
    { z: d / 2 - r * 0.7, y: 0, w, h, r },
    { z: -d / 2 + r * 0.7, y: 0, w, h, r },
    { z: -d / 2, y: 0, w: w * 0.86, h: h * 0.86, r },
  ], 6);
}

function tube(points, r, segs = 48, closed = false) {
  const c = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.3);
  return new THREE.TubeGeometry(c, segs, r, 10, closed);
}

function plateTexture(num, dark = false) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = dark ? '#16171a' : '#f4f4f0'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = dark ? '#f4f4f0' : '#111'; g.lineWidth = 10; g.strokeRect(5, 5, 246, 246);
  g.fillStyle = dark ? '#f4f4f0' : '#111'; g.font = 'italic 900 170px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(num), 128, 138);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function liveryTexture() {
  // graphite bodywork with grey/white slashes, like the 2023 Sodi RT10 rental fleet
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#26282c'; g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#5f636a';
  g.beginPath(); g.moveTo(0, 170); g.lineTo(250, 40); g.lineTo(330, 40); g.lineTo(80, 190); g.closePath(); g.fill();
  g.fillStyle = '#e4e6e9';
  g.beginPath(); g.moveTo(150, 200); g.lineTo(380, 80); g.lineTo(420, 80); g.lineTo(190, 205); g.closePath(); g.fill();
  g.fillStyle = '#b8322a'; g.fillRect(430, 60, 60, 12);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function sportLiveryTexture() {
  // Sodi Sport fleet: orange bodywork, black lower half, blue and white slashes, 'SPORT' lettering
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ec5a14'; g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#17181b'; g.fillRect(0, 150, 512, 106);
  g.fillStyle = '#1f6fd6';
  g.beginPath(); g.moveTo(40, 150); g.lineTo(230, 60); g.lineTo(300, 60); g.lineTo(120, 150); g.closePath(); g.fill();
  g.fillStyle = '#f2f3f5';
  g.beginPath(); g.moveTo(140, 150); g.lineTo(320, 70); g.lineTo(350, 70); g.lineTo(175, 150); g.closePath(); g.fill();
  g.fillStyle = '#f2f3f5'; g.font = 'italic 900 64px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('SPORT', 400, 110);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Parts that never move relative to `group` (its leaf meshes, plus those of the listed static
// sub-groups) merged into one mesh per material: ~90 draw calls per kart down to ~30, in every pass.
function mergeStatic(group, statics = []) {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const sets = new Map();
  const visit = (o) => {
    for (const c of [...o.children]) {
      if (c.isMesh && !c.children.length && c.matrixWorld.determinant() > 0) {
        const key = c.material.uuid + (c.castShadow ? 'c' : '') + (c.receiveShadow ? 'r' : '');
        if (!sets.has(key)) sets.set(key, { mesh: c, parts: [] });
        sets.get(key).parts.push(c);
      } else if (statics.includes(c)) visit(c);
    }
  };
  visit(group);
  for (const { mesh, parts } of sets.values()) {
    if (parts.length < 2) continue;
    const geos = parts.map((m) => {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      return g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    });
    if (geos.some((g) => !g.attributes.normal || !g.attributes.uv)) continue;
    const merged = new THREE.Mesh(mergeGeometries(geos), mesh.material);
    merged.castShadow = mesh.castShadow; merged.receiveShadow = mesh.receiveShadow;
    for (const m of parts) { m.removeFromParent(); m.geometry.dispose(); }
    group.add(merged);
  }
}

// ---------- tyres & wheels ----------
function wheel(R, W, rimR, M) {
  const g = new THREE.Group();
  const prof = [];
  const sh = 0.028; // shoulder radius
  const inner = rimR + 0.004;
  prof.push(new THREE.Vector2(inner, -W / 2 + 0.012));
  prof.push(new THREE.Vector2(R - sh * 1.6, -W / 2));
  for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + (Math.PI / 2) * (i / 8); prof.push(new THREE.Vector2(R - sh + Math.cos(a) * sh, -W / 2 + sh + Math.sin(a) * sh)); }
  for (let i = 0; i <= 8; i++) { const a = (Math.PI / 2) * (i / 8); prof.push(new THREE.Vector2(R - sh + Math.cos(a) * sh, W / 2 - sh + Math.sin(a) * sh)); }
  prof.push(new THREE.Vector2(R - sh * 1.6, W / 2));
  prof.push(new THREE.Vector2(inner, W / 2 - 0.012));
  const tyre = new THREE.Mesh(new THREE.LatheGeometry(prof, 44), M.tyre);
  tyre.rotation.z = Math.PI / 2;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rimR, rimR, W * 0.94, 28, 1, true), M.rim);
  barrel.rotation.z = Math.PI / 2;
  const face = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.97, rimR * 0.97, 0.01, 28), M.rim);
  face.rotation.z = Math.PI / 2; face.position.x = W * 0.25;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.36, rimR * 0.36, W * 0.72, 16), M.hub);
  hub.rotation.z = Math.PI / 2;
  g.add(tyre, barrel, face, hub);
  for (let k = 0; k < 3; k++) { // three dark bolt pockets make rotation visible
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.014, 8), M.hub);
    const a = (k * Math.PI * 2) / 3;
    b.rotation.z = Math.PI / 2; b.position.set(W * 0.26, Math.cos(a) * rimR * 0.62, Math.sin(a) * rimR * 0.62);
    g.add(b);
  }
  g.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  mergeStatic(g);
  return g;
}

// ---------- the kart ----------
export class KartModel {
  constructor({ ghost = false, type = 'rt10', number = type === 'rotax' ? 15 : 27, suit = 0x1d2f55 } = {}) {
    const sport = type === 'rotax';
    const root = (this.root = new THREE.Group());
    root.rotation.order = 'YXZ';
    const body = (this.body = new THREE.Group());
    root.add(body);

    const M = {
      shell: new THREE.MeshPhysicalMaterial({ map: sport ? sportLiveryTexture() : liveryTexture(), roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.35 }),
      shellPlain: new THREE.MeshPhysicalMaterial({ color: sport ? 0x1b1c20 : 0x2a2c31, roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.4 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.78 }),
      grey: new THREE.MeshStandardMaterial({ color: 0x8c9096, roughness: 0.5 }),
      tube: new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.35, metalness: 0.6 }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.22, metalness: 1.0 }),
      tyre: new THREE.MeshStandardMaterial({ color: 0x1b1b1c, roughness: 0.88 }),
      rim: new THREE.MeshStandardMaterial({ color: 0xa9adb3, roughness: 0.3, metalness: 0.9 }),
      hub: new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.4, metalness: 0.7 }),
      honda: new THREE.MeshPhysicalMaterial({ color: 0xc8191e, roughness: 0.35, clearcoat: 0.7 }),
      seat: new THREE.MeshPhysicalMaterial({ color: 0x141518, roughness: 0.3, clearcoat: 0.8 }),
      plate: new THREE.MeshStandardMaterial({ map: plateTexture(number, sport), roughness: 0.5 }),
      alu: new THREE.MeshStandardMaterial({ color: 0xb4b8be, roughness: 0.38, metalness: 0.85 }),
      core: new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.9 }),
    };
    this.mats = M;
    const add = (geo, mat, parent = body) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };

    // chassis: floor tray and main rails
    add(new THREE.BoxGeometry(0.64, 0.012, 1.42).translate(0, 0.05, 0.02), M.tube);
    for (const s of [-1, 1]) {
      add(tube([V(s * 0.2, 0.06, -0.78), V(s * 0.3, 0.06, -0.35), V(s * 0.34, 0.06, 0.15), V(s * 0.36, 0.07, 0.5)], 0.016, 24), M.tube);
    }
    add(tube([V(-0.2, 0.06, -0.78), V(0, 0.07, -0.86), V(0.2, 0.06, -0.78)], 0.016, 12), M.tube);

    // wrap-around rubber bumper: front U, side pods, rear U enclosing the rear wheels
    const ring = [
      V(-0.68, 0.17, 0.62), V(-0.71, 0.17, 0.30), V(-0.63, 0.17, -0.02), V(-0.61, 0.17, -0.40),
      V(-0.66, 0.17, -0.72), V(-0.48, 0.16, -0.93), V(0, 0.15, -0.99), V(0.48, 0.16, -0.93),
      V(0.66, 0.17, -0.72), V(0.61, 0.17, -0.40), V(0.63, 0.17, -0.02), V(0.71, 0.17, 0.30),
      V(0.68, 0.17, 0.62), V(0.40, 0.17, 0.82), V(0, 0.17, 0.86), V(-0.40, 0.17, 0.82),
    ];
    const ringPts = new THREE.CatmullRomCurve3(ring, true, 'centripetal').getPoints(140);
    add(sweep(ringPts, (f) => {
      const zf = ringPts[Math.min(139, Math.round(f * 139))].z;
      return rrect(0.15, zf < -0.8 ? 0.19 : 0.24, 0.06, 4);
    }, { closed: true }), M.rubber);
    // side pods (livery) on the bumper between the wheels
    for (const s of [-1, 1]) add(loft([
      { z: -0.42, y: 0.25, w: 0.26, h: 0.14, r: 0.06, x: s * 0.52 },
      { z: -0.18, y: 0.29, w: 0.32, h: 0.19, r: 0.07, x: s * 0.53 },
      { z: 0.14, y: 0.29, w: 0.30, h: 0.19, r: 0.07, x: s * 0.55 },
      { z: 0.32, y: 0.25, w: 0.22, h: 0.13, r: 0.05, x: s * 0.57 },
    ], 16), M.shell);
    // rear bumper cover over the rear wheels
    add(loft([
      { z: 0.58, y: 0.31, w: 1.30, h: 0.09, r: 0.04 },
      { z: 0.72, y: 0.28, w: 1.34, h: 0.14, r: 0.06 },
      { z: 0.86, y: 0.21, w: 1.0, h: 0.16, r: 0.07 },
    ], 10), M.shellPlain);

    // nose cone: rises from the front bumper towards the steering column, carries the number
    add(loft([
      { z: -0.99, y: 0.21, w: 0.30, h: 0.12, r: 0.05 },
      { z: -0.86, y: 0.28, w: 0.42, h: 0.17, r: 0.075 },
      { z: -0.66, y: 0.35, w: 0.40, h: 0.15, r: 0.07 },
      { z: -0.48, y: 0.39, w: 0.32, h: 0.10, r: 0.05 },
      { z: -0.40, y: 0.38, w: 0.24, h: 0.06, r: 0.03 },
    ], 28), M.shell);
    const np = add(new THREE.PlaneGeometry(0.19, 0.16), M.plate);
    np.position.set(0, 0.245, -1.0); np.rotation.y = Math.PI; np.rotation.x = 0.35; // faces forward
    // front lip
    add(loft([
      { z: -0.99, y: 0.09, w: 1.05, h: 0.07, r: 0.03 },
      { z: -0.9, y: 0.1, w: 1.16, h: 0.08, r: 0.035 },
    ], 6), M.rubber);

    // bucket seat
    add(loft([
      { z: -0.02, y: 0.13, w: 0.36, h: 0.08, r: 0.04 },
      { z: 0.16, y: 0.13, w: 0.40, h: 0.10, r: 0.05 },
      { z: 0.30, y: 0.30, w: 0.42, h: 0.10, r: 0.05 },
      { z: 0.36, y: 0.52, w: 0.40, h: 0.08, r: 0.04 },
      { z: 0.38, y: 0.62, w: 0.34, h: 0.06, r: 0.03 },
    ], 20), M.seat);
    for (const s of [-1, 1]) add(loft([
      { z: 0.0, y: 0.2, w: 0.04, h: 0.12, r: 0.02, x: s * 0.2 },
      { z: 0.2, y: 0.26, w: 0.05, h: 0.2, r: 0.02, x: s * 0.21 },
      { z: 0.33, y: 0.42, w: 0.05, h: 0.26, r: 0.02, x: s * 0.2 },
    ], 10), M.seat);

    // roll bar with white number plate (RT10 only)
    if (!sport) {
    add(tube([V(-0.24, 0.22, 0.40), V(-0.23, 0.70, 0.46), V(-0.19, 1.02, 0.50), V(0, 1.06, 0.51), V(0.19, 1.02, 0.50), V(0.23, 0.70, 0.46), V(0.24, 0.22, 0.40)], 0.019, 60), M.tube);
    for (const s of [-1, 1]) add(tube([V(s * 0.23, 0.72, 0.46), V(s * 0.22, 0.45, 0.68), V(s * 0.22, 0.2, 0.74)], 0.014, 16), M.tube);
    const plate = add(new THREE.BoxGeometry(0.30, 0.26, 0.008), M.plate);
    plate.position.set(0, 0.86, 0.505);
    }

    const eng = new THREE.Group(); eng.position.set(0.40, 0.08, 0.30); body.add(eng);
    if (!sport) {
      // engine: Honda GX270 on the right of the seat
      add(roundedBox(0.26, 0.26, 0.30, 0.04), M.honda, eng).position.set(0, 0.2, 0);
      add(new THREE.CylinderGeometry(0.075, 0.075, 0.2, 16).rotateZ(Math.PI / 2).translate(0.1, 0.22, -0.02), M.chrome, eng);
      add(roundedBox(0.2, 0.12, 0.18, 0.03), M.rubber, eng).position.set(-0.02, 0.4, -0.05);
      add(new THREE.CylinderGeometry(0.06, 0.06, 0.26, 16).rotateX(Math.PI / 2).translate(0.13, 0.26, 0.2), M.chrome, eng);
    } else {
      // Rotax 125 2T on the right of the seat: crankcase, finned cylinder, carburettor + airbox,
      // expansion chamber curling back behind the seat to the silencer
      add(roundedBox(0.2, 0.16, 0.22, 0.03), M.alu, eng).position.set(0, 0.14, 0);
      add(new THREE.CylinderGeometry(0.06, 0.065, 0.16, 18).translate(0.02, 0.29, 0.0), M.alu, eng);
      for (let f = 0; f < 5; f++) add(new THREE.CylinderGeometry(0.085, 0.085, 0.008, 18).translate(0.02, 0.24 + f * 0.024, 0), M.alu, eng);
      add(roundedBox(0.12, 0.1, 0.16, 0.03), M.core, eng).position.set(-0.04, 0.22, -0.2);
      add(tube([V(0.05, 0.26, 0.06), V(0.14, 0.22, 0.2), V(0.1, 0.18, 0.36), V(-0.15, 0.2, 0.42), V(-0.45, 0.22, 0.38)], 0.045, 30), M.chrome, eng);
      add(new THREE.CylinderGeometry(0.05, 0.05, 0.22, 16).rotateZ(Math.PI / 2).translate(-0.58, 0.22, 0.36), M.core, eng);
      // radiator on the left of the seat
      add(roundedBox(0.04, 0.28, 0.22, 0.01), M.core).position.set(-0.36, 0.36, 0.12);
      add(roundedBox(0.05, 0.3, 0.025, 0.008), M.alu).position.set(-0.36, 0.36, 0.0);
      add(roundedBox(0.05, 0.3, 0.025, 0.008), M.alu).position.set(-0.36, 0.36, 0.24);
    }

    // rear axle, sprocket guard
    add(new THREE.CylinderGeometry(0.02, 0.02, 1.08, 10).rotateZ(Math.PI / 2).translate(0, 0.14, 0.44), M.chrome);
    add(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 24).rotateZ(Math.PI / 2).translate(0.33, 0.14, 0.44), M.rubber);

    // pedals
    for (const s of [-1, 1]) {
      const p = add(new THREE.BoxGeometry(0.07, 0.11, 0.015), M.chrome);
      p.position.set(s * 0.1, 0.2, -0.72); p.rotation.x = -0.4;
    }

    // wheels: [FL, FR, RL, RR] like the simulation
    this.wheels = [];
    for (const [x, z, R, w] of [[-0.51, -0.61, 0.128, 0.13], [0.51, -0.61, 0.128, 0.13], [-0.55, 0.44, 0.14, 0.19], [0.55, 0.44, 0.14, 0.19]]) {
      const steer = new THREE.Group();
      steer.position.set(x, R, z);
      const wh = wheel(R, w, 0.064, M);
      if (x < 0) wh.rotation.y = Math.PI; // rim face outwards
      if (sport && z < 0) { // front brake disc inboard of the rim
        const d = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.006, 24).rotateZ(Math.PI / 2), M.chrome);
        d.position.x = (x < 0 ? 1 : -1) * (w / 2 + 0.012); d.castShadow = true; wh.add(d);
      }
      const spin = new THREE.Group(); spin.add(wh);
      steer.add(spin); root.add(steer);
      this.wheels.push({ steer, spin });
    }
    for (const s of [-1, 1]) add(tube([V(s * 0.28, 0.1, -0.61), V(s * 0.45, 0.12, -0.61)], 0.012, 4), M.chrome);

    // steering column + wheel
    const col = new THREE.Group();
    col.position.set(0, 0.57, -0.17);
    col.rotation.x = -0.95; // column inclination
    body.add(col);
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.62, 10).translate(0, -0.31, 0), M.chrome, col);
    const sw = (this.sw = new THREE.Group());
    col.add(sw);
    sw.rotation.x = -Math.PI / 2;
    const swSpin = (this.swSpin = new THREE.Group());
    sw.add(swSpin);
    add(new THREE.TorusGeometry(0.15, 0.014, 12, 64), M.rubber, swSpin);
    for (const a of [Math.PI, 0]) {
      const grip = add(new THREE.TorusGeometry(0.15, 0.02, 12, 24, 1.0), M.rubber, swSpin);
      grip.rotation.z = a - 0.5;
    }
    for (const a of [Math.PI / 2 + 2.1, Math.PI / 2 - 2.1, -Math.PI / 2]) {
      const sp = add(new THREE.BoxGeometry(0.03, 0.15, 0.008), M.grey, swSpin);
      sp.position.set(Math.cos(a) * 0.075, Math.sin(a) * 0.075, -0.004);
      sp.rotation.z = a - Math.PI / 2;
    }
    add(new THREE.CylinderGeometry(0.045, 0.05, 0.03, 24).rotateX(Math.PI / 2), M.hub, swSpin);

    mergeStatic(body, [eng, col]);
    mergeStatic(swSpin);

    // driver
    this.driver = new Driver({ suit });
    body.add(this.driver.group);

    if (ghost) {
      root.traverse((m) => {
        if (m.isMesh) {
          m.material = new THREE.MeshBasicMaterial({ color: 0x5ab0ff, transparent: true, opacity: 0.22, depthWrite: false });
          m.castShadow = false;
        }
      });
    }
  }

  setCockpit(on) { this.driver.setCockpit(on); }

  update(k, dt) {
    const r = this.root;
    // chassis pose straight from the vertical dynamics (heave, pitch, roll: kerb hops, wheel lift)
    r.position.set(k.x, k.bodyZ, -k.y);
    r.rotation.y = k.psi - Math.PI / 2;
    r.rotation.x = k.pitch;
    r.rotation.z = -k.roll;
    const w = k.wheels;
    for (let i = 0; i < 4; i++) {
      const W = this.wheels[i];
      if (i < 2) W.steer.rotation.y = w[i].delta;
      W.spin.rotation.x -= (i < 2 ? w[i].spin : k.wa) * dt;
    }
    const swAng = k.steer * 1.65; // about ±95° at the wheel for full lock
    this.swSpin.rotation.z = swAng;
    this.driver.update(this, k);
  }
}

// ---------- driver ----------
class Driver {
  constructor({ suit }) {
    const G = (this.group = new THREE.Group());
    const suitM = new THREE.MeshStandardMaterial({ color: suit, roughness: 0.85 });
    const suitM2 = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.85 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.7 });
    const helmetM = new THREE.MeshPhysicalMaterial({ color: 0xf1f1f1, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 });
    const stripe = new THREE.MeshPhysicalMaterial({ color: 0xd22d2d, roughness: 0.3, clearcoat: 1 });
    const visorM = new THREE.MeshPhysicalMaterial({ color: 0x0b0c10, roughness: 0.05, metalness: 0.4, clearcoat: 1 });
    const boot = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.6 });
    const add = (geo, mat, parent = G) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; parent.add(m); return m; };

    // torso lofted from the hips to the shoulders, leaning back into the seat
    this.torso = add(loft([
      { z: 0.22, y: 0.20, w: 0.34, h: 0.20, r: 0.09 },
      { z: 0.27, y: 0.38, w: 0.36, h: 0.22, r: 0.1 },
      { z: 0.30, y: 0.56, w: 0.40, h: 0.22, r: 0.1 },
      { z: 0.31, y: 0.66, w: 0.34, h: 0.18, r: 0.08 },
    ], 16), suitM);
    this.collar = add(new THREE.TorusGeometry(0.075, 0.03, 10, 24).rotateX(Math.PI / 2).translate(0, 0.70, 0.30), suitM2);
    // helmet
    const head = (this.head = new THREE.Group());
    head.position.set(0, 0.85, 0.29);
    G.add(head);
    add(new THREE.SphereGeometry(0.145, 32, 24).scale(0.95, 1.0, 1.1), helmetM, head);
    add(new THREE.SphereGeometry(0.147, 32, 12, 0, Math.PI * 2, 0.05, 0.35).scale(0.95, 1, 1.1), stripe, head);
    add(new THREE.SphereGeometry(0.149, 32, 16, Math.PI * 0.62, Math.PI * 0.76, Math.PI * 0.36, Math.PI * 0.2).scale(0.95, 1.0, 1.1), visorM, head);
    add(new THREE.CylinderGeometry(0.11, 0.12, 0.06, 24).translate(0, -0.12, -0.01), helmetM, head);
    mergeStatic(head);

    // legs towards the pedals (mostly under the nose cone)
    for (const s of [-1, 1]) {
      add(tube([V(s * 0.1, 0.18, 0.18), V(s * 0.11, 0.27, -0.12), V(s * 0.11, 0.3, -0.25)], 0.065, 10), suitM);
      add(tube([V(s * 0.11, 0.3, -0.25), V(s * 0.1, 0.24, -0.52), V(s * 0.1, 0.2, -0.66)], 0.05, 10), suitM);
      add(roundedBox(0.09, 0.12, 0.2, 0.03), boot).position.set(s * 0.1, 0.2, -0.74);
    }

    // arms (upper, fore, cuff, glove) placed every frame with two-bone IK
    this.arms = [-1, 1].map((s) => {
      const upper = add(new THREE.CapsuleGeometry(0.048, 1, 6, 12), suitM);
      const fore = add(new THREE.CapsuleGeometry(0.042, 1, 6, 12), suitM);
      const cuff = add(new THREE.CylinderGeometry(0.047, 0.05, 0.06, 14), suitM2);
      const hand = new THREE.Group(); G.add(hand);
      add(roundedBox(0.085, 0.04, 0.1, 0.018), glove, hand);
      add(new THREE.TorusGeometry(0.028, 0.019, 8, 12, Math.PI * 1.3).rotateY(Math.PI / 2).translate(0, -0.012, -0.02), glove, hand);
      return { s, upper, fore, cuff, hand, shoulder: V(s * 0.2, 0.64, 0.29), L1: 0.29, L2: 0.27 };
    });
    this._dir = V(); this._tmp = V(); this._inv = new THREE.Matrix4();
    this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion();
  }

  setCockpit(on) { this.head.visible = !on; this.torso.visible = !on; this.collar.visible = !on; }

  place(mesh, a, b, rad) {
    const len = a.distanceTo(b);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.scale.set(1, Math.max(0.05, len - rad * 2), 1);
    mesh.quaternion.setFromUnitVectors(V(0, 1, 0), this._dir.subVectors(b, a).normalize());
  }

  update(kartModel, k) {
    const sw = kartModel.swSpin;
    sw.updateWorldMatrix(true, false);
    this.group.updateWorldMatrix(true, false);
    this._inv.copy(this.group.matrixWorld).invert();
    // lateral g pushes head and shoulders to the outside of the turn
    const lean = Math.max(-1, Math.min(1, (k.ayf || 0) / 12));
    this.head.rotation.z = lean * 0.18;
    this.head.position.x = lean * 0.04;
    sw.getWorldQuaternion(this._q);
    this._q2.copy(this.group.getWorldQuaternion(new THREE.Quaternion())).invert().multiply(this._q);
    for (const A of this.arms) {
      const ang = A.s < 0 ? Math.PI : 0; // 9 and 3 o'clock, rotating with the wheel
      const H = V(Math.cos(ang) * 0.15, Math.sin(ang) * 0.15, 0.015).applyMatrix4(sw.matrixWorld).applyMatrix4(this._inv);
      const S = A.shoulder.clone(); S.x += lean * 0.03;
      const d = Math.min(A.L1 + A.L2 - 1e-3, S.distanceTo(H));
      const dir = H.clone().sub(S).normalize();
      const a = (A.L1 * A.L1 - A.L2 * A.L2 + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, A.L1 * A.L1 - a * a));
      const hint = this._tmp.set(A.s * 0.8, -1, 0.1).normalize();
      hint.sub(dir.clone().multiplyScalar(hint.dot(dir))).normalize();
      const E = S.clone().addScaledVector(dir, a).addScaledVector(hint, h);
      this.place(A.upper, S, E, 0.048);
      this.place(A.fore, E, H, 0.042);
      A.cuff.position.copy(H).lerp(E, 0.2);
      A.cuff.quaternion.copy(A.fore.quaternion);
      A.hand.position.copy(H);
      A.hand.quaternion.copy(this._q2).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, ang + Math.PI / 2)));
    }
  }
}
