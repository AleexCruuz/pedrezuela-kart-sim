// Heading and curvature of a closed line sampled at the track's centerline stations.
// Neighbours are taken at +/- span metres of arc length along the line itself, not +/- k samples:
// on the inside of a tight corner the offset line's samples bunch up (5 cm apart at the tip of
// corner 5, where the centerline radius is barely larger than the inside offset), and an index
// stencil there turned tiny offset changes into huge, fake curvature.
export function lineGeometry(px, py, span = 2, hd = new Float64Array(px.length), k = new Float64Array(px.length)) {
  const n = px.length;
  const seg = new Float64Array(n);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; seg[i] = Math.hypot(px[j] - px[i], py[j] - py[i]); }
  for (let i = 0; i < n; i++) {
    let a = i, back = 0, b = i, ahead = 0;
    while (back < span) { a = (a - 1 + n) % n; back += seg[a]; }
    while (ahead < span) { ahead += seg[b]; b = (b + 1) % n; }
    const ax = px[a], ay = py[a], bx = px[i], by = py[i], cx = px[b], cy = py[b];
    hd[i] = Math.atan2(cy - ay, cx - ax);
    const cr = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    k[i] = (2 * cr) / (Math.hypot(bx - ax, by - ay) * Math.hypot(cx - bx, cy - by) * Math.hypot(cx - ax, cy - ay) + 1e-9);
  }
  return { hd, k, seg };
}
