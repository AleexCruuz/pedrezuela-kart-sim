// Scene construction: image-based lighting (HDRI), terrain (IGN ortho + DEM), PBR track
// surface, kerbs, TecPro-style barriers, pit wall, buildings, lattice light towers.
// Three.js frame: X = east, Y = up, Z = south  (local y north -> -Z).

import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KERB_W } from './track.js';

export const toV3 = (x, y, z, v = new THREE.Vector3()) => v.set(x, z, -y);

const texLoader = new THREE.TextureLoader();
// every PBR texture is awaited before the first frame so it can be uploaded to the GPU up front
// (a 4k JPEG decoded + uploaded the first time a building comes into view stalls the frame)
const pending = [];
let ANISO = 8; // max of the GPU, for the ortho photos (ground seen at grazing angles)
// one image per file: a second request returns a clone sharing the same source, so the GPU keeps a
// single copy (repeat/offset are per-texture uniforms)
const cache = new Map();
const load = (url) => {
  if (cache.has(url)) {
    const { tex, ready } = cache.get(url), c = tex.clone();
    pending.push(ready.then(() => { c.needsUpdate = true; }));
    return c;
  }
  let t;
  const ready = new Promise((ok, err) => { t = texLoader.load(url, ok, undefined, err); });
  cache.set(url, { tex: t, ready });
  pending.push(ready);
  return t;
};
// Tiled PBR sets: 4x anisotropic on the colour map, 2x on normal/roughness. Their fine grain averages
// out at distance anyway, and 16x on the asphalt (seen at grazing angles all the lap) cost more GPU
// than the rest of the scene at 2x resolution (48 -> 60 fps on an M2).
// diff: false skips the colour map; small: 1024 px normal/roughness (`_nor_1k`, `_rough_1k`)
function pbr(name, { repeat = 1, srgb = true, rough = true, nor = true, diff = true, small = false } = {}) {
  const set = (t, color) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = color ? 4 : 2;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return {
    map: diff ? set(load(`assets/ph/${name}_diff.jpg`), srgb) : null,
    normalMap: nor ? set(load(`assets/ph/${name}_nor${small ? '_1k' : ''}.jpg`)) : null,
    roughnessMap: rough ? set(load(`assets/ph/${name}_rough${small ? '_1k' : ''}.jpg`)) : null,
  };
}

// brightest pixel of an equirect HDR (half float) -> sun direction (three.js equirect convention)
function sunFromHDR(tex) {
  const { data, width: W, height: H } = tex.image;
  const f = THREE.DataUtils.fromHalfFloat;
  let best = -1, bi = 0;
  for (let i = 0; i < W * H; i++) {
    const l = f(data[i * 4]) * 0.2126 + f(data[i * 4 + 1]) * 0.7152 + f(data[i * 4 + 2]) * 0.0722;
    if (l > best) { best = l; bi = i; }
  }
  const u = ((bi % W) + 0.5) / W, v = 1 - (Math.floor(bi / W) + 0.5) / H;
  const lon = (u - 0.5) * 2 * Math.PI, lat = (v - 0.5) * Math.PI;
  return new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)).normalize();
}

function heightGridMesh(grid, tex, opts = {}) {
  const { n, step, x0, y0, z } = grid;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), uv1 = new Float32Array(n * n * 2);
  const size = step * (n - 1);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const k = r * n + c;
    const x = x0 + c * step, y = y0 - r * step;
    const h = opts.height ? opts.height(x, y, z[k]) : z[k];
    pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = -y;
    uv[k * 2] = (x - x0) / size; uv[k * 2 + 1] = 1 - (y0 - y) / size;
    uv1[k * 2] = x / 3; uv1[k * 2 + 1] = y / 3; // 3 m tiling for detail maps
  }
  const idx = [];
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const a = r * n + c, b = a + 1, d = a + n, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  geo.computeVertexNormals();
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISO;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, ...(opts.mat || {}) });
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = !!opts.shadow;
  return m;
}

