// Pure functions used by the lab and its offline regression tests.
export const wrap = a => ((a + 180) % 360 + 360) % 360 - 180;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function distance(a, b) {
  const r = Math.PI / 180, p = (b.lat - a.lat) * r, l = (b.lng - a.lng) * r;
  return 12742000 * Math.asin(Math.sqrt(clamp(Math.sin(p / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(l / 2) ** 2, 0, 1)));
}
export function parsePoint(text) {
  const fields = text.trim().split(',');
  if (fields.length !== 2 || fields.some(s => !s.trim())) throw new Error('Use latitude, longitude for both points.');
  const [lat, lng] = fields.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) throw new Error('Coordinates are outside the supported map range.');
  return { lat, lng };
}
export function seededRandom(seed) {
  let n = seed >>> 0;
  return () => { n += 0x6D2B79F5; let t = Math.imul(n ^ n >>> 15, 1 | n); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// A bounded graph search. Coordinates are available to the route teacher only.
// Every returned transition is an actual directed StreetViewLink.
export async function planRoute(start, goal, getNode, { maxNodes = 180, signal, progress = () => {} } = {}) {
  const nodes = new Map([[start.id, start]]), open = [start.id], cost = new Map([[start.id, 0]]), parent = new Map();
  const closed = new Set();
  let requests = 0;
  while (open.length) {
    signal?.throwIfAborted();
    open.sort((a, b) => cost.get(a) + distance(nodes.get(a), goal) - cost.get(b) - distance(nodes.get(b), goal));
    const id = open.shift(), node = nodes.get(id);
    if (id === goal.id) {
      const path = [node];
      while (parent.has(path[0].id)) path.unshift(nodes.get(parent.get(path[0].id)));
      return path;
    }
    closed.add(id);
    for (const link of node.links) {
      signal?.throwIfAborted();
      if (!link.id || !Number.isFinite(link.heading) || closed.has(link.id)) continue;
      let next = nodes.get(link.id);
      if (!next) {
        if (++requests > maxNodes) throw new Error(`No route within the ${maxNodes}-panorama search budget. Choose closer points on connected coverage.`);
        next = await getNode(link.id); signal?.throwIfAborted(); nodes.set(link.id, next); progress(requests);
      }
      const g = cost.get(id) + distance(node, next);
      if (g < (cost.get(link.id) ?? Infinity)) {
        cost.set(link.id, g); parent.set(link.id, id);
        if (!open.includes(link.id)) open.push(link.id);
      }
    }
  }
  throw new Error('The selected Street View panoramas have no connected route.');
}

// Pinhole projection for Google's rectilinear Static images (pitch zero).
// Out-of-view receptors are masked, never clamped onto an edge pixel.
export function projectRay(az, el, width, height, fov = 120) {
  const a = az * Math.PI / 180, e = el * Math.PI / 180;
  if (Math.abs(az) >= 90) return null;
  const f = width / (2 * Math.tan(fov * Math.PI / 360));
  const x = width / 2 + f * Math.tan(a), y = height / 2 - f * Math.tan(e) / Math.cos(a);
  return x >= 0 && x < width && y >= 0 && y < height ? [Math.floor(x), Math.floor(y)] : null;
}

// Angular luminance signatures: 91 azimuths x 9 elevations, with no coordinates,
// headings, link IDs, or destination information available to the matcher.
export function describeImage({ data, width, height }) {
  const values = new Float32Array(91 * 9);
  for (let row = 0; row < 9; row++) for (let col = 0; col < 91; col++) {
    const p = projectRay(col - 45, (row - 4) * 4, width, height);
    if (!p) continue;
    const k = (p[1] * width + p[0]) * 4;
    values[row * 91 + col] = (data[k] * .2126 + data[k + 1] * .7152 + data[k + 2] * .0722) / 255;
  }
  return values;
}
export function matchView(reference, observation) {
  if (reference.length !== 819 || observation.length !== 819) throw new Error('Invalid visual signature.');
  const scores = [];
  for (let shift = -35; shift <= 35; shift++) {
    let n = 0, a = 0, b = 0, aa = 0, bb = 0, ab = 0;
    for (let row = 0; row < 9; row++) for (let x = 35; x < 56; x++) {
      const u = reference[row * 91 + x], v = observation[row * 91 + x - shift];
      n++; a += u; b += v; aa += u * u; bb += v * v; ab += u * v;
    }
    const va = aa - a * a / n, vb = bb - b * b / n;
    const score = va / n < .00015 || vb / n < .00015 ? -1 : (ab - a * b / n) / Math.sqrt(va * vb);
    scores.push({ shift, score });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0], other = scores.find(s => Math.abs(s.shift - best.shift) > 5);
  return { errorDeg: best.shift, correlation: best.score, margin: best.score - other.score,
    valid: best.score > .65 && best.score - other.score > .025 && Math.abs(best.shift) < 35 };
}
