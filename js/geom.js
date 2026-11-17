// Geometry helpers for strokes.
// A stroke is a flat array [x0, y0, p0, x1, y1, p1, ...] (p = pen pressure 0..1).

export function pointCount(s) {
  return (s.length / 3) | 0;
}

// Ramer–Douglas–Peucker simplification (keeps pressure of kept points).
export function simplify(s, eps) {
  const n = pointCount(s);
  if (n <= 2) return s.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = s[a * 3], ay = s[a * 3 + 1], bx = s[b * 3], by = s[b * 3 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = s[i * 3] - ax, py = s[i * 3 + 1] - ay;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const ex = px - t * dx, ey = py - t * dy;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(s[i * 3], s[i * 3 + 1], s[i * 3 + 2]);
  return out;
}

export function roundStroke(s, digits = 4) {
  const f = 10 ** digits;
  return s.map((v) => Math.round(v * f) / f);
}

export function bbox(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i < s.length; i += 3) {
      const x = s[i], y = s[i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x0 === Infinity) return null;
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

// Turn a polyline into smooth quadratic segments through the midpoints.
// Returns { start: [x, y], segs: [[cx, cy, x, y], ...] }.
export function toQuads(s) {
  const n = pointCount(s);
  const P = (i) => [s[i * 3], s[i * 3 + 1]];
  const p0 = P(0);
  if (n === 1) return { start: p0, segs: [[p0[0] + 0.0001, p0[1], p0[0] + 0.0002, p0[1] + 0.0001]] };
  if (n === 2) {
    const p1 = P(1);
    return { start: p0, segs: [[(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, p1[0], p1[1]]] };
  }
  const segs = [];
  let prev = p0;
  for (let i = 1; i < n - 1; i++) {
    const c = P(i), nx = P(i + 1);
    const m = [(c[0] + nx[0]) / 2, (c[1] + nx[1]) / 2];
    segs.push([c[0], c[1], m[0], m[1]]);
    prev = m;
  }
  const last = P(n - 1);
  segs.push([(prev[0] + last[0]) / 2, (prev[1] + last[1]) / 2, last[0], last[1]]);
  return { start: p0, segs };
}

// Variable-width outline ("ribbon") for fountain-pen look. widthAt(p) -> full width.
export function ribbon(s, widthAt) {
  // densify a little so curves stay smooth
  const pts = [];
  const n = pointCount(s);
  for (let i = 0; i < n; i++) {
    const x = s[i * 3], y = s[i * 3 + 1], p = s[i * 3 + 2];
    if (i > 0) {
      const px = s[i * 3 - 3], py = s[i * 3 - 2], pp = s[i * 3 - 1];
      const mx = (px + x) / 2, my = (py + y) / 2;
      pts.push([mx, my, (pp + p) / 2]);
    }
    pts.push([x, y, p]);
  }
  const m = pts.length;
  if (m === 1) {
    const [x, y, p] = pts[0];
    const r = widthAt(p) / 2;
    const out = [];
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      out.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
    }
    return out;
  }
  const normals = [];
  for (let i = 0; i < m; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(m - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    normals.push([-ty / l, tx / l]);
  }
  const left = [], right = [];
  for (let i = 0; i < m; i++) {
    const [x, y, p] = pts[i];
    const r = widthAt(p) / 2;
    left.push([x + normals[i][0] * r, y + normals[i][1] * r]);
    right.push([x - normals[i][0] * r, y - normals[i][1] * r]);
  }
  const cap = (center, from, r, steps = 6) => {
    const out = [];
    const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]);
    for (let k = 1; k < steps; k++) {
      const a = a0 - (k / steps) * Math.PI; // sweep around the stroke tip
      out.push([center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r]);
    }
    return out;
  };
  const last = pts[m - 1], first = pts[0];
  return [
    ...left,
    ...cap(last, left[m - 1], widthAt(last[2]) / 2),
    ...right.reverse(),
    ...cap(first, right[right.length - 1], widthAt(first[2]) / 2),
  ];
}

// Smooth pseudo-random displacement so the same glyph never looks identical twice.
export function wobble(rng, amp) {
  const f1 = 2 + rng() * 3, f2 = 2 + rng() * 3;
  const p1 = rng() * 6.283, p2 = rng() * 6.283, p3 = rng() * 6.283, p4 = rng() * 6.283;
  return (x, y) => [
    amp * (Math.sin(f1 * y + p1) * 0.7 + Math.sin(f2 * x + p2) * 0.3),
    amp * (Math.sin(f2 * x + p3) * 0.7 + Math.sin(f1 * y + p4) * 0.3),
  ];
}