// Static meshes that span the whole circuit (track, kerbs, terrain) are split into square cells so the
// camera and the shadow camera (80 m around the kart) only draw the cells they actually see; as single
// meshes their bounding sphere covers everything and they were drawn in full every frame, twice.
function splitCells(geo, cell) {
  const pos = geo.attributes.position, idx = geo.index.array;
  const buckets = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const key = Math.floor(cx / cell) * 100000 + Math.floor(cz / cell);
    let arr = buckets.get(key);
    if (!arr) buckets.set(key, (arr = []));
    arr.push(a, b, c);
  }
  const remap = new Int32Array(pos.count);
  return [...buckets.values()].map((tri) => {
    remap.fill(-1);
    const order = [];
    const ni = tri.map((v) => (remap[v] < 0 ? (remap[v] = order.push(v) - 1) : remap[v]));
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geo.attributes)) {
      const sz = attr.itemSize, src = attr.array, dst = new src.constructor(order.length * sz);
      order.forEach((o, j) => { for (let k = 0; k < sz; k++) dst[j * sz + k] = src[o * sz + k]; });
      g.setAttribute(name, new THREE.BufferAttribute(dst, sz, attr.normalized));
    }
    g.setIndex(ni);
    return g;
  });
}
function addCells(scene, mesh, cell) {
  for (const g of splitCells(mesh.geometry, cell)) {
    const m = new THREE.Mesh(g, mesh.material);
    m.castShadow = mesh.castShadow; m.receiveShadow = mesh.receiveShadow;
    scene.add(m);
  }
  mesh.geometry.dispose();
}

function ribbon(pos, idx, extra = {}) {
  const g = new THREE.BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  for (const [k, [arr, sz]] of Object.entries(extra)) g.setAttribute(k, new THREE.Float32BufferAttribute(arr, sz));
  g.computeVertexNormals();
  return g;
}

