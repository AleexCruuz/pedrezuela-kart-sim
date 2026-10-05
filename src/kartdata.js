// Per-kart track data. track.json keeps the default kart's (RT10) racing line, speeds, autopilot
// habits and recorded lap at its top level, as before; any other kart keeps its own copy of these
// fields under T.karts[id]. trackFor() gives the track as that kart sees it, saveFor() writes back.

export const KART_FIELDS = ['race_offset', 'ideal_speed', 'ideal_lap', 'envelope', 'speed_factor', 'learned_qss', 'learned_lap', 'driver', 'drive', 'driven'];
const DEFAULT = 'rt10';

// T with kart `id`'s fields on top. A kart with no data of its own yet starts from the default kart's
// line and speed profile (geometry only: its envelope, learned speeds and laps belong to the RT10)
export function trackFor(T, id) {
  if (!id || id === DEFAULT) return T;
  const own = T.karts?.[id] || {};
  const out = { ...T };
  for (const k of KART_FIELDS) if (k !== 'race_offset' && k !== 'ideal_speed') delete out[k];
  return Object.assign(out, own);
}

export function saveFor(T, id, fields) {
  if (!id || id === DEFAULT) return Object.assign(T, fields);
  T.karts ||= {};
  T.karts[id] = { ...(T.karts[id] || {}), ...fields };
  return T;
}

// --kart <id> on a tool's command line (default: the RT10). Anything malformed or unknown stops the tool:
// falling back to the RT10 would quietly overwrite its calibration
export function kartArg(argv = process.argv, known = KNOWN) {
  if (argv.some((a) => a.startsWith('--kart') && a !== '--kart')) throw new Error(`malformed --kart argument: ${argv.slice(2).join(' ')}`);
  const k = argv.indexOf('--kart');
  if (k < 0) return DEFAULT;
  const id = argv[k + 1];
  if (!known.includes(id)) throw new Error(`unknown kart '${id}' (known: ${known.join(', ')})`);
  return id;
}
const KNOWN = ['rt10', 'rotax']; // KARTS in kart.js
