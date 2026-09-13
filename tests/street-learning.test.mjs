import test from 'node:test';
import assert from 'node:assert/strict';
import { StreetGraph, VisualMemory, pointAlong, pathLength } from '../flylab/web/street-learning.js';
const signature = (place, heading = 0) => Float32Array.from({ length: 819 }, (_, i) => {
  const a = i % 91 - 45 + heading, row = Math.floor(i / 91);
  return .5 + .12 * Math.sin(a * .43 + row + place * row * .91) + .13 * Math.cos(a * .19 - row * .45 + place * row * row * .17) + .1 * Math.sin(a * .91 + Math.sin(row) + place * row * .31);
});
const way = (id, nodes, geometry, tags = {}) => ({ id, nodes, geometry, tags: { highway: 'residential', ...tags } });

test('memory learns turn and destination decisions; no memories cannot navigate', () => {
  const m = new VisualMemory();
  assert.equal(m.choose([signature(1)]).action, 'unknown');
  m.learn(signature(1), 'go'); m.learn(signature(7), 'avoid'); m.learn(signature(15), 'stop');
  const selected = m.choose([signature(7, -12), signature(1, 17)]);
  assert.equal(selected.action, 'go'); assert.equal(selected.candidate, 1); assert.equal(selected.errorDeg, 17);
  assert.equal(m.choose([signature(15, -18)]).action, 'stop');
  assert.equal(m.choose([new Float32Array(819)]).action, 'unknown');
  m.clear(); assert.equal(m.choose([signature(1)]).action, 'unknown');
});
test('memory refuses contradictory labels and ambiguous branches', () => {
  const m = new VisualMemory(); m.learn(signature(1), 'go'); m.learn(signature(1), 'avoid');
  assert.equal(m.choose([signature(1)]).action, 'unknown');
  m.clear(); m.learn(signature(1), 'go');
  assert.equal(m.choose([signature(1), signature(1)]).action, 'unknown');
});
test('memory recognizes a demonstrated recovery without sequence or location input', () => {
  const m = new VisualMemory();
  for (const p of [1, 4, 9]) m.learn(signature(p), 'go');
  m.learn(signature(15), 'stop');
  for (const p of [9, 1, 4, 1]) assert.equal(m.choose([signature(p, 11)]).action, 'go');
  assert.equal(m.size, 4);
});
test('road graph follows corners and cannot cut through buildings or disconnected crossings', () => {
  const s = new StreetGraph([way(1, [1, 2, 3], [{ lat: 0, lon: 0 }, { lat: 0, lon: .001 }, { lat: .001, lon: .001 }]),
    way(2, [4, 5], [{ lat: -.001, lon: .0005 }, { lat: .001, lon: .0005 }])]);
  const a = s.snap({ lat: 0, lng: .0001 }), b = s.snap({ lat: .0008, lng: .001 });
  const path = s.path(a, b, 250); assert.ok(path); assert.ok(pathLength(path) > 180);
  const middle = pointAlong(path, 80); assert.ok(Math.abs(middle.lat) < 1e-8);
  assert.equal(s.path(a, s.snap({ lat: .0008, lng: .0005 }), 500), null);
});
test('road restrictions reject reverse one-way travel, footpaths and private roads', () => {
  const geometry = [{ lat: 0, lon: 0 }, { lat: 0, lon: .001 }];
  const s = new StreetGraph([way(1, [1, 2], geometry, { oneway: 'yes' }), way(2, [3, 4], geometry, { highway: 'footway' }), way(3, [5, 6], geometry, { access: 'private' })]);
  assert.equal(s.segments.length, 1);
  const a = s.snap({ lat: 0, lng: .0001 }), b = s.snap({ lat: 0, lng: .0009 });
  assert.ok(s.path(a, b)); assert.equal(s.path(b, a), null);
  assert.equal(s.snap({ lat: .001, lng: .0005 }), null);
});
export { signature };

test('capture heading resolves ambiguous road assignment at a crossing', () => {
  const s = new StreetGraph([
    way(1, [1,2], [{lat:0,lon:0},{lat:.001,lon:0}], {name:'North street'}),
    way(2, [3,4], [{lat:.0005,lon:-.001},{lat:.0005,lon:.001}], {name:'Cross street',oneway:'yes'})
  ]);
  const p={lat:.00049,lng:.00002};
  assert.equal(s.snap(p).segment.name,'Cross street');
  assert.equal(s.snap(p,18,0).segment.name,'North street');
});
