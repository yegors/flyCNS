import { clamp, distance, matchView } from './navigation-core.js';

export const bearing = (a, b) => Math.atan2((b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180), b.lat - a.lat) * 180 / Math.PI;
export const interpolate = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
export const pathLength = path => path.slice(1).reduce((n, p, i) => n + distance(path[i], p), 0);
export function pointAlong(path, meters) {
  for (let i = 1; i < path.length; i++) {
    const length = distance(path[i - 1], path[i]);
    if (meters <= length) return { ...interpolate(path[i - 1], path[i], length ? meters / length : 0), heading: bearing(path[i - 1], path[i]) };
    meters -= length;
  }
  return { ...path.at(-1), heading: bearing(path.at(-2) || path[0], path.at(-1)) };
}

// Geometry belongs to the environment, never to VisualMemory. Movement follows
// connected OSM road segments, respecting simple oneway/access tags. This is not
// a traffic simulator: turn restrictions, signals and lane rules are not modeled.
export class StreetGraph {
  constructor(elements) {
    this.points = new Map(); this.edges = new Map(); this.segments = [];
    const allowed = /^(primary|secondary|tertiary|residential|unclassified|living_street|primary_link|secondary_link|tertiary_link)$/;
    for (const way of elements) {
      const tags = way.tags || {};
      if (!allowed.test(tags.highway) || [tags.access, tags.vehicle, tags.motor_vehicle].some(v => ['no', 'private'].includes(v))) continue;
      if (tags.area === 'yes' || !way.geometry || way.nodes?.length !== way.geometry.length) continue;
      let forward = true, reverse = true;
      if (['yes', '1', 'true'].includes(tags.oneway) || tags.junction === 'roundabout' && tags.oneway !== 'no') reverse = false;
      if (tags.oneway === '-1') forward = false;
      for (let i = 1; i < way.nodes.length; i++) {
        const a = way.geometry[i - 1], b = way.geometry[i];
        if (![a?.lat, a?.lng ?? a?.lon, b?.lat, b?.lng ?? b?.lon].every(Number.isFinite)) continue;
        const p = { lat: a.lat, lng: a.lng ?? a.lon }, q = { lat: b.lat, lng: b.lng ?? b.lon };
        const u = way.nodes[i - 1], v = way.nodes[i], length = distance(p, q);
        if (length < .05) continue;
        this.points.set(u, p); this.points.set(v, q);
        this.segments.push({ u, v, a: p, b: q, length, forward, reverse, name: tags.name || 'City street' });
        for (const [from, to, enabled] of [[u, v, forward], [v, u, reverse]]) if (enabled) {
          if (!this.edges.has(from)) this.edges.set(from, []);
          this.edges.get(from).push({ to, length });
        }
      }
    }
  }
  snap(p, maxDistance = 18) {
    let best = null;
    const sx = Math.cos(p.lat * Math.PI / 180);
    for (const segment of this.segments) {
      const { a, b } = segment, dx = (b.lng - a.lng) * sx, dy = b.lat - a.lat;
      const t = clamp(((p.lng - a.lng) * sx * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy), 0, 1);
      const point = interpolate(a, b, t), gap = distance(p, point);
      if (gap <= maxDistance && (!best || gap < best.gap)) best = { ...point, t, segment, gap };
    }
    return best;
  }
  path(a, b, limit = 130) {
    if (!a || !b) return null;
    const sa = a.segment, sb = b.segment;
    if (sa === sb && ((b.t >= a.t && sa.forward) || (b.t <= a.t && sa.reverse))) return [a, b];
    const costs = new Map(), parents = new Map(), open = [];
    for (const [id, cost, enabled] of [[sa.v, (1 - a.t) * sa.length, sa.forward], [sa.u, a.t * sa.length, sa.reverse]]) if (enabled) { costs.set(id, cost); open.push(id); }
    const end = new Map(); if (sb.forward) end.set(sb.u, b.t * sb.length); if (sb.reverse) end.set(sb.v, (1 - b.t) * sb.length);
    let found = null, total = limit;
    while (open.length) {
      open.sort((u, v) => costs.get(u) - costs.get(v)); const id = open.shift(), cost = costs.get(id);
      if (cost > total) continue;
      if (end.has(id) && cost + end.get(id) <= total) { found = id; total = cost + end.get(id); }
      for (const edge of this.edges.get(id) || []) {
        const next = cost + edge.length;
        if (next < (costs.get(edge.to) ?? Infinity) && next <= total) {
          costs.set(edge.to, next); parents.set(edge.to, id); if (!open.includes(edge.to)) open.push(edge.to);
        }
      }
    }
    if (found === null) return null;
    const ids = [found]; while (parents.has(ids[0])) ids.unshift(parents.get(ids[0]));
    return [a, ...ids.map(id => this.points.get(id)), b];
  }
  transition(a, b) {
    const direct = distance(a, b);
    if (direct < 1 || direct > 100) return null;
    const path = this.path(a.road, b.road, Math.min(130, direct * 1.7 + 12));
    return path && pathLength(path) >= 1 ? path : null;
  }
}

// Episodic imitation learning. The learned state is ONLY visual signatures and
// demonstrated action labels. No pano ID, coordinates, route index or heading
// can be supplied through this interface. Test never updates these memories.
export class VisualMemory {
  constructor() { this.examples = []; }
  learn(signature, action) {
    if (!['go', 'avoid', 'stop'].includes(action) || signature.length !== 819) throw new Error('Invalid learning example');
    this.examples.push({ signature: Float32Array.from(signature), action });
  }
  clear() { this.examples = []; }
  get size() { return this.examples.length; }
  recognize(signature) {
    const ranked = this.examples.map((example, memory) => ({ ...matchView(example.signature, signature), action: example.action, memory }))
      .filter(m => m.valid).sort((a, b) => b.correlation - a.correlation);
    const best = ranked[0]; if (!best) return null;
    const rival = ranked.find(m => m.action !== best.action);
    if (rival && best.correlation - rival.correlation < .035) return null;
    return best;
  }
  choose(observations) {
    if (!this.size) return { action: 'unknown', reason: 'No memories yet. Learn the trip first.' };
    const choices = observations.map((signature, candidate) => ({ candidate, match: this.recognize(signature) }))
      .filter(c => c.match && c.match.action !== 'avoid').sort((a, b) => b.match.correlation - a.match.correlation);
    if (!choices.length) return { action: 'unknown', reason: 'I do not recognize a safe way forward. I have stopped.' };
    const best = choices[0], rival = choices.find(c => c.match.action !== best.match.action || c.candidate !== best.candidate);
    if (rival && rival.match.action !== 'stop' && best.match.correlation - rival.match.correlation < .025) {
      return { action: 'unknown', reason: 'Two directions look too similar. I have stopped rather than guessed.' };
    }
    return { action: best.match.action, candidate: best.candidate, ...best.match };
  }
}
