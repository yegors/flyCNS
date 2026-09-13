import { wrap } from './navigation-core.js';
import { pathLength, pointAlong } from './street-learning.js';

// Neural readouts set speed and viewing direction. Geometry supplies a virtual
// road boundary, not an extra brain signal. No button directly sets motor rates.
export class NeuralStreetDriver {
  constructor(node, heading = 0) { this.node = node; this.heading = heading; this.segment = null; this.total = 0; }
  tick(dt, rates, playing) {
    if (!playing || !this.node) return null;
    dt = Math.min(.1, Math.max(0, dt));
    const turn = ((rates.steer_R || 0) - (rates.steer_L || 0)) * .8;
    if (!this.segment) this.heading = wrap(this.heading + Math.max(-100, Math.min(100, turn)) * dt);
    const backward = (rates.backward || 0) > 5;
    const speed = backward ? Math.min(2.5, (rates.backward || 0) / 12) : Math.min(4, Math.max(0, ((rates.walk || 0) - 2) / 10));
    if (!this.segment && speed > .05) {
      const target = this.heading + (backward ? 180 : 0);
      const choices = this.node.links.filter(l => l.path?.length > 1)
        .map(l => ({ link: l, error: Math.abs(wrap(l.heading - target)) })).sort((a, b) => a.error - b.error);
      if (!choices.length || choices[0].error > 65) return { heading: this.heading, blocked: true, speed: 0 };
      this.segment = { link: choices[0].link, moved: 0, backward, length: pathLength(choices[0].link.path) };
    }
    if (!this.segment) return { heading: this.heading, speed: 0 };
    const segment = this.segment, reversing = backward !== segment.backward;
    const amount = Math.min(reversing ? segment.moved : segment.length - segment.moved, speed * dt);
    segment.moved += reversing ? -amount : amount; this.total += amount;
    const point = pointAlong(segment.link.path, segment.moved);
    this.heading = wrap(point.heading + (segment.backward ? 180 : 0));
    const result = { ...point, heading: this.heading, speed, total: this.total };
    if (segment.moved >= segment.length || (reversing && segment.moved <= 0)) {
      result.arrived = reversing ? this.node.id : segment.link.id; this.segment = null; this.node = null;
    }
    return result;
  }
}
