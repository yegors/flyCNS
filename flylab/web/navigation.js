import { distance, parsePoint, seededRandom, planRoute, describeImage } from './navigation-core.js';
import { StreetGraph, VisualMemory, pathLength, pointAlong, matchMemory } from './street-learning.js';
import { ManualControl } from './manual-control.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ZERO = { cmd: 'senses', odor_L: 0, odor_R: 0, sugar: 0, loom: 0, hunger: 0, wander_L: 0, wander_R: 0 };
const LIMIT = 240;
const DEMO = ['43.65410, -79.38317', '43.65500, -79.38355'];

export class NavigationLab {
  constructor(app) {
    this.app = app; this.state = 'idle'; this.route = []; this.epoch = 0; this.markers = [];
    this.motor = {}; this.owned = true; this.memory = new VisualMemory(); this.samples = [];
    this.imageRequests = 0; this.nodeRequests = 0; this.history = [];
    this.manual = new ManualControl(this);
  }
  mount(el) {
    this.el = el;
    el.innerHTML = `<div class="nav-heading"><span class="eyebrow">YOUR FLY BUDDY</span><span id="nav-state" class="state-pill">Ready</span></div>
      <h2>Learn a little journey.</h2><p class="muted">Show your fly a trip, then see if it remembers which way to go.</p>
      <div class="point-choice"><span class="point-dot">A</span><button id="nav-pick-a">Choose start on map</button></div>
      <div class="point-choice"><span class="point-dot end">B</span><button id="nav-pick-b">Choose finish on map</button></div>
      <p class="small muted" id="nav-points">A short Toronto street trip is already selected.</p>
      <button id="nav-prepare" class="primary wide">1. Learn trip</button>
      <button id="nav-start" class="wide" disabled>2. Try from memory</button>
      <div class="row"><button id="nav-pause" disabled>Pause</button><button id="nav-stop" disabled>Stop</button><button id="nav-home">Show trip</button></div>
      <progress id="nav-progress" value="0" max="1"></progress>
      <div id="nav-status" role="status" aria-live="polite">Start with Learn trip. You can watch the views it remembers.</div>
      <div class="nav-metrics"><div><span>Travelled</span><b id="nav-distance">0 m</b></div><div><span>Memories</span><b id="nav-memory">0</b></div></div>
      <p class="explain">The fly stays on mapped streets. It stops if the view is unfamiliar. This is a visual-memory learner, not a trained biological fly brain.</p>
      <details id="test-options"><summary>Try a learning test</summary><label class="nav-field">What should the fly use?<select id="nav-condition"><option value="intact">Its learned memories</option><option value="empty">No memory — comparison</option><option value="blank">Covered eyes — comparison</option><option value="recovery">Start at a learned wrong turn</option></select></label>
      <p class="small muted">No memory and covered eyes should stop the fly. A learned wrong turn tests whether it can find its way back.</p>
      <div class="nav-options"><label>Repeatable trial number<input id="nav-seed" type="number" value="1" min="0" max="4294967295"></label></div>
      <div id="nav-history" class="small"></div><button id="nav-export" disabled>Save test results</button><button id="nav-forget">Forget trip</button></details>
      <details><summary>Change coordinates</summary><label class="nav-field">Start (latitude, longitude)<input id="nav-a" value="${DEMO[0]}" aria-label="Start latitude, longitude"></label><label class="nav-field">Finish (latitude, longitude)<input id="nav-b" value="${DEMO[1]}" aria-label="Destination latitude, longitude"></label><button id="nav-demo">Use Toronto example</button></details>
      <details><summary>How this works</summary><p class="small muted">Learning stores examples of views paired with go, avoid or stop. Testing looks at each available street direction and chooses from those memories. It does not receive the planned list of stops. Memories live in this tab and disappear on reload.</p><p class="small muted">Google provides the photos. OpenStreetMap provides road shapes and simple one-way rules. This does not simulate traffic, lanes or traffic lights. The detailed body is female; the recorded brain is male. Movement is animated.</p><p class="small muted">Short trips only: 500 m between points, up to 12 route stops, ${LIMIT} image requests per learning session. Google usage may be billable.</p><div class="small muted">Visual error <span id="nav-error">—</span> · Match <span id="nav-confidence">—</span> · Requests <span id="nav-requests">0 / ${LIMIT}</span></div></details>`;
    this.q = s => el.querySelector(s);
    this.q('#nav-prepare').onclick = () => this.prepare();
    this.q('#nav-start').onclick = () => this.start();
    this.q('#nav-pause').onclick = () => this.pause();
    this.q('#nav-stop').onclick = () => this.stop();
    this.q('#nav-home').onclick = () => this.fit();
    this.q('#nav-export').onclick = () => this.export();
    this.q('#nav-forget').onclick = () => this.invalidate('Memories cleared. Learn a trip to build them again.');
    this.q('#nav-demo').onclick = () => { if (this.busy) return; this.q('#nav-a').value = DEMO[0]; this.q('#nav-b').value = DEMO[1]; this.invalidate(); this.drawPoints(); };
    for (const which of ['a', 'b']) {
      this.q(`#nav-pick-${which}`).onclick = () => { if (this.busy) return; this.pick = which; this.status(`Click a street on the map to choose ${which === 'a' ? 'the start' : 'the finish'}.`); this.q(`#nav-pick-${which}`).textContent = 'Click a street…'; };
      this.q(`#nav-${which}`).onchange = () => { this.invalidate(); this.drawPoints(); };
    }
    this.ownWorld(); this.drawPoints(); this.setState('idle');
  }
  get busy() { return ['preparing', 'placing', 'running', 'paused'].includes(this.state); }
  get active() { return true; }
  get motorSignals() { return this.busy ? this.motor : this.app.frame?.playing ? this.app.ema : {}; }
  async placeForManual() {
    this.epoch++; const epoch = this.epoch; this.abort?.abort(); this.abort = new AbortController();
    this.setState('placing'); this.status('Placing your fly on the start street…');
    try {
      const a = parsePoint(this.q('#nav-a').value);
      if (this.app.views.map.adapter.name !== 'Google Maps') throw new Error('Google Maps must be connected to use street movement.');
      const response = await fetch(`/api/roads?lat=${a.lat}&lng=${a.lng}`, { signal: this.abort.signal });
      const roads = await response.json(); if (!response.ok) throw new Error(typeof roads.detail === 'string' ? roads.detail : 'Choose a supported city street.');
      await this.checkpoint(epoch); this.streets = new StreetGraph(roads.elements); this.nodes = new Map(); this.nodeRequests = 0;
      const point = this.streets.snap(a, 60); if (!point) throw new Error('Choose a start point near a public city street.');
      const { StreetViewService } = await google.maps.importLibrary('streetView'); this.service = new StreetViewService();
      const node = await this.rawNode({ location: { lat: point.lat, lng: point.lng }, radius: 35, preference: 'nearest', sources: ['outdoor', 'google'] }, epoch);
      if (!node.road) throw new Error('The nearest photo is off the road. Choose another start.');
      await this.environmentNode(node.id, epoch); await this.checkpoint(epoch);
      this.place(node, node.heading); this.app.views.map.adapter.setCenter(node.road.lat, node.road.lng);
      this.setState('idle'); this.status('Manual street control ready. You can also Learn trip for an automatic memory test.');
    } catch (error) { if (epoch === this.epoch) { this.setState('error'); this.status(error.message); } throw error; }
  }
  mapClick(lat, lng) {
    if (!this.busy && this.pick) {
      const which = this.pick; this.pick = null;
      this.q(`#nav-${which}`).value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      this.invalidate(); this.drawPoints(false);
    }
    return true;
  }
  invalidate(message = 'Points selected. Learn this trip before trying it.') {
    if (this.busy) return;
    this.manual.halt(true); this.currentNode = null; this.streets = null;
    this.app.send({ cmd: 'clear' });
    this.epoch++; this.abort?.abort(); this.memory.clear(); this.route = []; this.recovery = null;
    this.trial = null; this.history = []; this.samples = []; this.motor = {}; this.pick = null;
    this.line?.setMap(null); this.app.views.eyes.setSource('off', true);
    this.q('#nav-memory').textContent = '0'; this.q('#nav-history').textContent = '';
    this.q('#nav-distance').textContent = '0 m'; this.q('#nav-progress').value = 0;
    this.q('#nav-error').textContent = '—'; this.q('#nav-confidence').textContent = '—';
    this.setState('idle'); this.status(message);
  }
  status(text) { this.q('#nav-status').textContent = text; }
  setState(state) {
    this.state = state;
    const labels = { idle: 'Ready', placing: 'Placing on street', preparing: 'Learning', ready: 'Learned', running: 'Exploring', paused: 'Paused', arrived: 'Made it!', stopped: 'Stopped', failed: 'Stopped safely', occluded: 'Eyes covered', untrained: 'No memory', error: 'Needs attention' };
    this.q('#nav-state').textContent = state === 'manual' ? 'Brain control' : labels[state] || state;
    this.q('#nav-state').dataset.state = state;
    this.q('#nav-prepare').disabled = this.busy;
    this.q('#nav-start').disabled = this.busy || this.route.length < 2 || !this.memory.size;
    this.q('#nav-pause').disabled = !['running', 'paused'].includes(state);
    this.q('#nav-pause').textContent = state === 'paused' ? 'Resume' : 'Pause';
    this.q('#nav-stop').disabled = !this.busy;
    this.q('#nav-export').disabled = !this.trial || this.busy;
    for (const id of ['a', 'b', 'condition', 'seed', 'pick-a', 'pick-b', 'forget', 'demo']) this.q(`#nav-${id}`).disabled = this.busy;
    for (const id of ['fix', 'hold', 'dark', 'light', 'rate', 'btn-clear', 'btn-reset']) { const input = document.getElementById(id); if (input) input.disabled = this.busy; }
    for (const which of ['a', 'b']) this.q(`#nav-pick-${which}`).textContent = which === 'a' ? 'Choose start on map' : 'Choose finish on map';
  }
  ownWorld() {
    this.manual.halt(true);
    this.owned = true; this.motor = {}; this.app.send({ cmd: 'clear' }); this.app.send(ZERO);
    this.app.views.eyes.setSource('off', true); this.app.views.map.frozen = true;
  }
  stop(reason = 'Stopped. Your learned memories are still here.') {
    this.manual.halt();
    this.epoch++; this.abort?.abort(); this.motor = {}; this.app.send(ZERO);
    this.app.views.eyes.holdNavigation?.();
    if (this.trial && ['running', 'paused'].includes(this.state)) this.finish('stopped', reason);
    else { this.route = []; this.memory.clear(); this.line?.setMap(null); this.q('#nav-memory').textContent = '0'; this.setState('stopped'); this.status('Learning stopped. Press Learn trip to start a new lesson.'); }
  }
  pause() {
    if (this.state === 'running') { this.pauseAt = performance.now(); this.motor = {}; this.app.send({ cmd: 'pause' }); this.setState('paused'); this.status('Paused. Press Resume to continue.'); }
    else if (this.state === 'paused') { this.pausedMs += performance.now() - this.pauseAt; this.app.send({ cmd: 'play' }); this.setState('running'); this.status('Resuming the trip…'); }
  }
  async checkpoint(epoch) {
    while (this.state === 'paused' && epoch === this.epoch) await delay(80);
    if (epoch !== this.epoch) throw new DOMException('Cancelled', 'AbortError');
    if (this.state === 'running' && performance.now() - this.started - this.pausedMs > 300000) throw new Error('This attempt took five minutes. Try a shorter trip.');
  }
  async rawNode(request, epoch) {
    if (request.pano && this.nodes.has(request.pano)) return this.nodes.get(request.pano);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.checkpoint(epoch);
      if (++this.nodeRequests > 180) throw new Error('This trip needs too much map searching. Pick closer street points.');
      try {
        let timer;
        const result = await Promise.race([this.service.getPanorama(request), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Street View took too long to reply. Try again.')), 12000); })]).finally(() => clearTimeout(timer));
        await this.checkpoint(epoch);
        const d = result.data, p = d.location;
        if (!p?.pano || !p.latLng) throw new Error('No Street View coverage here. Choose another street.');
        const node = { id: p.pano, lat: p.latLng.lat(), lng: p.latLng.lng(), copyright: d.copyright || '', date: d.imageDate || '', heading: d.tiles?.centerHeading || 0,
          rawLinks: (d.links || []).filter(l => l.pano && Number.isFinite(l.heading)).map(l => ({ id: l.pano, heading: l.heading })) };
        node.road = this.streets.snap(node, 18, node.heading); this.nodes.set(node.id, node); return node;
      } catch (error) {
        if (epoch !== this.epoch) throw error;
        if (attempt === 2 || !String(error.message).includes('UNKNOWN_ERROR')) throw error;
        this.status('Google is taking a moment. Retrying…'); await delay(500 * (attempt + 1));
      }
    }
  }
  async environmentNode(id, epoch) {
    const node = await this.rawNode({ pano: id }, epoch);
    if (node.links) return node;
    const links = [];
    if (node.road) for (const link of node.rawLinks) {
      let next;
      try { next = await this.rawNode({ pano: link.id }, epoch); }
      catch (error) { if (String(error.message).includes('ZERO_RESULTS')) continue; throw error; }
      const path = this.streets.transition(node, next);
      if (path) links.push({ ...link, path });
    }
    await this.checkpoint(epoch); node.links = links; return node;
  }
  async image(node, heading, epoch) {
    await this.checkpoint(epoch);
    if (this.imageRequests >= LIMIT) throw new Error('Image allowance reached. Learn a shorter trip to begin a new session.');
    this.q('#nav-requests').textContent = `${++this.imageRequests} / ${LIMIT}`;
    const params = new URLSearchParams({ pano: node.id, lat: node.lat, lng: node.lng, heading: (heading % 360 + 360) % 360, pitch: 0, fov: 120, size: '480x240' });
    const response = await fetch(`/api/streetview?${params}`, { signal: this.abort.signal });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.detail || 'Street View photo unavailable. Try again.'); }
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 240;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0, 480, 240); bitmap.close();
    await this.checkpoint(epoch); return { canvas, descriptor: describeImage(ctx.getImageData(0, 0, 480, 240)) };
  }
  views(node) { return node.links.length ? node.links : [{ id: null, heading: node.heading }]; }
  async teach(node, chosenId, epoch, label) {
    this.place(node, node.heading);
    for (const view of this.views(node)) {
      await this.checkpoint(epoch); this.status(label);
      this.app.views.map.w.heading = view.heading;
      const image = await this.image(node, view.heading, epoch);
      this.app.views.eyes.showNavigation(image.canvas, false, node.copyright);
      this.memory.learn(image.descriptor, chosenId === null ? 'stop' : view.id === chosenId ? 'go' : 'avoid');
      this.q('#nav-memory').textContent = this.memory.size;
      await delay(160);
    }
  }
  async prepare() {
    if (this.busy) return;
    this.currentNode = null;
    this.epoch++; const epoch = this.epoch; this.abort?.abort(); this.abort = new AbortController();
    this.route = []; this.trial = null; this.memory.clear(); this.history = []; this.samples = []; this.recovery = null; this.pick = null;
    this.nodes = new Map(); this.imageRequests = 0; this.nodeRequests = 0; this.line?.setMap(null);
    this.q('#nav-memory').textContent = '0'; this.q('#nav-history').textContent = '';
    this.q('#nav-distance').textContent = '0 m'; this.q('#nav-progress').value = 0;
    this.q('#nav-error').textContent = '—'; this.q('#nav-confidence').textContent = '—';
    this.setState('preparing'); this.ownWorld();
    try {
      if (this.app.views.map.adapter.name !== 'Google Maps' || this.app.views.map.adapter.authFailed) throw new Error('Google Maps is unavailable. Check the API key and reload.');
      const a = parsePoint(this.q('#nav-a').value), b = parsePoint(this.q('#nav-b').value);
      if ([a, b].some(p => Math.abs(p.lat) > 80 || Math.abs(p.lng) > 179.9)) throw new Error('Choose a city below 80° latitude and away from the date line.');
      if (distance(a, b) > 500) throw new Error('Start with a short trip: choose points less than 500 m apart.');
      this.status('Finding city streets…');
      const response = await fetch(`/api/roads?lat=${(a.lat + b.lat) / 2}&lng=${(a.lng + b.lng) / 2}`, { signal: this.abort.signal });
      const roads = await response.json(); if (!response.ok) throw new Error(roads.detail || 'Street map unavailable.');
      await this.checkpoint(epoch); this.streets = new StreetGraph(roads.elements);
      const roadA = this.streets.snap(a, 60), roadB = this.streets.snap(b, 60);
      if (!roadA || !roadB) throw new Error('Choose both points on public city streets, not inside a park or building.');
      const { StreetViewService } = await google.maps.importLibrary('streetView'); this.service = new StreetViewService();
      this.status('Finding street-level photos…');
      const request = p => ({ location: { lat: p.lat, lng: p.lng }, radius: 35, preference: 'nearest', sources: ['outdoor', 'google'] });
      const start = await this.rawNode(request(roadA), epoch), goal = await this.rawNode(request(roadB), epoch);
      if (!start.road || !goal.road) throw new Error('The nearest photos are off the road. Move the points along the street and try again.');
      if (start.id === goal.id) throw new Error('Those points share the same photo. Put the finish a little farther away.');
      this.requested = { a, b }; this.snap = { a: distance(a, start.road), b: distance(b, goal.road) };
      await this.environmentNode(start.id, epoch); await this.environmentNode(goal.id, epoch);
      const route = await planRoute(start, goal, id => this.environmentNode(id, epoch), { maxNodes: 100, signal: this.abort.signal,
        progress: () => this.status(`Finding a connected street trip… ${this.nodeRequests} photos checked.`) });
      if (route.length > 12) throw new Error('That trip has too many stops for a first lesson. Choose a shorter trip.');
      await this.checkpoint(epoch); this.route = route; this.drawRoute();
      for (let i = 0; i < route.length; i++) {
        await this.teach(route[i], route[i + 1]?.id ?? null, epoch, `Learning view ${i + 1} of ${route.length}…`);
        this.q('#nav-progress').value = (i + 1) / route.length;
      }
      // One optional, real neighbouring wrong turn with a legal way back.
      // It is demonstrated explicitly; recovery is not claimed for unseen roads.
      for (const node of route.slice(0, -1)) {
        if (this.recovery) break;
        for (const link of node.links) {
          if (route.some(n => n.id === link.id)) continue;
          const side = await this.environmentNode(link.id, epoch);
          if (!side.links.some(l => l.id === node.id)) continue;
          await this.teach(side, node.id, epoch, 'Learning how to return from one wrong turn…');
          this.recovery = side; break;
        }
      }
      await this.checkpoint(epoch); this.place(start, start.links.find(l => l.id === route[1].id).heading);
      this.setState('ready'); this.q('#nav-progress').value = 0;
      this.status(`Trip learned: ${Math.round(this.routeLength())} m, ${this.memory.size} visual memories. Now try it from memory.`);
      this.q('#nav-points').textContent = `${start.road.segment.name} → ${goal.road.segment.name}. Points moved ${this.snap.a.toFixed(0)} / ${this.snap.b.toFixed(0)} m to street coverage.`;
    } catch (error) {
      if (epoch === this.epoch) {
        console.warn('Street trip preparation: ' + JSON.stringify({ error: error.message, first: [...(this.nodes?.values() || [])].slice(0, 4).map(n => ({ id: n.id, lat: n.lat, lng: n.lng, date: n.date, roadGap: n.road?.gap, links: n.links?.map(l => l.id) })), closest: this.requested ? [...this.nodes.values()].sort((a,b) => distance(a,this.requested.b)-distance(b,this.requested.b)).slice(0,5).map(n => ({id:n.id,lat:n.lat,lng:n.lng,date:n.date,roadGap:n.road?.gap,exits:n.links?.length})) : [] }));
        this.route = []; this.memory.clear(); this.line?.setMap(null); this.app.views.eyes.holdNavigation?.(); this.q('#nav-memory').textContent = '0'; this.setState('error'); this.status(error.message || String(error));
      }
    }
  }
  routeLength() { return this.route.slice(1).reduce((sum, n, i) => sum + pathLength(this.route[i].links.find(l => l.id === n.id).path), 0); }
  place(node, heading) {
    this.currentNode = node;
    const map = this.app.views.map, p = node.road || node;
    map.snapTo(p.lat, p.lng); map.w.heading = heading; map.w.speed = 0;
  }
  async expose(epoch) {
    const start = this.app.simT, wall = performance.now(), paused = this.pausedMs;
    while (this.app.simT - start < 100) {
      await this.checkpoint(epoch);
      if (performance.now() - wall - (this.pausedMs - paused) > 15000) throw new Error('The brain connection stopped responding. Please try again.');
      await delay(50);
    }
    await this.checkpoint(epoch);
  }
  async travel(link, epoch) {
    const meters = pathLength(link.path); let moved = 0;
    if (this.trial) this.trial.partialTransition = { to: link.id, meters: 0 };
    while (moved < meters) {
      await this.checkpoint(epoch); this.motor = { walk: 20 };
      const before = performance.now(); await delay(50);
      await this.checkpoint(epoch);
      // Bound each frame: a background tab or a pause must never jump the fly.
      const step = Math.min(.1, (performance.now() - before) / 1000) * 8;
      const advance = Math.min(meters - moved, step); moved += advance; this.travelled += advance;
      if (this.trial) this.trial.partialTransition.meters = moved;
      const p = pointAlong(link.path, moved); this.app.views.map.snapTo(p.lat, p.lng); this.app.views.map.w.heading = p.heading;
      this.q('#nav-distance').textContent = `${Math.round(this.travelled)} m`;
    }
    if (this.trial) delete this.trial.partialTransition;
    this.motor = {};
  }
  async start() {
    if (this.busy || this.route.length < 2 || !this.memory.size) return;
    if (this.app.ws?.readyState !== 1) { this.status('Connecting to the brain… please try again in a moment.'); return; }
    const condition = this.q('#nav-condition').value, seed = Number(this.q('#nav-seed').value);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) { this.status('Use a whole trial number between 0 and 4294967295.'); return; }
    if (condition === 'recovery' && !this.recovery) { this.status('This short trip has no learned side street with a legal return. Choose a trip near a junction.'); return; }
    this.epoch++; const epoch = this.epoch; this.abort = new AbortController(); this.ownWorld();
    this.condition = condition; this.samples = []; this.travelled = 0; this.started = performance.now(); this.pausedMs = 0;
    this.q('#nav-distance').textContent = '0 m'; this.q('#nav-progress').value = 0;
    this.q('#nav-error').textContent = '—'; this.q('#nav-confidence').textContent = '—';
    const random = seededRandom(seed), learner = condition === 'empty' ? new VisualMemory() : this.memory;
    let current = condition === 'recovery' ? this.recovery : this.route[0];
    this.trial = { schema: 2, protocol: 'visual-episodic-imitation-v2', controller: 'visual memory; biological connectome observed, not trained',
      seed, condition, startedAt: new Date().toISOString(), learnedExamples: learner.size, requested: this.requested,
      roadRules: 'OSM public roads, simple oneway/access; no lane/signal/turn-restriction simulation',
      samples: this.samples, transitions: [], startPano: current.id, goalPano: this.route.at(-1).id };
    const serial = this.app.resetSerial || 0;
    this.app.send({ cmd: 'reset' }); this.app.send({ cmd: 'play' }); this.setState('running');
    this.place(current, current.heading);
    try {
      while ((this.app.resetSerial || 0) === serial) { await this.checkpoint(epoch); if (performance.now() - this.started > 15000) throw new Error('Brain reset was not acknowledged.'); await delay(50); }
      const visits = new Map();
      for (let step = 0; step < 36; step++) {
        await this.checkpoint(epoch);
        visits.set(current.id, (visits.get(current.id) || 0) + 1);
        if (visits.get(current.id) > 3) throw new Error('I am going in circles. I have stopped; this trip needs a better lesson.');
        current = await this.environmentNode(current.id, epoch);
        // Environment offers local physical directions only. Shuffle their order
        // so selecting the first available link cannot masquerade as learning.
        const views = [...this.views(current)];
        for (let i = views.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [views[i], views[j]] = [views[j], views[i]]; }
        const observations = [], headings = [];
        for (let i = 0; i < views.length; i++) {
          const heading = views[i].heading + (random() < .5 ? -1 : 1) * (10 + random() * 10);
          headings.push(heading); this.app.views.map.w.heading = heading;
          this.status(`Looking around… checking direction ${i + 1} of ${views.length}.`);
          const image = await this.image(current, heading, epoch); await this.checkpoint(epoch);
          this.app.views.eyes.showNavigation(image.canvas, condition === 'blank', current.copyright); await this.expose(epoch);
          observations.push(condition === 'blank' ? new Float32Array(819) : image.descriptor);
        }
        const choice = learner.choose(observations);
        this.samples.push({ step, simMs: this.app.simT, elapsedMs: Math.round(performance.now() - this.started - this.pausedMs), ...choice, rates: { ...this.app.ema } });
        if (choice.action === 'unknown') {
          const evidence = observations.map(o => learner.rank(o).slice(0, 2));
          this.samples.at(-1).recognition = evidence;
          console.info('Visual decision stopped: ' + JSON.stringify(evidence));
          this.finish(condition === 'blank' ? 'occluded' : condition === 'empty' ? 'untrained' : 'failed', condition === 'blank' ? 'Covered eyes: I cannot see, so I stayed still.' : condition === 'empty' ? 'Without my memories, I do not know which way to go. I stayed still.' : choice.reason); return;
        }
        this.q('#nav-confidence').textContent = `${Math.round(choice.correlation * 100)}%`;
        if (choice.action === 'stop') {
          // Destination identity is used only by the experiment scorer, AFTER
          // the vision-only learner independently decides to stop.
          this.finish(current.id === this.trial.goalPano ? 'arrived' : 'failed', current.id === this.trial.goalPano ? `I recognized the finish! Travelled ${Math.round(this.travelled)} m using my learned views.` : 'I thought this was the finish, but it was not. The test did not pass.'); return;
        }
        const link = views[choice.candidate]; if (!link.id || !link.path) throw new Error('There is no connected street in that direction.');
        let heading = headings[choice.candidate], match = choice, stable = 0;
        for (let attempt = 0; stable < 2; attempt++) {
          if (attempt > 6) throw new Error('I could not line up with the remembered view. I stopped.');
          await this.checkpoint(epoch);
          heading -= match.errorDeg; this.app.views.map.w.heading = heading;
          this.status('I remember this direction. Turning to face it…');
          const image = await this.image(current, heading, epoch); await this.checkpoint(epoch);
          this.app.views.eyes.showNavigation(image.canvas, false, current.copyright); await this.expose(epoch);
          match = matchMemory(learner.examples[choice.memory].signature, image.descriptor);
          if (!match.valid) throw new Error('The view became unclear while turning. I stopped.');
          this.q('#nav-error').textContent = `${Math.round(match.errorDeg)}°`;
          stable = Math.abs(match.errorDeg) <= 3 ? stable + 1 : 0;
        }
        this.status(`Following ${current.road.segment.name}…`);
        await this.travel(link, epoch); await this.checkpoint(epoch);
        this.trial.transitions.push({ from: current.id, to: link.id, meters: pathLength(link.path) });
        current = await this.environmentNode(link.id, epoch); this.place(current, heading);
        this.q('#nav-progress').value = Math.min(.95, this.travelled / this.routeLength());
      }
      throw new Error('Too many steps without finding the finish. I stopped.');
    } catch (error) { if (epoch === this.epoch) this.finish('failed', error.message || String(error)); }
  }
  finish(outcome, reason) {
    this.motor = {}; this.app.views.map.w.speed = 0; this.app.send(ZERO);
    // Keep the last photo visible but stop stale retinal stimulation.
    this.app.views.eyes.holdNavigation?.();
    if (this.trial) {
      Object.assign(this.trial, { outcome, reason, durationMs: Math.round(performance.now() - this.started - this.pausedMs - (this.state === 'paused' ? performance.now() - this.pauseAt : 0)), travelledMeters: this.travelled, imageRequests: this.imageRequests, metadataRequests: this.nodeRequests });
      this.history.push({ condition: this.condition, outcome, meters: Math.round(this.travelled) });
      this.q('#nav-history').textContent = this.history.map(t => `${({ intact: 'With memory', empty: 'No memory', blank: 'Eyes covered', recovery: 'Wrong turn' })[t.condition]}: ${t.outcome}, ${t.meters} m`).join('\n');
    }
    if (outcome === 'arrived') this.q('#nav-progress').value = 1;
    this.setState(outcome); this.status(reason);
  }
  export() {
    if (!this.trial) return;
    const blob = new Blob([JSON.stringify({ ...this.trial, comparisons: this.history }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `fly-trip-${Date.now()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  clearMarkers() { this.markers.forEach(m => m.setMap(null)); this.markers = []; }
  drawPoints(fit = true) {
    if (this.app.views.map.adapter.name !== 'Google Maps') return;
    try {
      const points = [parsePoint(this.q('#nav-a').value), parsePoint(this.q('#nav-b').value)]; this.clearMarkers();
      points.forEach((position, i) => this.markers.push(new google.maps.Marker({ position, label: i ? 'B' : 'A', map: this.app.views.map.adapter.map })));
      this.q('#nav-points').textContent = 'Points selected. Both should be on nearby city streets.';
      if (fit) this.fit();
    } catch (error) { this.status(error.message); }
  }
  fit() {
    const adapter = this.app.views.map.adapter; if (adapter.name !== 'Google Maps') return;
    const bounds = new google.maps.LatLngBounds();
    if (this.route.length) this.route.forEach(n => bounds.extend({ lat: n.road.lat, lng: n.road.lng }));
    else { try { bounds.extend(parsePoint(this.q('#nav-a').value)); bounds.extend(parsePoint(this.q('#nav-b').value)); } catch { return; } }
    adapter.map.fitBounds(bounds, 65);
  }
  drawRoute() {
    const map = this.app.views.map.adapter.map; this.clearMarkers(); this.line?.setMap(null);
    const path = this.route.slice(1).flatMap((node, i) => this.route[i].links.find(l => l.id === node.id).path.map(p => ({ lat: p.lat, lng: p.lng })));
    this.line = new google.maps.Polyline({ path, map, strokeColor: '#7bdac7', strokeWeight: 5, strokeOpacity: .8 });
    [this.route[0], this.route.at(-1)].forEach((node, i) => this.markers.push(new google.maps.Marker({ position: { lat: node.road.lat, lng: node.road.lng }, label: i ? 'B' : 'A', map })));
    this.fit();
  }
}

