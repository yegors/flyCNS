import test from 'node:test';
import assert from 'node:assert/strict';
import { distance, parsePoint, planRoute, projectRay, describeImage, matchView, seededRandom, wrap } from '../flylab/web/navigation-core.js';

// A continuous spherical texture rendered through a pinhole camera. This fixture
// exercises the image sampler and matcher together without Google or a browser.
function scene(heading) {
  const width = 480, height = 240, data = new Uint8ClampedArray(width * height * 4);
  const f = width / (2 * Math.tan(Math.PI / 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const az = Math.atan((x - width / 2) / f), el = Math.atan((height / 2 - y) * Math.cos(az) / f);
    const a = az * 180 / Math.PI + heading, e = el * 180 / Math.PI;
    const b = 128 + 28 * Math.sin(a * .43 + e * .15) + 30 * Math.cos(a * .19 - e * .45) + 23 * Math.sin(a * .91 + Math.sin(e));
    const k = (y * width + x) * 4; data[k] = data[k + 1] = data[k + 2] = b; data[k + 3] = 255;
  }
  return { width, height, data };
}

test('pixel matching recovers left/right yaw and closes the visual loop', () => {
  const reference = describeImage(scene(0));
  for (const heading of [-27, -26.7, -16, -16.3, 0, 19, 19.4, 26]) {
    const result = matchView(reference, describeImage(scene(heading)));
    assert.ok(result.valid, JSON.stringify(result));
    assert.ok(Math.abs(result.errorDeg - heading) <= 1, JSON.stringify(result));
    const corrected = matchView(reference, describeImage(scene(heading - result.errorDeg)));
    assert.ok(corrected.valid && Math.abs(corrected.errorDeg) <= 1);
  }
});
test('occluded and textureless images cannot authorize traversal', () => {
  const reference = describeImage(scene(0));
  assert.equal(matchView(reference, new Float32Array(819)).valid, false);
  assert.equal(matchView(new Float32Array(819).fill(.5), new Float32Array(819).fill(.5)).valid, false);
});
test('rectilinear retina masks lateral/rear receptors and projects in correct directions', () => {
  assert.deepEqual(projectRay(0, 0, 480, 240), [240, 120]);
  assert.equal(projectRay(100, 0, 480, 240), null);
  assert.equal(projectRay(-65, 0, 480, 240), null);
  assert.equal(projectRay(0, 80, 480, 240), null);
  assert.ok(projectRay(30, 10, 480, 240)[0] > 240);
  assert.ok(projectRay(30, 10, 480, 240)[1] < 120);
});
const graph = {
  a: { id: 'a', lat: 0, lng: 0, links: [{ id: 'dead', heading: 90 }, { id: 'b', heading: 0 }] },
  dead: { id: 'dead', lat: 0, lng: .0009, links: [{ id: 'a', heading: 270 }] },
  b: { id: 'b', lat: .001, lng: 0, links: [{ id: 'c', heading: 90 }] },
  c: { id: 'c', lat: .001, lng: .001, links: [{ id: 'd', heading: 180 }] },
  d: { id: 'd', lat: 0, lng: .001, links: [] },
};
test('route search escapes geographic dead ends and returns only connected edges', async () => {
  const route = await planRoute(graph.a, graph.d, async id => graph[id]);
  assert.deepEqual(route.map(n => n.id), ['a', 'b', 'c', 'd']);
  route.slice(1).forEach((n, i) => assert.ok(route[i].links.some(l => l.id === n.id)));
});
test('disconnected routes, cancellation and bounded search fail explicitly', async () => {
  await assert.rejects(planRoute(graph.d, graph.a, async id => graph[id]), /no connected route/);
  await assert.rejects(planRoute(graph.a, graph.d, async id => graph[id], { maxNodes: 1 }), /search budget/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(planRoute(graph.a, graph.d, async id => graph[id], { signal: abort.signal }), /abort/i);
});
test('coordinates and seeds are deterministic and validated', () => {
  assert.deepEqual(parsePoint('43.65, -79.38'), { lat: 43.65, lng: -79.38 });
  for (const value of ['', '1,', '90,0', '0,181', 'NaN,0', '1,2,3']) assert.throws(() => parsePoint(value));
  const a = seededRandom(42), b = seededRandom(42);
  assert.deepEqual(Array.from({ length: 20 }, a), Array.from({ length: 20 }, b));
  assert.equal(wrap(359), -1); assert.equal(wrap(-361), -1);
  assert.ok(distance({ lat: 0, lng: 0 }, { lat: 0, lng: .001 }) > 111);
});
