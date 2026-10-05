import * as THREE from 'three';
import { Track } from './track.js';
import { Kart, KARTS, kartById } from './kart.js';
import { trackFor } from './kartdata.js';
import { Autopilot } from './autopilot.js';
import { buildWorld, buildRaceLine } from './world.js';
import { KartModel } from './kartmodel.js';
import { Input, useKartLimits } from './input.js';
import { KartAudio } from './audio.js';
import { Timing, fmt, fmtD } from './timing.js';
import { retuneIdeal } from './lapmodel.js';
import { Vibe } from './vibe.js';

const $ = (id) => document.getElementById(id);
const DT = 1 / 1000; // physics step
// phones and tablets: tilt steering, on-screen pedals, fullscreen landscape
const TOUCH = matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
document.body.classList.toggle('touch', TOUCH);
// already running as an installed app (home-screen icon)?
const STANDALONE = navigator.standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
// Android/Chrome offer the install dialog through this event; iOS has no such API (steps on screen instead)
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
addEventListener('appinstalled', () => { installEvt = null; });
const icon = (id, rot = 0) => `<svg class="i"${rot ? ` style="transform:rotate(${rot}deg)"` : ''}><use href="#${id}"/></svg>`;
const ARROW = { up: icon('ic-r', -90), down: icon('ic-r', 90), left: icon('ic-l'), right: icon('ic-r') };

async function loadImageData(url) {
  const img = new Image();
  await new Promise((ok, err) => { img.onload = ok; img.onerror = err; img.src = url; });
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, data: g.getImageData(0, 0, img.width, img.height).data };
}