export async function buildWorld(scene, track, terrain, tex, buildings, renderer) {
  const T = track, n = T.n;
  // grazing angles (asphalt ahead, ortho ground) stay sharp only with full anisotropic filtering
  ANISO = renderer.capabilities.getMaxAnisotropy();

  // ---------- image-based lighting ----------
  // half float: same look, half the memory of the 2k sky (CPU copy and GPU texture)
  const hdr = await new RGBELoader().setDataType(THREE.HalfFloatType).loadAsync('assets/ph/sky_2k.hdr');
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const sunDir = sunFromHDR(hdr);
  // rotate the sky so the sun sits to the south-west (afternoon at Pedrezuela)
  const want = Math.atan2(-0.62, -0.78), have = Math.atan2(sunDir.z, sunDir.x);
  const rotY = have - want;
  scene.background = hdr;
  scene.environment = hdr;
  scene.backgroundRotation.set(0, rotY, 0);
  scene.environmentRotation.set(0, rotY, 0);
  scene.environmentIntensity = 0.75;
  sunDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
  const sunElev = Math.asin(sunDir.y);

  const dir = new THREE.DirectionalLight(0xfff0dc, 3.2);
  dir.position.copy(sunDir).multiplyScalar(150);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  const sc = dir.shadow.camera;
  sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 400;
  dir.shadow.bias = -0.0003; dir.shadow.normalBias = 0.02;
  scene.add(dir, dir.target);
  scene.fog = new THREE.Fog(0xb9c6d3, 2500, 45000);

  // ---------- terrain ----------
  const fn = 161, fstep = 2;
  const fine = { n: fn, step: fstep, x0: -160, y0: 160, z: new Float32Array(fn * fn) };
  const loc = T.newLoc();
  for (let r = 0; r < fn; r++) for (let c = 0; c < fn; c++) {
    const x = -160 + c * fstep, y = 160 - r * fstep;
    T.locate(x, y, -1, loc);
    let h = T.groundZ(x, y, loc);
    const w = loc.d > 0 ? loc.wl : loc.wr;
    if (Math.abs(loc.d) < w + KERB_W + 1.5) h -= 0.12;
    fine.z[r * fn + c] = h;
  }
  const ground = pbr('dry_ground_01', { nor: false });
  ground.roughnessMap.channel = 1;
  const conc = pbr('concrete_floor_02', { rough: false });
  conc.normalMap.channel = 1;
  const nearMesh = heightGridMesh(fine, tex.ortho, {
    shadow: true,
    mat: { normalMap: conc.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: ground.roughnessMap },
  });
  addCells(scene, nearMesh, 80);
  const sink = (half, depth) => (x, y, z) => (Math.abs(x) < half && Math.abs(y) < half ? z - depth : z);
  const farMesh = heightGridMesh(terrain.far, tex.far, { height: sink(158, 2.5) });
  addCells(scene, farMesh, (terrain.far.step * (terrain.far.n - 1)) / 3);
  const horizonMesh = heightGridMesh(terrain.horizon, tex.horizon, { height: sink(2950, 8) });
  addCells(scene, horizonMesh, (terrain.horizon.step * (terrain.horizon.n - 1)) / 3);

  // ---------- track surface (PBR asphalt + rubbered line) ----------
  // The dark band follows the same rubber the physics uses (T.rubber, see Track.gripAt):
  // a narrow core where the tyres run plus a wide soft halo, heavier in corners (tyres scrub
  // more rubber off) and uneven along the lap; dusty asphalt off the line is a touch lighter.
  // ~0.3 m columns so the vertex-colour gradient reads as a blur, not as steps.
  const COLS = 36;
  const pos = [], uvs = [], col = [], idx = [];
  const P = new THREE.Vector3();
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let i = 0; i <= n; i++) {
    const k = i % n, wl = T.wl[k], wr = T.wr[k], s = i === n ? T.length : T.s[k];
    const amount = (0.75 + 0.35 * sstep(0.01, 0.08, Math.abs(T.rubberK[k]))) *
      (0.88 + 0.07 * Math.sin(s * 0.11) + 0.05 * Math.sin(s * 0.37 + 1.3));
    for (let c = 0; c <= COLS; c++) {
      const off = -wr + (wl + wr) * (c / COLS);
      toV3(T.x[k] + T.nx[k] * off, T.y[k] + T.ny[k] * off, T.surfZ(k, off) + 0.005, P);
      pos.push(P.x, P.y, P.z);
      uvs.push(off / 3, s / 3);
      const dl = off - T.rubber[k];
      const rub = 0.7 * Math.exp(-(dl * dl) / (2 * 0.55 * 0.55)) + 0.3 * Math.exp(-(dl * dl) / (2 * 1.5 * 1.5));
      const dust = sstep(1.0, 2.5, Math.abs(dl));
      const edge = Math.min(1, Math.min(wl - off, off + wr) / 1.0);
      const v = (1 - 0.45 * rub * amount) * (1 + 0.04 * dust) * (1.08 - 0.08 * edge);
      col.push(v, v, v);
    }
  }
  for (let i = 0; i < n; i++) for (let c = 0; c < COLS; c++) {
    const a = i * (COLS + 1) + c, b = a + 1, d = a + COLS + 1, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  // normal/roughness at 1024: their grain is sub-centimetre and sampled at 2x anisotropy, so the
  // 2048 versions cost 4x the memory for no visible difference
  const asph = pbr('asphalt_track', { diff: false, small: true });
  // sun-aged, light grey binder like the real track (photos in data/ref); the Poly Haven
  // diffuse is fresh black asphalt; asphalt_aged_diff.jpg is it desaturated and lightened.
  asph.map = pbr('asphalt_aged', { rough: false, nor: false }).map;
  const trackMat = new THREE.MeshStandardMaterial({
    ...asph, vertexColors: true, color: 0xd8d8d4, normalScale: new THREE.Vector2(1.2, 1.2),
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const trackMesh = new THREE.Mesh(ribbon(pos, idx, { uv: [uvs, 2], color: [col, 3] }), trackMat);
  trackMesh.receiveShadow = true;
  addCells(scene, trackMesh, 60);

  // ---------- repairs: patches and sealed cracks, where the physics feels them (Track.buildRelief) ----------
  {
    const R = T.relief || T.buildRelief();
    const at = (s, d, dz, out) => { // track coordinates -> scene
      s = ((s % T.length) + T.length) % T.length;
      const i = T.indexAt(s), j = (i + 1) % n, l = Math.hypot(T.x[j] - T.x[i], T.y[j] - T.y[i]), f = (s - T.s[i]) / l;
      const nx = T.nx[i] + (T.nx[j] - T.nx[i]) * f, ny = T.ny[i] + (T.ny[j] - T.ny[i]) * f;
      const x = T.x[i] + (T.x[j] - T.x[i]) * f + nx * d, y = T.y[i] + (T.y[j] - T.y[i]) * f + ny * d;
      const z = T.z[i] + (T.z[j] - T.z[i]) * f + d * (T.camber[i] + (T.camber[j] - T.camber[i]) * f);
      return toV3(x, y, z + dz, out);
    };
    // patches: newer, darker binder with its own grain; a grid so they follow the camber
    const pp = [], pu = [], pc = [], pi = [];
    for (const p of R.patches) {
      const NS = Math.max(2, Math.ceil(p.ls / 0.3)), ND = Math.max(2, Math.ceil(p.ld / 0.3)), base = pp.length / 3;
      const tone = 0.76 + 0.1 * ((p.s * 7.3) % 1);
      for (let a = 0; a <= NS; a++) for (let b = 0; b <= ND; b++) {
        const ss = (a / NS) * p.ls, dd = (b / ND - 0.5) * p.ld;
        at(p.s + ss + dd * p.rot, p.d + dd, 0.007 + Math.max(0, p.h), P);
        pp.push(P.x, P.y, P.z); pu.push((p.d + dd) / 3, (p.s + ss) / 3);
        // rubber laid on it like on the asphalt around (same core + halo as the track colours)
        const dl = p.d + dd - T.rubber[T.indexAt(p.s + ss)];
        const rub = 0.7 * Math.exp(-(dl * dl) / (2 * 0.55 * 0.55)) + 0.3 * Math.exp(-(dl * dl) / (2 * 1.5 * 1.5));
        const rim = Math.min(a, NS - a, b, ND - b) === 0 ? 0.9 : 1; // edges a touch darker (sealed seam)
        const v = tone * rim * (1 - 0.35 * rub) * (0.96 + 0.08 * Math.sin(a * 2.3 + b * 4.1 + p.s));
        pc.push(v, v, v * 0.985);
      }
      for (let a = 0; a < NS; a++) for (let b = 0; b < ND; b++) {
        const q = base + a * (ND + 1) + b;
        pi.push(q, q + 1, q + ND + 1, q + 1, q + ND + 2, q + ND + 1);
      }
    }
    const patchMat = trackMat.clone();
    patchMat.polygonOffsetFactor = -3; patchMat.polygonOffsetUnits = -3; patchMat.side = THREE.DoubleSide;
    const patchMesh = new THREE.Mesh(ribbon(pp, pi, { uv: [pu, 2], color: [pc, 3] }), patchMat);
    patchMesh.receiveShadow = true;
    addCells(scene, patchMesh, 60);
    // cracks: black bitumen sealant lines, ~4 cm wide, slightly wavy
    const cp = [], ci = [];
    for (const c of R.cracks) {
      const steps = Math.max(2, Math.ceil((c.b - c.a) / 0.15)), base = cp.length / 3, w = 0.02 + 0.015 * ((c.s * 3.1) % 1);
      for (let q = 0; q <= steps; q++) {
        const d = c.a + (c.b - c.a) * (q / steps), s = c.s + (d - c.a) * c.skew + 0.03 * Math.sin(d * 9 + c.s);
        at(s - w, d, 0.0075, P); cp.push(P.x, P.y, P.z);
        at(s + w, d, 0.0075, P); cp.push(P.x, P.y, P.z);
      }
      for (let q = 0; q < steps; q++) { const a = base + q * 2; ci.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const crackMesh = new THREE.Mesh(ribbon(cp, ci, {}), new THREE.MeshStandardMaterial({
      color: 0x1d1d1e, roughness: 0.4, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    crackMesh.receiveShadow = true;
    addCells(scene, crackMesh, 60);
  }

  // ---------- kerbs: CIK hump + transverse ridges (same profile the physics uses) ----------
  const kp = [], kc = [], kidx = [];
  const red = [0.62, 0.06, 0.05], white = [0.86, 0.86, 0.84];
  const KC = 8, SUB = 10; // 8 across, 10 slices per metre (ridges are 0.4 m apart)
  for (const side of [1, -1]) {
    const flags = side > 0 ? T.kl : T.kr;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (!flags[i] || !flags[j]) continue;
      const KP = side > 0 ? T.klp : T.krp, KL = side > 0 ? T.kll : T.krl;
      const base = kp.length / 3;
      for (let q = 0; q <= SUB; q++) {
        const f = q / SUB;
        const x = T.x[i] + (T.x[j] - T.x[i]) * f, y = T.y[i] + (T.y[j] - T.y[i]) * f;
        const nx = T.nx[i] + (T.nx[j] - T.nx[i]) * f, ny = T.ny[i] + (T.ny[j] - T.ny[i]) * f;
        const wi = side > 0 ? T.wl[i] + (T.wl[j] - T.wl[i]) * f : T.wr[i] + (T.wr[j] - T.wr[i]) * f;
        const sAt = T.s[i] + f * Math.hypot(T.x[j] - T.x[i], T.y[j] - T.y[i]);
        const zE = T.z[i] + (T.z[j] - T.z[i]) * f + side * wi * (T.camber[i] + (T.camber[j] - T.camber[i]) * f);
        const pos = KP[i] + f * Math.hypot(T.x[j] - T.x[i], T.y[j] - T.y[i]);
        const ramp = T.kerbRamp(pos, KL[i]);
        const cr = (Math.floor(pos) % 2 === 0) ? red : white; // 1 m blocks counted from the kerb start
        for (let c = 0; c <= KC; c++) {
          const uu = c / KC;
          const off = side * (wi - 0.02 + uu * KERB_W);
          toV3(x + nx * off, y + ny * off, zE + ramp * (T.kerbProfile(uu) + T.kerbRidge(sAt, uu)) + 0.004, P);
          kp.push(P.x, P.y, P.z);
          kc.push(...cr);
        }
      }
      for (let q = 0; q < SUB; q++) for (let c = 0; c < KC; c++) {
        const a = base + q * (KC + 1) + c, b = a + 1, d = a + KC + 1, e = d + 1;
        if (side > 0) kidx.push(a, d, b, b, d, e); else kidx.push(a, b, d, b, e, d);
      }
    }
  }
  const kerbMesh = new THREE.Mesh(ribbon(kp, kidx, { color: [kc, 3] }), new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.5, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  }));
  kerbMesh.receiveShadow = true; kerbMesh.castShadow = true;
  addCells(scene, kerbMesh, 60);

  // ---------- painted white edge lines where there is no kerb ----------
  const lp = [], lidx = [];
  for (const side of [1, -1]) {
    const flags = side > 0 ? T.kl : T.kr;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (flags[i] && flags[j]) continue;
      const base = lp.length / 3;
      for (const k of [i, j]) {
        const w = side > 0 ? T.wl[k] : T.wr[k];
        for (const o of [w - 0.1, w]) {
          toV3(T.x[k] + T.nx[k] * side * o, T.y[k] + T.ny[k] * side * o, T.surfZ(k, side * o) + 0.008, P);
          lp.push(P.x, P.y, P.z);
        }
      }
      lidx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  }
  addCells(scene, new THREE.Mesh(ribbon(lp, lidx), new THREE.MeshStandardMaterial({
    color: 0xdedfd8, roughness: 0.6, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  })), 60);

  // ---------- start/finish line: a plain white painted line across the track ----------
  {
    const k = T.sfIndex, w = T.wl[k] + T.wr[k];
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.3), new THREE.MeshStandardMaterial({
      color: 0xdedfd8, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    const mid = (T.wl[k] - T.wr[k]) / 2;
    toV3(T.x[k] + T.nx[k] * mid, T.y[k] + T.ny[k] * mid, T.surfZ(k, mid) + 0.012, m.position);
    m.rotation.order = 'YXZ';
    m.rotation.y = Math.atan2(T.ty[k], T.tx[k]) - Math.PI / 2;
    m.rotation.x = -Math.PI / 2;
    m.receiveShadow = true;
    scene.add(m);
  }

  // ---------- barriers ----------
  // the blocks are laid out by the track (Track.buildBlocks) so the kart collides with exactly what
  // is drawn: TecPro blocks, and the concrete pit wall on the pit side of the straight
  const BLOCK = 1.5;
  const blocks = [], walls = [];
  for (const b of T.blocks) (b.pit ? walls : blocks).push({ x: b.x, y: b.y, z: T.height(b.x, b.y, b.i), yaw: b.yaw, len: b.len });
  const blockGeo = roundedBlock(BLOCK - 0.04, 0.78, 0.55, 0.12);
  const blockMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 });
  const Mx = new THREE.Matrix4(), Q = new THREE.Quaternion(), Cc = new THREE.Color();
  // one instanced mesh per 40 m cell, so blocks out of view / out of the shadow box are skipped
  const cells = new Map();
  blocks.forEach((b, k) => {
    const key = Math.floor(b.x / 40) * 1000 + Math.floor(b.y / 40);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push([b, k]);
  });
  for (const list of cells.values()) {
    const inst = new THREE.InstancedMesh(blockGeo, blockMat, list.length);
    list.forEach(([b, k], j) => {
      Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
      Mx.compose(new THREE.Vector3(b.x, b.z + 0.39, -b.y), Q, new THREE.Vector3(b.len / BLOCK, 1, 1));
      inst.setMatrixAt(j, Mx);
      inst.setColorAt(j, Cc.set(k % 2 ? 0xe9e9e6 : 0xc61f1f));
    });
    inst.computeBoundingSphere();
    inst.castShadow = inst.receiveShadow = true;
    scene.add(inst);
  }
  const wallGeo = new THREE.BoxGeometry(1, 1.0, 0.35);
  const cw = pbr('concrete_floor_02', { rough: false, repeat: 0.4 });
  const wallMat = new THREE.MeshStandardMaterial({ normalMap: cw.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), color: 0xdcdcd6, roughness: 0.8 });
  const wi = new THREE.InstancedMesh(wallGeo, wallMat, walls.length);
  walls.forEach((b, k) => {
    Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
    Mx.compose(new THREE.Vector3(b.x, b.z + 0.5, -b.y), Q, new THREE.Vector3(b.len + 0.02, 1, 1));
    wi.setMatrixAt(k, Mx);
  });
  wi.computeBoundingSphere();
  wi.castShadow = wi.receiveShadow = true;
  scene.add(wi);

  // ---------- buildings (OSM footprints): grey-blue metal cladding, plaster for the house ----------
  const clad = pbr('corrugated_iron', { repeat: 1 });
  const cladMat = new THREE.MeshStandardMaterial({ ...clad, color: 0x6f7d8f, metalness: 0.55, roughness: 0.55 });
  const plaster = pbr('clay_plaster');
  const plasterMat = new THREE.MeshStandardMaterial({ ...plaster, color: 0xe8d9bf });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8a4b38, roughness: 0.8 });
  const flatRoof = new THREE.MeshStandardMaterial({ color: 0x9ea3a8, roughness: 0.7, metalness: 0.3 });
  buildings.forEach((poly, bi) => {
    const shape = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)));
    const house = bi === 0;
    const hgt = house ? 6.5 : 8;
    const geo = new THREE.ExtrudeGeometry(shape, { depth: hgt, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    // world-space UVs on the walls so the cladding is not stretched
    const p = geo.attributes.position, nrm = geo.attributes.normal, uv = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const horiz = Math.abs(nrm.getY(i)) < 0.5;
      if (horiz) uv.setXY(i, (p.getX(i) * Math.abs(nrm.getZ(i)) + p.getZ(i) * Math.abs(nrm.getX(i))) / 2, p.getY(i) / 2);
    }
    const cx = poly.reduce((a, q) => a + q[0], 0) / poly.length, cy = poly.reduce((a, q) => a + q[1], 0) / poly.length;
    const m = new THREE.Mesh(geo, [house ? roofMat : flatRoof, house ? plasterMat : cladMat]);
    m.position.y = T.height(cx, cy) - 0.3;
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  });

  // ---------- lattice floodlight towers ----------
  // ~60 parts per tower merged into one steel mesh and one lamp mesh for all six towers
  // (as separate meshes they were ~340 draw calls per pass)
  const steel = new THREE.MeshStandardMaterial({ color: 0xa7adb3, roughness: 0.45, metalness: 0.8 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.5, metalness: 0.5 });
  const steelParts = [], lampParts = [];
  const part = (geo, obj, list) => { obj.updateWorldMatrix(true, false); list.push(geo.applyMatrix4(obj.matrixWorld)); };
  for (const [x, y] of [[-47, 47], [-9, 15], [-38, -8], [4, -55], [28, 82], [52, 10]]) {
    const z = T.height(x, y), H = 16, w = 0.6;
    const g = new THREE.Group(); g.position.set(x, z, -y);
    const o = new THREE.Object3D(); g.add(o);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      o.position.set(sx * w / 2, H / 2, sz * w / 2); o.rotation.set(0, 0, 0);
      part(new THREE.CylinderGeometry(0.04, 0.05, H, 6), o, steelParts);
    }
    for (let h = 0.5; h < H; h += 1.2) for (const r of [0, 1, 2, 3]) {
      o.position.set(0, h + 0.6, 0); o.rotation.set(0, 0, 0);
      o.rotation.y = (r * Math.PI) / 2;
      o.translateZ(w / 2);
      o.rotateZ(Math.atan2(w, 1.2) * (r % 2 ? 1 : -1));
      part(new THREE.CylinderGeometry(0.018, 0.018, Math.hypot(w, 1.2), 4), o, steelParts);
    }
    o.position.set(0, H + 0.4, 0); o.rotation.set(0, 0, 0);
    part(new THREE.BoxGeometry(2.4, 1.2, 0.3), o, lampParts);
  }
  for (const [parts, mat] of [[steelParts, steel], [lampParts, lamp]]) {
    const m = new THREE.Mesh(mergeGeometries(parts), mat);
    m.castShadow = true;
    scene.add(m);
  }

  await Promise.all(pending);
  return { dir, sunDir, sunElev, trackMesh };
}

