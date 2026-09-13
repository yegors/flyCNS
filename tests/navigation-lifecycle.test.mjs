import test from 'node:test';
import assert from 'node:assert/strict';
import { NavigationLab } from '../flylab/web/navigation.js';

// Exercise real learner and real lifecycle with only the world/photo boundaries mocked.
globalThis.document = { getElementById: () => null };
function signature(place, heading = 0) {
  return Float32Array.from({ length: 819 }, (_, i) => {
    const a = i % 91 - 45 + heading, row = Math.floor(i / 91);
    return .5 + .12 * Math.sin(a * (.33 + place * .01) + row * (place + 1)) + .13 * Math.cos(a * (.16 + place * .007) - row * .45) + .1 * Math.sin(a * (.8 + place * .03) + Math.sin(row + place));
  });
}
function fixture(condition = 'intact') {
  const fields = new Map(), q = selector => { if (!fields.has(selector)) fields.set(selector, { value: '', textContent: '', dataset: {} }); return fields.get(selector); };
  q('#nav-seed').value = '4'; q('#nav-condition').value = condition;
  const app = { ws: { readyState: 1 }, ema: { lamina_L: 15 }, cfg: {}, frame: { fix: true }, resetSerial: 0, simT: 0,
    send(m) { if (m.cmd === 'reset') this.resetSerial++; },
    views: { map: { w: { lat: 0, lng: 0 }, snapTo(lat, lng) { this.w.lat = lat; this.w.lng = lng; } }, eyes: { setSource() {}, showNavigation() {}, holdNavigation() {} } } };
  const nav = new NavigationLab(app); nav.q = q;
  const a = { id: 'a', lat: 0, lng: 0, heading: 0, road: { lat: 0, lng: 0, segment: { name: 'Test street' } } };
  const b = { id: 'b', lat: 0, lng: .000001, heading: 0, road: { lat: 0, lng: .000001, segment: { name: 'Test street' } }, links: [] };
  a.links = [{ id: 'b', heading: 0, path: [a.road, b.road] }];
  nav.route = [a, b]; nav.memory.learn(signature(1), 'go'); nav.memory.learn(signature(15), 'stop');
  nav.environmentNode = async id => id === 'a' ? a : b;
  nav.image = async (node, heading) => ({ descriptor: signature(node.id === 'a' ? 1 : 15, heading), canvas: {} });
  nav.expose = async () => { app.simT += 100; };
  return { nav, app, q };
}
test('learned trial decides from images and recognizes the finish', async () => {
  const { nav, app } = fixture(); await nav.start();
  assert.equal(nav.state, 'arrived'); assert.equal(app.views.map.w.lng, .000001);
  assert.equal(nav.samples[0].action, 'go'); assert.equal(nav.samples.at(-1).action, 'stop');
  assert.equal(nav.samples[0].rates.lamina_L, 15); assert.ok(nav.trial.travelledMeters > 0);
});
for (const [condition, outcome] of [['blank', 'occluded'], ['empty', 'untrained']]) test(`${condition} comparison never moves`, async () => {
  const { nav, app } = fixture(condition); await nav.start();
  assert.equal(nav.state, outcome); assert.equal(app.views.map.w.lng, 0); assert.equal(nav.trial.travelledMeters, 0);
});
test('stop invalidates pending imagery and blocks late motion', async () => {
  const { nav, app } = fixture(); let release, started;
  const observing = new Promise(resolve => { started = resolve; });
  nav.image = async () => { started(); return new Promise(resolve => { release = resolve; }); };
  const trial = nav.start(); await observing; nav.stop(); release({ descriptor: signature(1), canvas: {} }); await trial;
  assert.equal(nav.state, 'stopped'); assert.equal(app.views.map.w.lng, 0); assert.equal(nav.samples.length, 0);
});
test('pause holds an in-flight observation until resume', async () => {
  const { nav } = fixture(); let release, started;
  const observing = new Promise(resolve => { started = resolve; }), normal = nav.image;
  nav.image = async (...args) => { nav.image = normal; started(); return new Promise(resolve => { release = () => resolve(normal(...args)); }); };
  const trial = nav.start(); await observing; nav.pause(); release(); await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(nav.state, 'paused'); assert.equal(nav.samples.length, 0); nav.pause(); await trial; assert.equal(nav.state, 'arrived');
});
test('visual false-positive destination fails the independent location scorer', async () => {
  const { nav, app } = fixture(); nav.memory.clear(); nav.memory.learn(signature(1), 'stop');
  await nav.start(); assert.equal(nav.state, 'failed'); assert.equal(app.views.map.w.lng, 0);
});