async function main() {
  const status = (s, p) => { $('loading-msg').textContent = s; if (p) $('loading-bar').style.transform = `scaleX(${p / 100})`; };
  status('Cargando trazado…', 12);
  const [T, terrain, buildings, surface] = await Promise.all([
    fetch('assets/track.json').then((r) => r.json()),
    fetch('assets/terrain.json').then((r) => r.json()),
    fetch('assets/buildings.json').then((r) => r.json()),
    loadImageData('assets/surface.png'),
  ]);
  status('Cargando ortofoto PNOA…', 40);
  const tl = new THREE.TextureLoader();
  const [ortho, far, horizon] = await Promise.all(['ortho.jpg', 'far.jpg', 'horizon.jpg'].map((f) => tl.loadAsync('assets/' + f)));

  const track = new Track(T, terrain, surface);
  const kart = new Kart(track);
  let auto = new Autopilot(track, 0.97);
  const input = new Input();
  const audio = new KartAudio();
  const timing = new Timing(track);

  // ---------- renderer ----------
  // MSAA only below retina density: at 2x the pixels are already tiny (and macOS downsamples the
  // canvas to the panel), while 4x MSAA on a 2940x1912 canvas costs ~15 fps on an M2
  const renderer = new THREE.WebGLRenderer({ antialias: devicePixelRatio < 2, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, TOUCH ? 1.5 : 2)); // phones: 1.5x keeps the frame rate
  // the canvas fills #app (fixed, whole screen) by CSS; fit() matches its pixel buffer to it
  const app = $('app');
  renderer.setSize(app.clientWidth || innerWidth, app.clientHeight || innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  $('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, (app.clientWidth || innerWidth) / (app.clientHeight || innerHeight), 0.04, 80000);
  status('Construyendo circuito…', 72);
  const world = await buildWorld(scene, track, terrain, { ortho, far, horizon }, buildings, renderer);
  let raceLine = buildRaceLine(scene, track);
  status('Listo', 100);

  // the player's kart and the ghost; rebuilt when another kart is chosen
  let model, ghost;
  const buildModels = (type) => {
    for (const m of [model, ghost]) if (m) {
      scene.remove(m.root);
      m.root.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach((x) => { x.map?.dispose(); x.dispose(); }); } });
    }
    model = new KartModel({ type });
    ghost = new KartModel({ type, ghost: true });
    scene.add(model.root, ghost.root);
    ghost.root.visible = false;
  };
  buildModels('rt10');

  // Phones report the new size late (rotation, browser/system bars hiding, fullscreen), and a
  // stale size left a black band under the canvas: measure the real box on every hint and
  // also twice a second.
  const sz = new THREE.Vector2();
  const fit = () => {
    const w = app.clientWidth, h = app.clientHeight;
    if (!w || !h) return;
    renderer.getSize(sz);
    if (sz.x === w && sz.y === h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const fitSoon = () => { fit(); requestAnimationFrame(fit); setTimeout(fit, 300); };
  addEventListener('resize', fitSoon);
  addEventListener('orientationchange', fitSoon);
  document.addEventListener('fullscreenchange', fitSoon);
  window.visualViewport?.addEventListener('resize', fitSoon);
  setInterval(fit, 500);

  // ---------- state & settings ----------
  const DEFAULTS = { cam: 0, showGhost: true, line: false, sound: true, vol: 80, hud: TOUCH ? 'basic' : 'full', input: TOUCH ? 'tilt' : 'key', tiltSens: 100, fov: 72, kg: 75, kart: 'rt10' };
  const S = { running: false, paused: false, autopilot: false, t: 0, acc: 0, lights: null, ...DEFAULTS };
  try { Object.assign(S, JSON.parse(localStorage.getItem('pedrezuela.settings.v2') || '{}'), { running: false, paused: false, autopilot: false, lights: null }); } catch {}
  const saveSettings = () => { try { localStorage.setItem('pedrezuela.settings.v2', JSON.stringify(Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, S[k]])))); } catch {} };
  if (!KARTS[S.kart]) S.kart = DEFAULTS.kart;
  // kart and driver weight: kart mass/CG/inertia + ideal lap recomputed (~0.5 s), best laps kept per
  // kart and weight (the RT10 at 75 kg keeps the original keys)
  const suffix = () => (S.kart === 'rt10' ? '' : `.${S.kart}`) + (S.kg === 75 ? '' : `.${S.kg}kg`);
  let massTimer = 0;
  const applyMass = () => {
    clearTimeout(massTimer); massTimer = 0;
    const newKart = kart.P.id !== S.kart;
    if (!newKart && kart.P.driverMass === S.kg) return;
    if (newKart) {
      // the kart's own racing line, speeds, autopilot habits and recorded lap (track.json karts)
      track.setKartData(trackFor(T, S.kart));
      kart.setProfile(kartById(S.kart), S.kg);
      kart.reset(track.sfIndex - 35);
      useKartLimits(S.kart);
      buildModels(S.kart);
      document.querySelector('.lv-num').textContent = kart.P.info.number;
      scene.remove(raceLine); raceLine.geometry.dispose(); raceLine.material.dispose();
      raceLine = buildRaceLine(scene, track); raceLine.visible = S.line;
      // what was learned holds for a 75 kg driver; another weight (or no learned lap yet) needs the lap model
      if (S.kg !== 75 || !track.envelope) retuneIdeal(track, kart.P);
    } else {
      kart.setDriverMass(S.kg);
      retuneIdeal(track, kart.P);
    }
    auto = new Autopilot(track, 0.97);
    timing.setKey('pedrezuela.best.v2' + suffix());
    teleBest = null;
    if (UI.open) refreshMenu();
  };
  const applySettings = () => {
    camera.fov = S.fov; camera.updateProjectionMatrix();
    raceLine.visible = S.line;
    input.mouse.on = S.input === 'mouse';
    input.tilt.on = S.input === 'tilt';
    input.tilt.sens = S.tiltSens / 100;
    const on = S.sound && S.vol > 0;
    if (audio.ready) audio.master.gain.value = on ? 0.55 * (S.vol / 100) : 0;
    audio.muted = !on;
    for (const k of ['full', 'basic', 'min']) document.body.classList.toggle('hud-' + k, S.hud === k);
    chase.init = false;
  };

  // ---------- track geometry for maps ----------
  const L = track.length, s0 = track.s[track.sfIndex];
  const order = Array.from({ length: track.n + 1 }, (_, j) => (track.sfIndex + j) % track.n); // driving order from the line
  const secAt = (i) => Math.min(2, Math.floor(((((track.s[i] - s0) % L) + L) % L) / (L / 3)));
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (let i = 0; i < track.n; i++) { bx0 = Math.min(bx0, track.x[i]); bx1 = Math.max(bx1, track.x[i]); by0 = Math.min(by0, track.y[i]); by1 = Math.max(by1, track.y[i]); }
  // Draws the circuit sector by sector; returns the world→canvas projection.
  function drawTrack(g, W, H, o) {
    const sc = Math.min((W - 2 * o.pad) / (bx1 - bx0), (H - 2 * o.pad) / (by1 - by0));
    const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
    const P = (x, y) => [W / 2 + (x - cx) * sc, H / 2 - (y - cy) * sc];
    g.clearRect(0, 0, W, H);
    g.lineJoin = 'round'; g.lineCap = 'round';
    const path = (from, to) => { g.beginPath(); for (let j = from; j <= to; j++) { const [px, py] = P(track.x[order[j]], track.y[order[j]]); j === from ? g.moveTo(px, py) : g.lineTo(px, py); } };
    path(0, track.n);
    g.strokeStyle = o.casing; g.lineWidth = o.w + o.cw; g.stroke();
    let j0 = 0;
    const bounds = [];
    for (let k = 0; k < 3; k++) {
      let j1 = j0;
      while (j1 < track.n && secAt(order[j1]) === k) j1++;
      path(j0, Math.min(track.n, j1));
      g.strokeStyle = o.color(k); g.lineWidth = o.w; g.stroke();
      bounds.push([j0, Math.min(track.n, j1)]);
      j0 = j1;
    }
    // sector boundaries (S2, S3) as ticks across the track, and each sector's number beside it
    if (o.labels) {
      const across = (i, half, col, lw) => {
        const [a, b] = P(track.x[i] + track.nx[i] * half, track.y[i] + track.ny[i] * half), [c, d] = P(track.x[i] - track.nx[i] * half, track.y[i] - track.ny[i] * half);
        g.lineCap = 'butt'; g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke();
      };
      for (let k = 1; k < 3; k++) across(order[bounds[k][0]], o.w * 1.3 / sc, o.casing, Math.max(3, o.w * 0.45));
      g.font = `700 ${o.labels}px F1, Saira, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      bounds.forEach(([a, b], k) => {
        const i = order[(a + b) >> 1], off = (o.w + o.labels * 1.6) / sc;
        // put the label on the side of the track facing away from the circuit's centre
        const cxw = (bx0 + bx1) / 2, cyw = (by0 + by1) / 2;
        const sgn = (track.x[i] - cxw) * track.nx[i] + (track.y[i] - cyw) * track.ny[i] >= 0 ? 1 : -1;
        const [lx, ly] = P(track.x[i] + track.nx[i] * off * sgn, track.y[i] + track.ny[i] * off * sgn);
        const bw = o.labels * 2.1, bh = o.labels * 1.35;
        g.fillStyle = '#ffffff'; g.fillRect(lx - bw / 2, ly - bh / 2, bw, bh);
        g.fillStyle = '#15151e'; g.fillText('S' + (k + 1), lx, ly + 1);
      });
    }
    const k = track.sfIndex, h = o.w * 1.6 / sc;
    const [a, b] = P(track.x[k] + track.nx[k] * h, track.y[k] + track.ny[k] * h), [c, d] = P(track.x[k] - track.nx[k] * h, track.y[k] - track.ny[k] * h);
    g.lineCap = 'butt';
    g.strokeStyle = '#ffffff'; g.lineWidth = Math.max(4, o.w * 0.8);
    g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke();
    g.strokeStyle = '#e10600'; g.lineWidth = Math.max(2, o.w * 0.4); g.stroke();
    return P;
  }

  // ---------- menus (F1 game shell) ----------
  const UI = { open: false, stack: [], sel: 0, armed: false, cleared: false };
  const OPTS = {
    input: { label: 'Control', vals: [...(TOUCH ? [['tilt', 'Inclinación']] : []), ['key', 'Teclado'], ['mouse', 'Ratón'], ['pad', 'Mando · volante']], get: () => S.input, set: (v) => { S.input = v; },
      desc: (TOUCH ? 'Inclinación: gira el móvil como un volante, pedal derecho gas e izquierdo freno. ' : '') + 'Teclado: el giro crece mientras mantienes la tecla. Ratón: la posición horizontal es el volante, clic izquierdo gas y derecho freno. Mandos y volantes USB se detectan solos.' },
    cam: { label: 'Cámara', vals: [[0, 'Cabina'], [1, 'Exterior'], [2, 'Morro']], get: () => S.cam, set: (v) => { S.cam = v; },
      desc: 'Cabina: vista del piloto, la cabeza acompaña las fuerzas G. Exterior: cámara de persecución. Morro: a ras de suelo, delante del volante.' },
    hud: { label: 'Telemetría', vals: TOUCH ? [['basic', 'Velocidad'], ['min', 'Solo tiempos']] : [['full', 'Completa'], ['basic', 'Básica'], ['min', 'Solo tiempos']],
      get: () => S.hud, set: (v) => { S.hud = v; },
      desc: (TOUCH ? 'Velocidad: el velocímetro arriba a la derecha. ' : 'Completa: trazas contra tu mejor vuelta, fuerzas G y neumáticos. Básica: velocidad, revoluciones y luces de cambio. ')
        + 'Solo tiempos: únicamente la barra de vuelta, sectores y delta, siempre visible.' },
    line: { label: 'Trazada ideal', vals: [[false, 'No'], [true, 'Sí']], get: () => S.line, set: (v) => { S.line = v; },
      desc: 'Pinta en el asfalto la trazada del piloto automático y qué hace con los pedales: verde gas (más oscuro, más gas), amarillo sin pedales, naranja y rojo freno (más oscuro, más fuerte). En pista: tecla L.' },
    ghost: { label: 'Fantasma', vals: [[false, 'No'], [true, 'Sí']], get: () => S.showGhost, set: (v) => { S.showGhost = v; },
      desc: 'Un kart transparente repite tu mejor vuelta guardada a la vez que tú. En pista: tecla G.' },
    kart: { label: 'Kart', vals: Object.values(KARTS).map((K) => [K.id, K.info.short]), get: () => S.kart, locked: () => S.running,
      set: (v) => { S.kart = v; clearTimeout(massTimer); massTimer = setTimeout(applyMass, 450); },
      desc: () => S.running ? 'Solo se cambia desde el menú principal: carga su trazada y coloca el kart en parrilla.'
        : ((K) => `${K.info.name}: ${K.info.engine}, ${K.info.hp} cv, ${K.kartMass} kg en vacío. ${K.info.desc} Cada kart guarda sus propios tiempos.`)(kartById(S.kart)) },
    sound: { label: 'Sonido', vals: [[false, 'No'], [true, 'Sí']], get: () => S.sound, set: (v) => { S.sound = v; },
      desc: 'Motor, neumáticos, pianos y viento, generados en tiempo real. En pista: tecla M.' },
  };
  // shown when a setting is changed from the track with its key: same name and value as in the menu
  const optValue = (key) => OPTS[key].vals[optIndex(OPTS[key])][1];
  const toggled = (key) => { applySettings(); saveSettings(); flash(OPTS[key].label, optValue(key)); };
  const act = (label, desc, run) => ({ type: 'act', label, desc, run });
  const head = (label) => ({ type: 'head', label });
  const SETTINGS_DESC = 'Control, cámara, telemetría en pantalla, ayudas, sonido, kart y peso del piloto.';
  const CONTROLS_DESC = TOUCH ? 'Inclinación, pedales en pantalla y botones.' : 'Teclado, ratón, mando y volante.';
  const GUIDE_DESC = 'Qué significan los colores de los sectores, el delta y la vuelta anulada.';
  const MENUS = {
    main: () => ({ title: 'Contrarreloj', info: 'track', items: [
      act('Conducir', 'Sesión cronometrada: vuelta de salida, semáforo y vueltas con tres sectores. Tu mejor vuelta se guarda en este navegador.', () => start(false)),
      act('Vuelta ideal', `Demostración: el piloto automático rueda la trazada de mínimo tiempo (${fmt(track.idealLap)}). Pulsa O en pista para tomar el control.`, () => start(true)),
      act('Ajustes', SETTINGS_DESC, () => push('settings')),
      act('Controles', CONTROLS_DESC, () => push('controls')),
      act('Tiempos y colores', GUIDE_DESC, () => push('guide')),
      ...(TOUCH && !STANDALONE ? [act('Instalar como app', 'Icono en la pantalla de inicio: se abre a pantalla completa y en horizontal, sin barras del navegador.', () => installApp())] : []),
    ] }),
    pause: () => ({ title: 'Pausa', info: 'session', items: [
      act('Continuar', 'Vuelve a pista donde lo dejaste.', () => resume()),
      act('Reiniciar sesión', 'Vuelve a parrilla y borra los tiempos de esta sesión. La mejor vuelta y los récords guardados se mantienen.', () => restart()),
      act('Ajustes', SETTINGS_DESC, () => push('settings')),
      act('Controles', CONTROLS_DESC, () => push('controls')),
      act('Tiempos y colores', GUIDE_DESC, () => push('guide')),
      act('Salir al menú principal', 'Termina la sesión y vuelve al menú. En pista también con Q (Back en el mando). La mejor vuelta guardada se mantiene.', () => quit()),
    ] }),
    settings: () => ({ title: 'Ajustes', info: 'setting', items: [
      head('Control'),
      { type: 'opt', key: 'input' },
      ...(TOUCH ? [{ type: 'range', label: 'Sensibilidad', min: 40, max: 250, step: 10, get: () => S.tiltSens, unit: ' %', set: (v) => { S.tiltSens = v; },
        desc: () => `Cuánto hay que girar el móvil: con ${S.tiltSens} % el volante llega al tope a ${Math.round(28 / (S.tiltSens / 100))}°. Más sensibilidad, menos giro de muñeca.` }] : []),
      head('Pantalla'),
      { type: 'opt', key: 'cam' },
      { type: 'range', label: 'Campo de visión', min: 50, max: 100, step: 2, get: () => S.fov, set: (v) => { S.fov = v; }, unit: '°', desc: 'Ángulo de visión vertical. En las cámaras a bordo se abre unos grados con la velocidad.' },
      { type: 'opt', key: 'hud' },
      head('Ayudas'),
      { type: 'opt', key: 'line' }, { type: 'opt', key: 'ghost' },
      head('Sonido'),
      { type: 'opt', key: 'sound' },
      { type: 'range', label: 'Volumen', min: 0, max: 100, step: 10, get: () => S.vol, unit: ' %', set: (v) => { S.vol = v; }, locked: () => !S.sound,
        desc: () => S.sound ? 'Volumen general del motor y los efectos.' : 'El sonido está desactivado.' },
      head('Kart'),
      { type: 'opt', key: 'kart' },
      { type: 'range', label: 'Peso del piloto', min: 45, max: 120, step: 5, get: () => S.kg, unit: ' kg', locked: () => S.running,
        set: (v) => { S.kg = v; clearTimeout(massTimer); massTimer = setTimeout(applyMass, 450); },
        desc: () => S.running ? 'Solo se cambia desde el menú principal: recalcula la vuelta ideal y coloca el kart en parrilla.'
          : `Masa, centro de gravedad e inercias del kart con piloto. Con ${S.kg} kg en el ${kart.P.info.name}: vuelta ideal ${fmt(track.idealLap)}, agarre lateral ${track.envelope ? track.envelope.lateral_g.toFixed(2) : '—'} g. Cada kart y peso guarda sus propios tiempos.` },
      head('Datos'),
      { type: 'danger', id: 'times', label: 'Borrar tiempos', done: 'Tiempos borrados', desc: () => `Elimina la mejor vuelta, su fantasma y los récords de sector guardados con el ${kart.P.info.name} y ${S.kg} kg. No se puede deshacer.`, run: () => clearTimes() },
      { type: 'danger', id: 'reset', label: 'Restablecer ajustes', done: 'Ajustes restablecidos', desc: 'Devuelve todos los ajustes a sus valores de fábrica. Tus tiempos no se tocan.', run: () => resetSettings() },
    ] }),
    controls: () => ({ title: 'Controles', info: 'controls', items: [act('Volver', 'Vuelve al menú anterior.', () => back())] }),
    guide: () => ({ title: 'Tiempos y colores', info: 'guide', items: [act('Volver', 'Todo se compara con tu mejor vuelta guardada para este peso de piloto. La primera vuelta válida marca los primeros récords.', () => back())] }),
    install: () => ({ title: 'Instalar', info: 'install', items: [
      act('Copiar enlace', 'Los pasos para tu móvil están más abajo. Este botón copia la dirección del juego para pegarla en Safari o Chrome.', () => {
        navigator.clipboard?.writeText(location.href.split('#')[0]).then(() => { $('menu-desc').textContent = 'Enlace copiado. Pégalo en la barra de direcciones de Safari o Chrome.'; }, () => {});
      }),
      act('Volver', 'Vuelve al menú anterior.', () => back()),
    ] }),
  };
  const ROOT = { main: 'Menú principal', pause: 'Sesión' };
  function clearTimes() {
    timing.clearSaved(); teleBest = null; secState.fill(null);
    try { localStorage.removeItem(teleKey()); } catch {}
  }
  function resetSettings() {
    const kg = S.kg, kartId = S.kart;
    Object.assign(S, DEFAULTS);
    // the kart and the driver weight change the physics and the saved times: only from the main menu
    if (S.running) { S.kg = kg; S.kart = kartId; } else if (kg !== S.kg || kartId !== S.kart) applyMass();
    applySettings(); saveSettings();
    if (S.input === 'tilt') input.enableTilt();
  }
  function installApp() {
    if (installEvt) { installEvt.prompt(); installEvt.userChoice.finally(() => { installEvt = null; }); return; }
    push('install');
  }
  // where "add to home screen" lives for this phone and browser
  function installSteps() {
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const inApp = /FBAN|FBAV|Instagram|Line\/|WhatsApp|LinkedInApp|Snapchat|TikTok|; wv\)/.test(ua);
    const openFirst = 'Si llegaste por un enlace de WhatsApp, Gmail, Instagram u otra app, se ha abierto en su navegador interno, que no puede instalar: ';
    if (ios && /CriOS|FxiOS|EdgiOS/.test(ua)) return { h: 'iPhone · Chrome', p: 'Funciona desde iOS 16.4.', s: ['Toca el botón Compartir (cuadrado con flecha) junto a la barra de direcciones.', 'Elige «Añadir a pantalla de inicio».', 'Pulsa «Añadir» y abre el juego desde el icono.'] };
    if (ios) return { h: 'iPhone · Safari', p: openFirst + 'toca «Abrir en Safari» (o el icono de la brújula) o copia el enlace y pégalo en Safari.',
      s: ['Toca el botón Compartir (cuadrado con flecha). En iOS 26 está dentro del botón «···» de la barra de abajo.', 'Desliza la lista hacia abajo y toca «Añadir a pantalla de inicio». Si no aparece, «Editar acciones» al final de la lista.', 'Deja activado «Abrir como app web», pulsa «Añadir» y abre el juego desde el icono.'] };
    if (inApp) return { h: 'Navegador de otra app', p: 'Esta página se ha abierto dentro de otra app, que no puede instalarla.', s: ['Toca el menú ⋮ y elige «Abrir en Chrome» (o copia el enlace y pégalo en Chrome).', 'En Chrome: menú ⋮ → «Añadir a pantalla de inicio» → «Instalar».'] };
    if (/SamsungBrowser/.test(ua)) return { h: 'Samsung Internet', p: '', s: ['Toca el menú ☰ abajo a la derecha.', '«Añadir página a» → «Pantalla de inicio».'] };
    if (/Firefox/.test(ua)) return { h: 'Android · Firefox', p: '', s: ['Toca el menú ⋮.', '«Instalar» o «Añadir a pantalla de inicio».'] };
    return { h: 'Android · Chrome', p: 'Si Chrome ya ofrece instalarla, sale un aviso abajo; si no:', s: ['Toca el menú ⋮ arriba a la derecha.', '«Añadir a pantalla de inicio» → «Instalar» (no «Crear acceso directo»).', 'Abre el juego desde el icono nuevo.'] };
  }
  let M = null; // current menu instance

  const itemLabel = (it, sel) => it.type === 'opt' ? OPTS[it.key].label
    : it.type === 'danger' && sel ? (UI.cleared ? it.done : UI.armed ? 'Pulsa otra vez para confirmar' : it.label) : it.label;
  const itemDesc = (it) => { const d = it.type === 'opt' ? OPTS[it.key].desc : it.desc; return typeof d === 'function' ? d() : d; };
  const optIndex = (o) => Math.max(0, o.vals.findIndex(([v]) => v === o.get()));
  const itemValue = (it) => it.type === 'opt' ? OPTS[it.key].vals[optIndex(OPTS[it.key])][1] : it.type === 'range' ? it.get() + it.unit : '';

  function renderMenu() {
    M = MENUS[UI.stack.at(-1)]();
    const trail = [ROOT[UI.stack[0]], ...UI.stack.slice(1, -1).map((k) => MENUS[k]().title)];
    $('crumbs').innerHTML = trail.map((c) => `<span>${c}</span>`).join('');
    $('menu-title').textContent = M.title;
    $('menu-list').innerHTML = M.items.map((it, n) => {
      if (it.type === 'head') return `<li class="mh" role="presentation" style="--n:${n}">${it.label}</li>`;
      const cls = 'mi' + (it.type === 'opt' || it.type === 'range' ? ' mi-opt' : '') + (it.type === 'danger' ? ' danger' : '');
      let val = '';
      if (it.type === 'opt' || it.type === 'range') {
        const bar = it.type === 'opt' ? `<span class="pips">${OPTS[it.key].vals.map(() => '<i></i>').join('')}</span>` : '<span class="rng"><i></i></span>';
        val = `<span class="mi-val"><button class="arr" data-d="-1" tabindex="-1" aria-label="Anterior">${icon('ic-l')}</button><b class="num">${bar}</b><button class="arr" data-d="1" tabindex="-1" aria-label="Siguiente">${icon('ic-r')}</button></span>`;
      }
      return `<li class="${cls}" role="menuitem" data-n="${n}" style="--n:${n}"><span class="mi-label"></span>${val}</li>`;
    }).join('');
    $('pr-lr').classList.toggle('hidden', !M.items.some((it) => it.type === 'opt' || it.type === 'range'));
    $('pr-back').classList.toggle('hidden', UI.stack.length === 1 && UI.stack[0] === 'main');
    $('pr-back').lastChild.textContent = UI.stack.length === 1 ? 'Continuar' : 'Atrás';
    $('info').innerHTML = INFO[M.info]();
    $('info').scrollTop = 0;
    // the settings card already shows the selected item's description
    document.body.classList.toggle('no-desc', M.info === 'setting');
    if (M.info === 'track') {
      const c = $('trackmap');
      drawTrack(c.getContext('2d'), c.width, c.height, { pad: 56, w: 12, cw: 14, casing: '#0b0b10', color: (k) => (k === 1 ? '#8c8c94' : '#ffffff'), labels: 30 });
    }
    if (!isItem(M.items[UI.sel])) UI.sel = nextItem(UI.sel, 1);
    refreshMenu();
  }

  function refreshMenu() {
    [...$('menu-list').children].forEach((li, n) => {
      const it = M.items[n];
      if (!isItem(it)) return;
      li.classList.toggle('sel', n === UI.sel);
      li.classList.toggle('armed', it.type === 'danger' && n === UI.sel && (UI.armed || UI.cleared));
      li.querySelector('.mi-label').textContent = itemLabel(it, n === UI.sel);
      const b = li.querySelector('.mi-val b');
      if (b) b.firstChild.nodeType === 3 ? (b.firstChild.nodeValue = itemValue(it)) : b.prepend(itemValue(it));
      if (it.type === 'opt') { const k = optIndex(OPTS[it.key]); li.querySelectorAll('.pips i').forEach((p, j) => p.classList.toggle('on', j === k)); li.classList.toggle('locked', !!OPTS[it.key].locked?.()); }
      if (it.type === 'range') { li.querySelector('.rng i').style.width = ((it.get() - it.min) / (it.max - it.min)) * 100 + '%'; li.classList.toggle('locked', !!it.locked?.()); }
    });
    const it = M.items[UI.sel];
    $('menu-desc').textContent = itemDesc(it);
    if (M.info === 'setting') {
      const times = it.id === 'times';
      $('set-group').textContent = groupOf(UI.sel);
      $('set-name').textContent = times ? `Mejor vuelta · ${kart.P.info.name} · ${S.kg} kg` : it.id === 'reset' ? 'Ajustes' : itemLabel(it);
      $('set-val').textContent = times ? (timing.best ? fmt(timing.best.time) : 'Sin tiempos') : it.id === 'reset' ? (UI.cleared ? 'De fábrica' : 'Personalizados') : itemValue(it);
      $('set-desc').textContent = itemDesc(it);
    }
  }

  const isItem = (it) => it && it.type !== 'head';
  // next selectable row from n in direction d (section headers are skipped)
  const nextItem = (n, d) => { for (let i = 0; i < M.items.length; i++) { n = (n + d + M.items.length) % M.items.length; if (isItem(M.items[n])) return n; } return 0; };
  const groupOf = (n) => { for (let i = n; i >= 0; i--) if (M.items[i].type === 'head') return M.items[i].label; return 'Ajustes'; };
  const COLOR_GUIDE = () => {
    const sec = (cls, t) => `<div class="sw ${cls}"><span>S1</span><b class="num">${t}</b></div>`;
    return `
      <div class="gsec"><h3>Sectores</h3><div class="glist">
        ${sec('purple', '15.21')}<div>Récord del sector: el tiempo más rápido que has hecho nunca en ese tramo.</div>
        ${sec('green', '15.38')}<div>Más rápido que ese mismo sector en tu mejor vuelta.</div>
        ${sec('yellow', '15.66')}<div>Más lento que ese mismo sector en tu mejor vuelta.</div>
        ${sec('invalid', '15.40')}<div>Vuelta anulada: el tiempo no cuenta.</div>
      </div></div>
      <div class="gsec"><h3>Delta</h3><div class="glist">
        <div class="sw dg"><b class="num">−0.214</b></div><div>Vas más rápido que tu mejor vuelta en este mismo punto de la pista.</div>
        <div class="sw dr"><b class="num">+0.183</b></div><div>Vas más lento. La barra fina bajo los sectores muestra lo mismo.</div>
      </div></div>
      <div class="gsec"><h3>Vuelta</h3><div class="glist">
        <div class="sw ok"><i></i><span>Válida</span></div><div>Cuenta para la mejor vuelta y los récords.</div>
        <div class="sw red"><span>Anulada</span></div><div>Las cuatro ruedas fuera de los límites (los pianos son pista) o el kart recolocado.</div>
      </div></div>
      <div class="gsec"><h3>Trazada ideal</h3><div class="lineramp"></div>
        <div class="rampl cap"><span>Gas a fondo</span><span>Sin pedales</span><span>Freno a fondo</span></div></div>`;
  };
  const recCell = (k) => { const r = timing.rec[k]; return Number.isFinite(r) ? `<b class="num rec">${r.toFixed(3)}</b>` : '<b class="num">—</b>'; };
  const INFO = {
    track: () => `<div class="card">
      <div class="ch"><b>Circuito</b><span>Trazado normal</span></div>
      <div class="body">
        <h2>Karting Ángel Burgueño</h2><p>Pedrezuela, Madrid</p>
        <canvas id="trackmap" width="1040" height="560"></canvas>
      </div>
      <div class="stats">
        <div><span class="cap">Longitud</span><b class="num">${Math.round(L)}<small>m</small></b></div>
        <div><span class="cap">Vuelta ideal</span><b class="num">${track.idealLap ? fmt(track.idealLap) : '—'}</b></div>
        <div><span class="cap">Vuelta real pro</span><b class="num">${kart.P.proLap ? fmt(kart.P.proLap) : '—'}</b></div>
        <div><span class="cap">Tu mejor</span><b class="num">${timing.best ? fmt(timing.best.time) : '—'}</b></div>
      </div>
      <div class="secrow">${[0, 1, 2].map((k) => `<div><span class="cap">Récord S${k + 1}</span>${recCell(k)}</div>`).join('')}</div>
      <div class="kartline"><span class="n">${kart.P.info.number}</span><b>${kart.P.info.name}</b><span>${kart.P.info.engine} · ${kart.P.info.hp} cv · ${kart.P.kartMass} kg · piloto ${S.kg} kg</span></div>
    </div>`,
    session: () => {
      const done = Math.max(0, timing.lap - 1);
      const sum = timing.recordSum();
      return `<div class="card">
      <div class="ch"><b>${S.autopilot ? 'Demo' : 'Sesión'}</b><span>${S.autopilot ? 'Piloto automático' : 'Contrarreloj'}</span></div>
      <div class="body"><h2>${timing.lap ? 'Vuelta ' + timing.lap : 'Vuelta de salida'}</h2><p>${done === 1 ? '1 vuelta completada' : done + ' vueltas completadas'} en esta sesión</p></div>
      <div class="stats">
        <div><span class="cap">Última</span><b class="num">${timing.last ? (timing.last.invalid ? `<s>${fmt(timing.last.time)}</s>` : fmt(timing.last.time)) : '-:--.---'}</b></div>
        <div><span class="cap">Mejor sesión</span><b class="num">${fmt(timing.sessionBest?.time)}</b></div>
        <div><span class="cap">Tu mejor</span><b class="num">${fmt(timing.best?.time)}</b></div>
        <div><span class="cap">Vuelta ideal</span><b class="num">${fmt(track.idealLap)}</b></div>
      </div>
      <div class="secrow">${[0, 1, 2].map((k) => `<div><span class="cap">Récord S${k + 1}</span>${recCell(k)}</div>`).join('')}</div>
      <div class="kartline"><span class="n">Σ</span><b>Suma de récords</b><span class="num">${sum ? fmt(sum) + (timing.best ? ' · ' + fmtD(sum - timing.best.time) + ' a tu mejor' : '') : 'Completa una vuelta válida'}</span></div>
    </div>`;
    },
    guide: () => `<div class="card">
      <div class="ch"><b>Guía</b><span>Una sola referencia: tu mejor vuelta</span></div>
      <div class="body">${COLOR_GUIDE()}</div>
    </div>`,
    setting: () => `<div class="card">
      <div class="ch"><b id="set-group">Ajustes</b><span>Se guardan en este navegador</span></div>
      <div class="body"><h2 id="set-name"></h2><div class="setval num" id="set-val"></div><p class="setdesc" id="set-desc"></p></div>
    </div>`,
    install: () => {
      const st = installSteps();
      return `<div class="card">
      <div class="ch"><b>Instalar</b><span>Como una app</span></div>
      <div class="body"><h2>${st.h}</h2>${st.p ? `<p>${st.p}</p>` : ''}
      <ol class="steps">${st.s.map((x) => `<li>${x}</li>`).join('')}</ol></div>
    </div>`;
    },
    controls: () => {
      const K = (...k) => k.map((x) => `<kbd>${ARROW[x] || x}</kbd>`).join('');
      const P = (...k) => k.map((x) => `<span class="key pad">${x}</span>`).join('');
      if (TOUCH) {
        const T = (x) => `<span class="key pad">${x}</span>`;
        const trows = [['Girar', 'Inclina el móvil como un volante'], ['Acelerar', 'Mantén la mitad derecha'], ['Frenar', 'Mantén la mitad izquierda'],
          ['Pausa', 'Botón arriba a la izquierda'], ['Recolocar en pista', 'Botón junto a la pausa'], ['Pausa automática', 'Al poner el móvil en vertical o salir de la app']];
        return `<div class="card">
      <div class="ch"><b>Controles</b><span>Móvil en horizontal</span></div>
      <div class="body"><h2>Móvil</h2><p>La sensibilidad de la inclinación se cambia en Ajustes. Con mando Bluetooth conectado, se usa el mando.</p>
      <div class="ctable" style="grid-template-columns:auto 1fr"><span class="h cap">Acción</span><span class="h cap">Cómo</span>
      ${trows.map(([a, h]) => `<span>${a}</span><div style="justify-content:flex-start">${T(h)}</div>`).join('')}</div></div>
    </div>`;
      }
      const rows = [
        ['Acelerar', K('W', 'up'), P('RT')], ['Frenar', K('S', 'down', 'Espacio'), P('LT')], ['Girar', K('A', 'D', 'left', 'right'), P('Stick izq.')],
        ['Dirección con ratón', K('N'), ''], ['Cámara', K('C'), P('Y')], ['Recolocar en pista', K('R'), P('A')],
        ['Telemetría', K('H'), ''], ['Trazada ideal', K('L'), ''], ['Fantasma', K('G'), ''], ['Sonido', K('M'), ''], ['Piloto automático', K('O'), ''], ['Pausa', K('Esc', 'P'), P('Start')], ['Terminar y volver al menú', K('Q'), P('Back')],
      ];
      return `<div class="card">
      <div class="ch"><b>Controles</b><span>Mandos y volantes USB se detectan solos</span></div>
      <div class="body"><h2>Teclado y mando</h2><p>Con ratón: el centro de la pantalla es recto, clic izquierdo gas, clic derecho freno.</p>
      <div class="ctable"><span class="h cap">Acción</span><span class="h cap">Teclado</span><span class="h cap">Mando</span>
      ${rows.map(([a, k, p]) => `<span>${a}</span><div>${k}</div><div>${p || '<span class="cap">—</span>'}</div>`).join('')}</div></div>
    </div>`;
    },
  };

  function openMenu(root) {
    UI.open = true; UI.stack = [root]; UI.sel = 0; UI.armed = UI.cleared = false;
    $('menu-list').scrollTop = 0;
    $('shell').classList.remove('hidden');
    $('shell').classList.toggle('paused', root === 'pause');
    document.body.classList.toggle('paused', root === 'pause');
    renderMenu();
  }
  function closeMenu() { UI.open = false; $('shell').classList.add('hidden'); document.body.classList.remove('paused'); }
  function push(id) { UI.stack.push(id); UI.sel = 0; UI.armed = UI.cleared = false; renderMenu(); }
  function back() {
    if (UI.stack.at(-1) === 'settings' && massTimer) applyMass();
    if (UI.stack.length > 1) {
      const from = MENUS[UI.stack.pop()]().title;
      UI.sel = Math.max(0, MENUS[UI.stack.at(-1)]().items.findIndex((it) => it.label === from));
      UI.armed = UI.cleared = false;
      renderMenu();
    } else if (UI.stack[0] === 'pause') resume();
  }
  function move(d) {
    UI.sel = nextItem(UI.sel, d); UI.armed = UI.cleared = false; refreshMenu();
    $('menu-list').children[UI.sel]?.scrollIntoView({ block: 'nearest' });
  }
  function change(d, n = UI.sel) {
    const it = M.items[n];
    if (it.type === 'opt') { const o = OPTS[it.key]; if (o.locked?.()) return; o.set(o.vals[(optIndex(o) + d + o.vals.length) % o.vals.length][0]); }
    else if (it.type === 'range') { if (it.locked?.()) return; it.set(Math.max(it.min, Math.min(it.max, it.get() + d * it.step))); }
    else return;
    applySettings(); saveSettings(); refreshMenu();
    if (it.key === 'input' && S.input === 'tilt') input.enableTilt();
  }
  function activate(n = UI.sel) {
    const it = M.items[n];
    if (it.type === 'act') it.run();
    else if (it.type === 'opt') change(1, n);
    else if (it.type === 'danger') {
      if (UI.cleared) return;
      if (!UI.armed) { UI.armed = true; refreshMenu(); return; }
      it.run();
      UI.armed = false; UI.cleared = true; refreshMenu();
    }
  }
  const list = $('menu-list');
  list.addEventListener('pointerdown', (e) => { if (e.target.closest('.arr')) e.preventDefault(); });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.mi'); if (!li) return;
    const n = +li.dataset.n;
    if (n !== UI.sel) { UI.sel = n; UI.armed = UI.cleared = false; refreshMenu(); }
    const a = e.target.closest('.arr');
    a ? change(+a.dataset.d, n) : activate(n);
  });
  list.addEventListener('pointermove', (e) => {
    const li = e.target.closest('.mi'); if (!li || +li.dataset.n === UI.sel) return;
    UI.sel = +li.dataset.n; UI.armed = UI.cleared = false; refreshMenu();
  });
  $('pr-back').addEventListener('click', () => back());
  // keyboard drives menus on the event itself, so quick presses never merge into one frame
  const MENU_KEYS = {
    ArrowUp: () => move(-1), KeyW: () => move(-1), ArrowDown: () => move(1), KeyS: () => move(1),
    ArrowLeft: () => change(-1), KeyA: () => change(-1), ArrowRight: () => change(1), KeyD: () => change(1),
    Enter: () => activate(), NumpadEnter: () => activate(), Space: () => activate(), Escape: () => back(), Backspace: () => back(),
  };
  addEventListener('keydown', (e) => {
    if (!UI.open || !MENU_KEYS[e.code]) return;
    e.preventDefault();
    input.pressed.delete(e.code);
    if (!e.repeat || /Arrow|Key[WSAD]/.test(e.code)) MENU_KEYS[e.code]();
  });

  // ---------- session flow ----------
  const LIGHT_EL = [...$('lights').children];
  let lightsHide = 0;
  const startLights = () => {
    S.lights = { t: 0, out: 4.2 + 0.3 + Math.random() * 1.9 };
    clearTimeout(lightsHide);
    LIGHT_EL.forEach((e) => e.classList.remove('on'));
    $('lights').classList.remove('out');
    $('lights').classList.add('show');
  };
  const goLive = () => { document.body.classList.remove('live'); void document.body.offsetWidth; document.body.classList.add('live'); };
  // phones: fullscreen + landscape lock + motion permission, all from the tap that starts driving
  const mobileEnter = () => {
    if (!TOUCH) return;
    if (S.input === 'tilt') input.enableTilt().then((ok) => { if (!ok) ticker('<span class="tag yellow">Inclinación</span><span class="msg">Sin sensor de movimiento · abre el juego por HTTPS y permítelo</span>', '', 6); });
    const el = document.documentElement, fs = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fs && !(document.fullscreenElement || document.webkitFullscreenElement)) {
      Promise.resolve(fs.call(el, { navigationUI: 'hide' })).then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
    }
  };
  const pedalIds = { thr: new Set(), brk: new Set() };
  const releasePedals = () => {
    pedalIds.thr.clear(); pedalIds.brk.clear(); input.touch.thr = input.touch.brk = false;
    $('pz-gas').classList.remove('on'); $('pz-brake').classList.remove('on');
  };
  const start = (demo) => {
    mobileEnter();
    applyMass();
    audio.start();
    if (audio.ready) audio.ac.resume();
    applySettings();
    closeMenu();
    S.running = true; S.paused = false; S.autopilot = !!demo;
    timing.dry = !!demo; // the demo shows its sector colours but never touches your saved times
    goLive();
    if (!demo) startLights();
  };
  const resume = () => {
    mobileEnter(); releasePedals();
    closeMenu(); S.paused = false;
    if (audio.ready) audio.ac.resume();
  };
  const resetSession = () => { kart.reset(track.sfIndex - 35); timing.reset(); S.t = 0; S.acc = 0; secState.fill(null); prevInvalid = false; ggTrail.length = 0; };
  const restart = () => {
    resetSession(); resume(); goLive();
    if (!S.autopilot) startLights();
  };
  const quit = () => {
    resetSession();
    if (timing.dry) { timing.dry = false; timing.load(); teleBest = null; }
    S.running = false; S.paused = false; S.autopilot = false; S.lights = null;
    $('lights').classList.remove('show', 'out');
    $('rc').classList.remove('show'); rcT = 0;
    document.body.classList.remove('live');
    if (audio.ready) audio.ac.suspend();
    openMenu('main');
  };
  const pause = () => {
    if (!S.running) return;
    S.paused = true; releasePedals();
    if (audio.ready) audio.ac.suspend();
    openMenu('pause');
  };

  // touch pedals: a whole side of the screen each, any number of fingers
  [['pz-gas', 'thr'], ['pz-brake', 'brk']].forEach(([id, k]) => {
    const el = $(id), ids = pedalIds[k];
    const set = () => { input.touch[k] = ids.size > 0; el.classList.toggle('on', ids.size > 0); };
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); ids.add(e.pointerId); try { el.setPointerCapture(e.pointerId); } catch {} set(); });
    const up = (e) => { if (ids.delete(e.pointerId)) set(); };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => el.addEventListener(t, up));
  });
  // pointerdown, not click: while driving, touches never become clicks (see below)
  $('t-pause').addEventListener('pointerdown', (e) => { e.preventDefault(); pause(); });
  $('t-reset').addEventListener('pointerdown', (e) => { e.preventDefault(); if (S.running && !S.paused && !S.lights) resetToTrack(); });
  if (TOUCH) {
    // no browser zoom: pinch (two thumbs on the pedals), double tap, and while driving any
    // touch at all (it would scroll, zoom or select instead of driving)
    const driving = () => S.running && !S.paused;
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('touchstart', (e) => { if (driving() || e.touches.length > 1) e.preventDefault(); }, { passive: false });
    document.addEventListener('touchmove', (e) => { if (driving() || e.touches.length > 1 || e.scale !== undefined && e.scale !== 1) e.preventDefault(); }, { passive: false });
    if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
    // turning the phone upright or leaving the app pauses the session
    addEventListener('resize', () => { if (S.running && !S.paused && innerHeight > innerWidth) pause(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && S.running && !S.paused) pause(); });
  }

  // ---------- broadcast messages ----------
  let tickerT = 0, tickerEl = null;
  const dropTicker = () => { const el = tickerEl; tickerEl = null; if (!el) return; el.classList.remove('show'); setTimeout(() => el.remove(), 450); };
  const ticker = (html, cls = '', dur = 2.6) => {
    dropTicker();
    const el = document.createElement('div');
    el.className = 'tk ' + cls; el.innerHTML = html;
    $('ticker').appendChild(el);
    void el.offsetWidth; el.classList.add('show');
    tickerEl = el; tickerT = dur;
  };
  const flash = (tag, msg) => ticker(`<span class="tag">${tag}</span><span class="msg">${msg}</span>`);
  let rcT = 0;
  const raceControl = (sub, msg) => {
    // phones have no room for the panel: the message goes to the ticker under the strap
    if (TOUCH) { ticker(`<span class="tag red">${sub}</span><span class="msg">${msg}</span>`, '', 3.5); return; }
    $('rc-msg').innerHTML = `<small>${sub}</small>${msg}`;
    $('rc').classList.add('show');
    rcT = 6;
  };

  // a lap the autopilot drove any part of is not yours (in a demo session nothing is saved anyway)
  const autoVoid = () => { if (!timing.dry && timing.lapStart !== null) { timing.invalid = true; prevInvalid = true; timing.voidWhy ||= 'Piloto automático'; } };
  const resetToTrack = () => {
    const i = track.locate(kart.x, kart.y, kart.loc.i).i;
    kart.reset(i, 0);
    const timed = timing.lapStart !== null;
    timing.invalid = true; prevInvalid = true; timing.voidWhy ||= 'Kart recolocado';
    raceControl(timed ? `Vuelta ${timing.lap}` : 'Vuelta de salida', timed ? 'Kart recolocado en pista · vuelta anulada' : 'Kart recolocado en pista');
  };

  // ---------- telemetry: per-metre channels of this lap and of the best lap ----------
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const hiDpi = (c) => {
    const w = c.width, h = c.height;
    c.style.width = w + 'px'; c.style.height = h + 'px'; c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  };
  const NM = Math.ceil(L) + 1, LM = Math.floor(L);
  const newTele = () => ({ v: new Float32Array(NM).fill(NaN), th: new Float32Array(NM).fill(NaN), br: new Float32Array(NM).fill(NaN) });
  const teleKey = () => 'pedrezuela.tele.v1' + suffix();
  const pack = (a) => Array.from(a, (x) => (Number.isNaN(x) ? null : Math.round(x * 100) / 100));
  const unpack = (a) => Float32Array.from(a, (x) => (x == null ? NaN : x));
  let teleCur = newTele(), teleBest = null, teleM = -1, teleLap = 0;
  const secState = [null, null, null];
  // best-lap channels: stored with the lap; for older saves, speed is rebuilt from the time-per-metre trace
  function bestTele() {
    const t = timing.best?.time;
    if (t == null) return null;
    if (teleBest?.time === t) return teleBest;
    let o = null;
    try { const d = JSON.parse(localStorage.getItem(teleKey()) || 'null'); if (d && Math.abs(d.time - t) < 1e-6) o = { v: unpack(d.v), th: unpack(d.th), br: unpack(d.br) }; } catch {}
    if (!o && timing.best.trace) {
      const tr = timing.best.trace;
      o = newTele();
      for (let m = 2; m < NM - 2; m++) { const a = tr[m - 2], c = tr[m + 2]; if (a != null && c != null && c > a) o.v[m] = 4 / (c - a); }
    }
    teleBest = Object.assign(o || newTele(), { time: t });
    return teleBest;
  }
  function recordTele() {
    if (timing.lap !== teleLap) { // line crossed (or session reset)
      const l = timing.last;
      if (l && !l.invalid && timing.best && timing.best.time === l.time) {
        teleBest = Object.assign(teleCur, { time: l.time });
        if (!timing.dry) try { localStorage.setItem(teleKey(), JSON.stringify({ time: l.time, v: pack(teleCur.v), th: pack(teleCur.th), br: pack(teleCur.br) })); } catch {}
      }
      teleCur = newTele(); teleM = -1; teleLap = timing.lap;
    }
    if (timing.lapStart === null) return;
    const m = Math.min(NM - 1, Math.floor(timing.rel(kart.loc.s)));
    const v = kart.speed, th = kart.throttle, br = kart.brake;
    const from = teleM >= 0 && m > teleM && m - teleM < 25 ? teleM + 1 : m; // fill metres crossed this frame
    for (let i = from; i <= m; i++) { teleCur.v[i] = v; teleCur.th[i] = th; teleCur.br[i] = br; }
    teleM = m;
  }

  const FONT = (px, w = 600) => `${w} ${px}px F1, Saira, sans-serif`;
  const C = { fg: '#ffffff', mute: '#949498', grid: 'rgba(255,255,255,.08)', purple: '#a43dff', green: '#12d35a', red: '#e10600', amber: '#ffb000', ink3: '#38383f' };

  // traces: last 150 m of this lap against the best lap, which also runs 50 m ahead
  const TRc = hiDpi($('tr-cv'));
  const BACK = 150, AHEAD = 50, VMAX = 25;
  function drawTraces() {
    const { g, w, h } = TRc;
    g.clearRect(0, 0, w, h);
    const x0 = 30, x1 = w - 8, sT = 10, sB = 78, tT = 86, tB = 104, bT = 110, bB = 128;
    const m0 = Math.max(0, teleM);
    const X = (d) => x0 + ((d + BACK) / (BACK + AHEAD)) * (x1 - x0);
    g.font = FONT(9); g.textBaseline = 'middle';
    // speed grid
    g.lineWidth = 1;
    for (const k of [20, 40, 60, 80]) {
      const y = Math.round(sB - (k / 3.6 / VMAX) * (sB - sT)) + 0.5;
      g.strokeStyle = C.grid; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
      g.fillStyle = C.mute; g.textAlign = 'right'; g.fillText(k, x0 - 6, y);
    }
    g.textAlign = 'right'; g.fillStyle = C.mute;
    g.fillText('GAS', x0 - 4, (tT + tB) / 2); g.fillText('FRE', x0 - 4, (bT + bB) / 2);
    g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(x0, tT, x1 - x0, tB - tT); g.fillRect(x0, bT, x1 - x0, bB - bT);
    // sector and finish markers
    g.textAlign = 'left';
    [[0, 'Meta'], [L / 3, 'S2'], [(2 * L) / 3, 'S3']].forEach(([sm, lab]) => {
      let d = sm - m0; d = ((d % L) + L * 1.5) % L - L / 2;
      if (d < -BACK || d > AHEAD) return;
      const x = Math.round(X(d)) + 0.5;
      g.strokeStyle = 'rgba(255,255,255,.25)'; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(x, sT - 4); g.lineTo(x, bB); g.stroke(); g.setLineDash([]);
      g.fillStyle = C.mute; g.fillText(lab.toUpperCase(), x + 3, sT - 2);
    });
    const best = bestTele();
    const val = (arr, d, wrap) => { let i = m0 + d; if (i < 0 || i >= NM) { if (!wrap) return NaN; i = ((i % LM) + LM) % LM; } return arr[i]; };
    const line = (arr, y, from, to, wrap, col, lw) => {
      g.strokeStyle = col; g.lineWidth = lw; g.lineJoin = 'round'; g.beginPath();
      let pen = false;
      for (let d = from; d <= to; d++) {
        const v = val(arr, d, wrap);
        if (Number.isNaN(v)) { pen = false; continue; }
        const px = X(d), py = y(v);
        pen ? g.lineTo(px, py) : g.moveTo(px, py); pen = true;
      }
      g.stroke();
    };
    const band = (arr, top, bot, col) => {
      g.fillStyle = col;
      for (let d = -BACK; d <= 0; d++) { const v = val(arr, d, false); if (!(v > 0.01)) continue; const hh = v * (bot - top); g.fillRect(X(d), bot - hh, (x1 - x0) / (BACK + AHEAD) + 0.6, hh); }
    };
    const ys = (v) => sB - Math.min(1, v / VMAX) * (sB - sT);
    band(teleCur.th, tT, tB, C.green);
    band(teleCur.br, bT, bB, C.red);
    if (best) {
      line(best.th, (v) => tB - v * (tB - tT), -BACK, AHEAD, true, C.purple, 1.2);
      line(best.br, (v) => bB - v * (bB - bT), -BACK, AHEAD, true, C.purple, 1.2);
      line(best.v, ys, -BACK, AHEAD, true, C.purple, 1.8);
    }
    line(teleCur.v, ys, -BACK, 0, false, C.fg, 2);
    // now
    const xn = Math.round(X(0)) + 0.5;
    g.strokeStyle = C.fg; g.lineWidth = 1; g.beginPath(); g.moveTo(xn, sT - 4); g.lineTo(xn, bB); g.stroke();
    const vb = best ? val(best.v, 0, true) : NaN;
    if (!Number.isNaN(vb) && teleM >= 0) {
      const dv = (kart.speed - vb) * 3.6;
      g.font = FONT(10, 700); g.textAlign = 'left';
      g.fillStyle = dv >= 0 ? C.green : '#ff4d45';
      g.fillText(`${dv >= 0 ? '+' : '−'}${Math.abs(dv).toFixed(1)} km/h`, xn + 5, ys(kart.speed) - 8 < sT + 6 ? sT + 14 : ys(kart.speed) - 8);
    }
  }

  // g-g diagram: lateral vs longitudinal with the kart's measured grip limits
  const GGc = hiDpi($('gg-cv'));
  const latG = track.envelope?.lateral_g || 1.2, brkG = track.envelope?.braking_g || 0.6, GMAX = 1.5;
  const ggTrail = [];
  function drawGG() {
    const { g, w, h } = GGc;
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = w / 2 - 6, s = R / GMAX;
    g.fillStyle = 'rgba(255,255,255,.03)'; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
    g.strokeStyle = C.grid; g.lineWidth = 1;
    for (const r of [0.5, 1.0, 1.5]) { g.beginPath(); g.arc(cx, cy, r * s, 0, 7); g.stroke(); }
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    // grip envelope: full lateral grip, braking limit below
    g.strokeStyle = 'rgba(255,255,255,.45)'; g.setLineDash([3, 3]); g.beginPath();
    g.ellipse(cx, cy, latG * s, latG * s, 0, Math.PI, 2 * Math.PI);
    g.ellipse(cx, cy, latG * s, brkG * s, 0, 0, Math.PI);
    g.stroke(); g.setLineDash([]);
    g.font = FONT(8); g.fillStyle = C.mute; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('ACEL', cx, cy - R + 8); g.fillText('FRENO', cx, cy + R - 8);
    const px = cx + (kart.ayf / 9.81) * s, py = cy - (kart.axf / 9.81) * s;
    ggTrail.push(px, py); if (ggTrail.length > 90) ggTrail.splice(0, 2);
    for (let i = 0; i < ggTrail.length; i += 2) { g.fillStyle = `rgba(255,255,255,${(i / ggTrail.length) * 0.35})`; g.fillRect(ggTrail[i] - 1, ggTrail[i + 1] - 1, 2, 2); }
    g.fillStyle = C.red; g.strokeStyle = C.fg; g.lineWidth = 1.5; g.beginPath(); g.arc(px, py, 4.5, 0, 7); g.fill(); g.stroke();
  }

  // tyres: top view; colour = combined slip against peak grip, bar = vertical load, lifted wheel fades
  const TYc = hiDpi($('ty-cv'));
  const SURF_COL = { piano: '#ff4d45', escapatoria: '#949498', hierba: '#12d35a', tierra: '#c08a4a' };
  const SURF_TAG = { piano: 'PIANO', escapatoria: 'ESCAP.', hierba: 'HIERBA', tierra: 'TIERRA' };
  function slipCol(sl) { return sl < 0.7 ? '#3d7a52' : sl < 0.95 ? C.green : sl < 1.1 ? C.amber : C.red; }
  function drawTyres() {
    const { g, w, h } = TYc;
    g.clearRect(0, 0, w, h);
    const cx = w / 2, fy = 30, ry = 86, fx = 30, rx = 34, tw = 15, th = 26;
    // chassis
    g.strokeStyle = C.ink3; g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx - fx + 8, fy); g.lineTo(cx + fx - 8, fy); g.moveTo(cx - rx + 8, ry); g.lineTo(cx + rx - 8, ry);
    g.moveTo(cx - 12, fy); g.lineTo(cx - 14, ry); g.moveTo(cx + 12, fy); g.lineTo(cx + 14, ry); g.stroke();
    const W = kart.wheels, Fs = (kart.P.m * 9.81) / 4;
    const pos = [[cx - fx, fy], [cx + fx, fy], [cx - rx, ry], [cx + rx, ry]]; // FL FR RL RR (body y is to the left)
    g.font = FONT(8); g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let k = 0; k < 4; k++) {
      const wk = W[k], [x, y] = pos[k];
      const load = Math.max(0, wk.Fz || 0) / Fs, lifted = load < 0.08;
      g.save(); g.translate(x, y); if (k < 2) g.rotate(-(wk.delta || 0));
      g.globalAlpha = lifted ? 0.3 : 1;
      g.fillStyle = slipCol(wk.slip || 0); g.fillRect(-tw / 2, -th / 2, tw, th);
      const sn = wk.surf?.name;
      if (sn && sn !== 'asfalto') { g.strokeStyle = SURF_COL[sn] || C.fg; g.lineWidth = 2; g.strokeRect(-tw / 2 - 2, -th / 2 - 2, tw + 4, th + 4); }
      g.restore();
      // load bar on the outer side
      const bx = k % 2 === 0 ? x - tw / 2 - 7 : x + tw / 2 + 4, bh = Math.min(1, load / 2) * th;
      g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(bx, y - th / 2, 3, th);
      g.fillStyle = C.fg; g.fillRect(bx, y + th / 2 - bh, 3, bh);
      if (lifted) { g.fillStyle = C.mute; g.fillText('AIRE', x, y + th / 2 + 7); }
      else if (sn && sn !== 'asfalto') { g.fillStyle = SURF_COL[sn] || C.fg; g.fillText(SURF_TAG[sn] || sn.toUpperCase(), x, y + th / 2 + 7); }
    }
  }

  // ---------- camera rig ----------
  const vibe = new Vibe();
  const eye = new THREE.Vector3(), look = new THREE.Vector3(), tmp = new THREE.Vector3();
  const chase = { pos: new THREE.Vector3(), init: false };
  // Head on the neck: a spring-damper per axis relative to the seat, driven by the seat's
  // accelerations (vibe.js). Lateral 3.5 cm/g and fore-aft 2.5 cm/g held (the neck braces), with
  // the overshoot of a real head; vertically the torso sinks into the seat over bumps (~4 Hz).
  // NECK: natural frequency (Hz), damping ratio, static displacement per m/s^2.
  const NECK = { x: [1.8, 0.45, 0.035 / 9.81], z: [2.2, 0.5, 0.025 / 9.81], y: [4.0, 0.3, 1 / (2 * Math.PI * 4.0) ** 2] };
  const hd = { x: 0, vx: 0, z: 0, vz: 0, y: 0, vy: 0 };
  // fast shake: correlated noise per axis (a buzz above the frame rate seen as a blur-like shake)
  const jit = { p: 0, yw: 0, rl: 0 };
  const shake = { amp: 0 };
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;
  const headQ = new THREE.Quaternion(), headE = new THREE.Euler();
  function neck(dt, ax, ay, az) {
    const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
    for (let i = 0; i < n; i++) {
      for (const [p, v, a] of [['x', 'vx', ay], ['z', 'vz', ax], ['y', 'vy', -az]]) {
        const [f, zeta, gain] = NECK[p], w = 2 * Math.PI * f;
        // x'' + 2 zeta w x' + w^2 x = w^2 gain a   (semi-implicit Euler)
        hd[v] += (w * w * (gain * a - hd[p]) - 2 * zeta * w * hd[v]) * h;
        hd[p] += hd[v] * h;
      }
    }
    hd.x = Math.max(-0.08, Math.min(0.08, hd.x)); hd.z = Math.max(-0.08, Math.min(0.08, hd.z));
    hd.y = Math.max(-0.04, Math.min(0.04, hd.y));
  }
  function updateCamera(dt) {
    const r = model.root;
    r.updateMatrixWorld(true);
    const cam = S.running ? S.cam : 1; // menus show the kart from outside
    model.setCockpit(cam === 0);
    const live = S.running && !S.paused;
    const vb = live ? vibe.frame(kart) : null;
    if (cam === 0 || cam === 2) {
      if (live) neck(dt, vb.ax, vb.ay, vb.az);
      shake.amp = Math.max(shake.amp * Math.exp(-dt / 0.18), kart.hit * 0.05);
      // fast shake (rad): tyre buzz (soft-limited so a single crack is a flick, not a jolt), engine
      // (felt through the seat even standing still), hits
      let j = 0;
      if (live) {
        const buzz = 0.4 * vb.buzzF + 0.6 * vb.buzzR;
        j = 0.015 * 0.4 * Math.tanh(buzz / 0.4) + 0.0012 * vb.engine;
        // the onboard camera is bolted to the chassis: more buzz, no neck to soak it up
        if (cam === 2) j *= 1.6;
      }
      const c = 0.45, cn = Math.sqrt(1 - c * c);
      jit.p = c * jit.p + cn * gauss(); jit.yw = c * jit.yw + cn * gauss(); jit.rl = c * jit.rl + cn * gauss();
      const sh = shake.amp * 4;
      const lookYaw = kart.steer * 0.12; // drivers look into the corner
      if (cam === 0) eye.set(hd.x, 0.875 + hd.y, 0.2 + hd.z); // body: x right, y up, z back
      else eye.set(0, 0.42, -0.75);
      eye.applyMatrix4(r.matrixWorld);
      camera.position.copy(eye);
      // orientation = kart orientation * hd yaw/pitch/roll; the hd tilts with the neck's sway
      camera.quaternion.setFromRotationMatrix(r.matrixWorld);
      const hp = cam === 0 ? hd.z * 0.5 + hd.y * 0.6 : 0, hr = cam === 0 ? -hd.x * 0.86 : 0;
      headE.set((cam === 0 ? -0.11 : -0.04) + hp + jit.p * (j + sh * 0.3), (cam === 0 ? lookYaw : 0) + jit.yw * (j * 0.4 + sh * 0.3), hr + jit.rl * (j * 0.7 + sh * 0.3), 'YXZ');
      camera.quaternion.multiply(headQ.setFromEuler(headE));
    } else {
      const c = Math.cos(kart.psi), s = Math.sin(kart.psi);
      const target = tmp.set(kart.x - c * 3.6, kart.z + 1.45, -(kart.y - s * 3.6));
      if (!chase.init) { chase.pos.copy(target); chase.init = true; }
      chase.pos.lerp(target, Math.min(1, dt * 6));
      camera.position.copy(chase.pos);
      look.set(kart.x + c * 2, kart.z + 0.5, -(kart.y + s * 2));
      camera.lookAt(look);
    }
  }

  // ---------- HUD ----------
  const hud = {
    cur: $('cur'), best: $('best'), lapn: $('lapn'), lapl: $('lapl'), valid: $('valid'),
    sec: [0, 1, 2].map((k) => $('sec' + k)),
    live: $('live'), dnum: $('deltanum').lastChild, dfill: $('dfill'),
    speed: $('speed'), rpm: $('rpm'), g: $('gval'), leds: $('leds'),
    off: $('off'), auto: $('autotag'),
  };
  const LEDS = 15; // wheel-style strip: green, red, blue
  for (let i = 0; i < LEDS; i++) hud.leds.appendChild(document.createElement('i'));
  const ledEls = [...hud.leds.children];
  let prevInvalid = false;
  let hudT = 0;
  function updateHud(dt) {
    hudT += dt;
    if (hudT < 1 / 30) return;
    hudT = 0;
    hud.cur.textContent = fmt(timing.current(S.t));
    const timed = timing.lapStart !== null;
    hud.valid.classList.toggle('bad', timing.invalid && timed);
    hud.valid.lastChild.textContent = timing.invalid && timed ? 'Anulada' : 'Válida';
    hud.lapl.textContent = timing.lap ? 'Vuelta' : '';
    hud.lapn.textContent = timing.lap ? timing.lap : 'Salida';
    hud.best.textContent = fmt(timing.best?.time);
    if (timing.invalid && !prevInvalid && timed) raceControl(`Vuelta ${timing.lap} · ${fmt(timing.current(S.t))}`, 'Tiempo anulado · límites de pista');
    prevInvalid = timing.invalid;
    // live delta
    const d = timing.delta(S.t, kart);
    hud.live.classList.toggle('on', d != null);
    if (d == null) { hud.dnum.textContent = timing.best ? '—' : 'Sin ref.'; hud.dnum.style.color = ''; }
    else {
      hud.dnum.textContent = fmtD(d);
      hud.dnum.style.color = d < 0 ? 'var(--green)' : '#ff4d45';
      const w = Math.min(50, Math.abs(d) / 1.0 * 50);
      hud.dfill.style.background = d < 0 ? 'var(--green)' : 'var(--red)';
      hud.dfill.style.left = d < 0 ? 50 - w + '%' : '50%';
      hud.dfill.style.width = w + '%';
    }
    // instrument
    hud.speed.textContent = Math.round(kart.speed * 3.6);
    const rpm = kart.rpm;
    hud.rpm.textContent = Math.round(rpm / 10) * 10;
    hud.g.textContent = (Math.hypot(kart.axf, kart.ayf) / 9.81).toFixed(2);
    const lit = Math.round(Math.max(0, Math.min(1, (rpm - kart.P.ledRpm) / (kart.P.govRpm - kart.P.ledRpm))) * LEDS);
    ledEls.forEach((e, i) => { e.className = i < lit ? (i < 5 ? 'g' : i < 10 ? 'r' : 'b') : ''; });
    hud.leds.classList.toggle('flash', rpm > kart.P.govRpm - 60);
    hud.off.classList.toggle('show', kart.offTrack);
    hud.auto.classList.toggle('show', S.autopilot);
    for (let k = 0; k < 3; k++) {
      const st = secState[k];
      const el = hud.sec[k], now = !st && timed && timing.sector === k;
      el.className = 'sec num' + (st ? ' ' + st.status : '') + (now ? ' now' : '');
      // not reached yet: the dim time is that sector in your best lap (the time to beat)
      const ref = timing.bestSector(k);
      el.lastChild.textContent = st ? st.dur.toFixed(2) : ref != null ? ref.toFixed(2) : '';
      el.lastChild.className = st ? '' : 'ref';
      el.firstChild.style.width = now ? Math.max(0, Math.min(100, ((timing.rel(kart.loc.s) - timing.sectors[k]) / (L / 3)) * 100)) + '%' : '0';
    }
    drawTraces(); drawGG(); drawTyres();

    // timing events
    while (timing.events.length) {
      const e = timing.events.shift();
      if (e.type === 'newlap') continue;
      const dl = (v) => (v != null ? ` <span class="${v < 0 ? 'g' : 'r'}">${fmtD(v)}</span>` : '');
      if (e.type === 'sector') {
        if (e.k === 0) secState[1] = secState[2] = null; // keep last lap's S3 visible until S1
        secState[e.k] = e;
        const what = e.status === 'purple' ? '<span class="msg p">Récord</span>' : e.status === 'invalid' ? '<span class="msg m">No cuenta</span>' : '';
        if (e.k < 2) ticker(`<span class="tag ${e.status}">S${e.k + 1}</span><span class="val num">${e.status === 'invalid' ? `<s>${e.dur.toFixed(3)}</s>` : e.dur.toFixed(3) + dl(e.delta)}</span>${what}`);
      } else if (e.type === 'lap') {
        if (e.invalid) ticker(`<span class="tag red">Vuelta ${e.n}</span><span class="val num"><s>${fmt(e.time)}</s></span><span class="msg">Anulada · ${(e.why || 'límites de pista').toLowerCase()}</span>`, '', 3.2);
        else if (e.improved) ticker(`<span class="tag">${icon('ic-clock')}Mejor vuelta</span><span class="val num">${fmt(e.time)}</span>${e.delta != null ? `<span class="msg num"><span class="g">${fmtD(e.delta)}</span></span>` : ''}`, 'fl', 4.5);
        else ticker(`<span class="tag">Vuelta ${e.n}</span><span class="val num">${fmt(e.time)}${dl(e.delta)}</span>`, '', 3.2);
      }
    }
  }

  // five reds, one per 0.9 s, random hold, lights out releases the kart
  function updateLights(dt) {
    const Lt = S.lights;
    Lt.t += dt;
    const on = Lt.t < Lt.out ? Math.max(0, Math.min(5, Math.floor((Lt.t - 0.6) / 0.9) + 1)) : 0;
    LIGHT_EL.forEach((e, i) => e.classList.toggle('on', i < on));
    if (Lt.t >= Lt.out) {
      S.lights = null;
      $('lights').classList.add('out');
      lightsHide = setTimeout(() => $('lights').classList.remove('show', 'out'), 1300);
    }
  }

  // ---------- adaptive resolution: stays at native (retina) unless the GPU really can't keep up ----------
  // Decides on the median frame time over 2 s, so one-off stalls (GC, a tab switch) never blur the
  // image, and never goes below 75 % of the native pixel ratio (nor below 1 CSS pixel).
  const maxPR = Math.min(devicePixelRatio || 1, 2), minPR = Math.max(1, maxPR * 0.75);
  const perf = {
    dts: [], acc: 0, scale: maxPR, hold: 0,
    sample(dt) {
      if (dt > 0.25) return; // tab hidden or browser stall: says nothing about the GPU
      this.dts.push(dt); this.acc += dt;
      if (this.hold > 0) this.hold -= dt;
      if (this.acc < 2) return;
      const med = this.dts.sort((a, b) => a - b)[this.dts.length >> 1];
      this.dts.length = 0; this.acc = 0;
      const prev = this.scale;
      if (med > 1 / 50 && this.scale > minPR) { this.scale = Math.max(minPR, this.scale - 0.25); this.hold = 20; }
      else if (med < 1 / 57 && this.scale < maxPR && this.hold <= 0) this.scale = Math.min(maxPR, this.scale + 0.25);
      if (prev !== this.scale) renderer.setPixelRatio(this.scale);
    },
  };
  renderer.setPixelRatio(perf.scale);

  // ---------- GPU warm-up: compile every shader and upload every texture before the first lap ----------
  // Otherwise each object compiles its shaders / uploads its textures the first time it enters the
  // view or the shadow camera (which follows the kart), and that frame stalls for 50-150 ms.
  async function warmUp() {
    const hidden = [];
    scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    const texs = new Set();
    scene.traverse((o) => { for (const m of [].concat(o.material || [])) for (const v of Object.values(m)) if (v && v.isTexture) texs.add(v); });
    texs.forEach((t) => renderer.initTexture(t));
    // compileAsync waits for the driver to report every program linked; some browsers never report it
    // for a hidden page, so don't let it block the start (the programs exist either way)
    await Promise.race([renderer.compileAsync(scene, camera), new Promise((ok) => setTimeout(ok, 3000))]);
    // one frame with culling off draws every mesh in both passes: uploads every vertex buffer and
    // compiles the shadow-depth shaders, so no cell of track/terrain stalls the first time it's seen
    const culled = [];
    scene.traverse((o) => { if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; } });
    renderer.render(scene, camera);
    culled.forEach((o) => { o.frustumCulled = true; });
    hidden.forEach((o) => { o.visible = false; });
  }

  // ---------- loop ----------
  const take = (...codes) => codes.some((c) => input.take(c));
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = Math.min(0.1, (now - last) / 1000); // physics keeps real time down to 10 fps
    perf.sample(dt);
    last = now;
    input.pollButtons();

    if (UI.open) {
      if (take('pad12')) move(-1);
      if (take('pad13')) move(1);
      if (take('pad14')) change(-1);
      if (take('pad15')) change(1);
      if (take('pad0')) activate();
      if (take('pad1', 'pad9')) back();
    } else if (S.running && take('Escape', 'KeyP', 'pad9')) pause();
    else if (S.running && take('KeyQ', 'pad8')) quit();
    if (S.running && !S.paused) {
      if (take('KeyC', 'pad3')) { S.cam = (S.cam + 1) % 3; toggled('cam'); }
      if (take('KeyH')) { const v = OPTS.hud.vals; S.hud = v[(optIndex(OPTS.hud) + 1) % v.length][0]; toggled('hud'); }
      if (take('KeyR', 'pad0') && !S.lights) resetToTrack();
      if (take('KeyL')) {
        S.line = !S.line; applySettings(); saveSettings();
        flash(OPTS.line.label, S.line ? 'Sí · <span class="g">verde</span> gas · <span class="y">amarillo</span> sin pedales · <span class="r">rojo</span> freno' : 'No');
      }
      if (take('KeyG')) { S.showGhost = !S.showGhost; toggled('ghost'); }
      if (take('KeyM')) { S.sound = !S.sound; toggled('sound'); }
      if (take('KeyN')) {
        S.input = S.input === 'mouse' ? 'key' : 'mouse'; applySettings(); saveSettings();
        flash(OPTS.input.label, S.input === 'mouse' ? 'Ratón · centro recto · clic izq. gas · dcho. freno' : 'Teclado');
      }
      if (take('KeyO') && !S.lights) {
        S.autopilot = !S.autopilot;
        // taking over a demo: from here your laps count again (your saved times come back)
        if (!S.autopilot && timing.dry) { timing.dry = false; timing.load(); teleBest = null; }
        if (S.autopilot) autoVoid();
        flash(S.autopilot ? 'Demo' : 'Control', S.autopilot ? 'Piloto automático · esta vuelta no cuenta' : 'Manual');
      }

      const inp = input.update(dt, kart.speed);
      if (S.lights) updateLights(dt);
      else {
        S.acc += dt;
        while (S.acc >= DT) {
          const c = S.autopilot ? auto.control(kart, DT) : inp;
          kart.step(DT, c);
          vibe.sample(kart, DT);
          S.t += DT;
          S.acc -= DT;
          timing.update(S.t, kart, DT);
        }
        if (S.autopilot) autoVoid();
        recordTele();
      }
    }
    input.pressed.clear();

    model.update(kart, S.paused || !S.running ? 0 : dt);
    const gp = S.showGhost && S.running ? timing.ghostPose(S.t) : null;
    ghost.root.visible = !!gp;
    if (gp) {
      ghost.root.position.set(gp.x, track.height(gp.x, gp.y), -gp.y);
      ghost.root.rotation.set(0, gp.psi - Math.PI / 2, 0);
      ghost.driver.update(ghost, { ayf: 0 });
    }
    // keep the shadow camera around the kart
    world.dir.target.position.set(kart.x, kart.z, -kart.y);
    world.dir.position.copy(world.dir.target.position).add(tmp.copy(world.sunDir).multiplyScalar(150));
    // a touch of FOV with speed adds to the sense of speed (not in the menu preview)
    const fovT = S.fov + (S.cam === 1 || !S.running ? 0 : 5 * Math.min(1, kart.speed / 20));
    if (Math.abs(camera.fov - fovT) > 0.05) { camera.fov += (fovT - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
    updateCamera(dt);
    if (S.running && !S.paused) {
      const o = vibe.out;
      input.rumble(Math.min(1, 2.2 * o.buzzR + 0.06 * Math.abs(o.az) + o.hit), Math.min(1, 1.8 * o.buzzF + 0.25 * o.engine), dt);
    } else input.rumble(0, 0, dt);
    audio.update(kart);
    if (S.running) { hud.speed.textContent = Math.round(kart.speed * 3.6); updateHud(dt); }
    if (tickerT > 0 && !S.paused) { tickerT -= dt; if (tickerT <= 0) dropTicker(); }
    if (rcT > 0 && !S.paused) { rcT -= dt; if (rcT <= 0) $('rc').classList.remove('show'); }
    renderer.render(scene, camera);
  }
  if (S.kg !== 75 || S.kart !== 'rt10') { status('Preparando el kart…', 100); await new Promise(requestAnimationFrame); applyMass(); }
  status('Preparando gráficos…', 100);
  await warmUp();
  applySettings();
  $('loading').classList.add('hidden');
  openMenu('main');
  requestAnimationFrame(frame);
  window.__sim = { kart, track, timing, S, camera, scene, renderer, UI, perf, input };
}

main().catch((e) => {
  console.error(e);
  document.getElementById('loading-msg').textContent = 'Error: ' + e.message;
});