function roundedBlock(L, H, D, r) {
  // TecPro-like barrier block: long along local X, rounded edges
  const shape = new THREE.Shape();
  const w = D / 2, h = H;
  shape.moveTo(-w + r, 0); shape.lineTo(w - r, 0); shape.quadraticCurveTo(w, 0, w, r);
  shape.lineTo(w, h - r); shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h); shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, r); shape.quadraticCurveTo(-w, 0, -w + r, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 3, curveSegments: 4 });
  g.translate(0, -H / 2, -L / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

// pedal -> colour: dark green flat out, lighter greens on part throttle, yellow off both pedals,
// orange to dark red as the brake goes from light to the hardest the lap uses
const PEDAL_COLORS = [
  [-1, [0.42, 0.0, 0.02]], [-0.6, [0.78, 0.05, 0.04]], [-0.25, [0.98, 0.3, 0.05]], [0, [0.98, 0.85, 0.15]],
  [0.35, [0.62, 0.9, 0.2]], [0.75, [0.15, 0.78, 0.25]], [1, [0.0, 0.42, 0.13]],
];
export function pedalColor(p) {
  const C = PEDAL_COLORS;
  if (p <= C[0][0]) return C[0][1];
  for (let k = 1; k < C.length; k++) {
    if (p <= C[k][0]) {
      const [a, ca] = C[k - 1], [b, cb] = C[k], t = (p - a) / (b - a);
      return [0, 1, 2].map((j) => ca[j] + (cb[j] - ca[j]) * t);
    }
  }
  return C[C.length - 1][1];
}

// optional coloured racing-line overlay (training aid): the path the autopilot drove on its
// fastest lap (track.driven), coloured by its pedals; without a recording, the optimised line
export function buildRaceLine(scene, track) {
  const T = track, n = T.n, pos = [], col = [], idx = [];
  const P = new THREE.Vector3(), D = T.driven;
  let brkMax = 0.05;
  if (D) for (let i = 0; i < n; i++) brkMax = Math.max(brkMax, D.brk[i]);
  // pedal per sample, -1 (hardest braking of the lap) .. 1 (flat out), smoothed over +/- 2 m so the
  // autopilot's traction-control flicker does not stripe the line
  const pedal = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (D) pedal[i] = D.brk[i] > 0.02 ? -Math.min(1, D.brk[i] / brkMax) : D.thr[i];
    else { const v = T.ideal, kn = (i + 3) % n, dv = v[kn] - v[i]; pedal[i] = T.drive ? T.drive[i] : Math.abs(dv) > 0.05 ? Math.sign(dv) : 0; }
  }
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    let p = 0;
    for (let q = -2; q <= 2; q++) p += pedal[(k + q + n) % n];
    const c = pedalColor(p / 5);
    const line = D ? D.d[k] : T.race[k];
    for (const o of [-0.15, 0.15]) {
      const off = line + o;
      const px = T.x[k] + T.nx[k] * off, py = T.y[k] + T.ny[k] * off;
      toV3(px, py, T.height(px, py, k) + 0.015, P); // real ground: the line rides over the kerbs
      pos.push(P.x, P.y, P.z); col.push(...c);
    }
  }
  for (let i = 0; i < n; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const m = new THREE.Mesh(ribbon(pos, idx, { color: [col, 3] }), new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.75, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5, depthWrite: false,
  }));
  m.visible = false;
  scene.add(m);
  return m;
}
