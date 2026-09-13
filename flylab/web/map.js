import * as THREE from 'three';
import { createFly } from './fly.js';
import { createAnatomicalFly } from './anatomy.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;
const START = { lat: 43.6532, lng: -79.3832 };   // Toronto

export function metersBetween(a, b) {
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * M_PER_DEG_LAT * Math.cos(a.lat * DEG);
  return Math.hypot(dx, dy);
}
export function offset(p, headingDeg, meters) {
  const a = headingDeg * DEG;
  return { lat: p.lat + (Math.cos(a) * meters) / M_PER_DEG_LAT, lng: p.lng + (Math.sin(a) * meters) / (M_PER_DEG_LAT * Math.cos(p.lat * DEG)) };
}
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
function loadCss(href) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }

class GoogleAdapter {
  constructor(key, mapId) { this.key = key; this.mapId = mapId; this.name = 'Google Maps'; }
  async init(el, center, zoom) {
    if (!window.google || !google.maps) {
      await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('Google Maps loading timed out')), 15000);
        window.__gmReady = () => { clearTimeout(timer); res(); }; window.gm_authFailure = () => { clearTimeout(timer); this.authFailed = true; this.onAuthFailure?.(); rej(new Error('Google Maps rejected the API key or API configuration')); };
        loadScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(this.key)}&v=weekly&libraries=places&loading=async&callback=__gmReady`).catch(rej);
      });
    }
    this.map = new google.maps.Map(el, { center, zoom, disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: false, ...(this.mapId ? { mapId: this.mapId } : {}) });
    this.ov = new google.maps.OverlayView(); this.ov.onAdd = () => {}; this.ov.draw = () => {}; this.ov.onRemove = () => {}; this.ov.setMap(this.map);
  }
  project(lat, lng) { const p = this.ov && this.ov.getProjection(); if (!p) return null; const pt = p.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng)); return pt ? { x: pt.x, y: pt.y } : null; }
  onClick(cb) { this.map.addListener('click', (e) => cb(e.latLng.lat(), e.latLng.lng())); }
  setCenter(lat, lng) { this.map.setCenter({ lat, lng }); }
  getCenter() { const c = this.map.getCenter(); return { lat: c.lat(), lng: c.lng() }; }
  getBounds() { const b = this.map.getBounds(); if (!b) return null; const ne = b.getNorthEast(), sw = b.getSouthWest(); return { n: ne.lat(), e: ne.lng(), s: sw.lat(), w: sw.lng() }; }
  invalidate() {}
  async nearbyFood(center, radius) {
    const { Place } = await google.maps.importLibrary('places');
    const { places } = await Place.searchNearby({ fields: ['location', 'displayName'], locationRestriction: { center, radius }, includedPrimaryTypes: ['restaurant', 'cafe', 'bakery', 'ice_cream_shop', 'fast_food_restaurant'], maxResultCount: 15 });
    return places.map((p) => ({ lat: p.location.lat(), lng: p.location.lng(), name: p.displayName }));
  }
}

class LeafletAdapter {
  constructor() { this.name = 'OpenStreetMap'; }
  async init(el, center, zoom) {
    if (!window.L) { loadCss('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'); await loadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'); }
    this.map = L.map(el, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lng], zoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(this.map);
  }
  project(lat, lng) { const p = this.map.latLngToContainerPoint([lat, lng]); return { x: p.x, y: p.y }; }
  onClick(cb) { this.map.on('click', (e) => cb(e.latlng.lat, e.latlng.lng)); }
  setCenter(lat, lng) { this.map.setView([lat, lng], this.map.getZoom(), { animate: false }); }
  getCenter() { const c = this.map.getCenter(); return { lat: c.lat, lng: c.lng }; }
  getBounds() { const b = this.map.getBounds(); return { n: b.getNorth(), e: b.getEast(), s: b.getSouth(), w: b.getWest() }; }
  invalidate() { this.map.invalidateSize(); }
  async nearbyFood() { throw new Error('needs a Google Maps key (Places)'); }
}

export class MapView {
  constructor(app) {
    this.app = app; this.ready = false;
    this.w = { ...START, heading: 20, speed: 0, mode: 'idle', hunger: 0.75 };
    this.foods = []; this.follow = true; this.cursor = null; this.loomSense = 0; this.sugarSense = 0; this.odor = [0, 0];
    this.swatT = 0; this.jumpT = 0; this.jumpCd = 0; this.flightT = 0; this.lastSense = 0; this.wander = { L: 0, R: 0, t: 0 }; this.eating = false; this.t = 0;
    this.brainDrives = false; this.frozen = false;
  }
  async mount(el) {
    this.el = el;
    el.innerHTML = `<div class="map" id="map"></div><div class="map-overlays" id="map-overlays"></div>
      <button id="hud-toggle" class="map-tools small">Free exploration controls</button>
      <div class="map-hud">
        <div class="hud-row"><span class="mode" id="hud-mode">idle</span><span class="mono muted" id="hud-speed">0 m/s</span><span class="muted small" id="hud-backend" style="margin-left:auto"></span></div>
        <div class="hud-row"><label>hunger</label><div class="bar"><i id="hud-hunger" style="width:75%"></i></div></div>
        <div class="hud-row"><button class="small" id="hud-scatter">🍓 scatter food</button><button class="small" id="hud-find">📍 food nearby</button><button class="small primary" id="hud-swat">🖐 swat</button></div>
        <div class="hud-row"><label class="toggle small"><input type="checkbox" id="hud-follow" checked>follow</label><label class="toggle small"><input type="checkbox" id="hud-drive" checked>map senses</label><button class="small" id="hud-locate">⌖ me</button></div>
        <div class="hud-row"><input type="text" id="hud-goto" placeholder="lat, lng"><button class="small" id="hud-go">go</button></div>
        <div class="senses" id="hud-senses"></div>
        <div class="muted small">click the map to drop food · sweep the cursor at the fly to make it loom · giant fly: walks 4 m/s, flies 20 m/s</div>
      </div>`;
    this.mapEl = el.querySelector('#map'); this.overlays = el.querySelector('#map-overlays');
    const key = this.app.cfg.google_maps_api_key;
    this.adapter = key ? new GoogleAdapter(key, this.app.cfg.google_map_id) : new LeafletAdapter();
    try { await this.adapter.init(this.mapEl, START, 18); }
    catch (e) {
      this.app.toast('Google Maps failed (' + e.message + '); using OpenStreetMap', 6000);
      this.mapEl.innerHTML = ''; this.adapter = new LeafletAdapter(); await this.adapter.init(this.mapEl, START, 18);
    }
    this.adapter.onClick((lat, lng) => { if (!this.app.navigation?.mapClick(lat, lng)) this.addFood(lat, lng); });
    this.mapEl.addEventListener('mousemove', (e) => { const r = this.mapEl.getBoundingClientRect(); this.cursor = { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() }; });
    this.flyEl = document.createElement('div'); this.flyEl.className = 'fly-overlay'; this.overlays.appendChild(this.flyEl);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); this.renderer.setSize(120, 120);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.flyEl.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50); this.camera.position.set(0, 7.5, 5.5); this.camera.lookAt(0, 0.6, 0);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 1.2));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.5); sun.position.set(3, 8, 4); this.scene.add(sun);
    try { this.fly = await createAnatomicalFly(); } catch { this.fly = createFly(); }
    this.scene.add(this.fly.group);
    this.wireHud();
    this.el.querySelector('#hud-drive').checked = false;
    this.ready = true;
    if (this.adapter instanceof GoogleAdapter) {
      this.adapter.onAuthFailure = () => this.fallbackMap();
      if (this.adapter.authFailed) await this.fallbackMap();
    }
  }
  async fallbackMap() {
    if (this.fallbackPending || this.adapter instanceof LeafletAdapter) return;
    this.fallbackPending = true; this.ready = false;
    if (this.app.navigation?.busy) this.app.navigation.stop('Google Maps authorization was lost.');
    try {
      this.adapter.ov?.setMap(null); this.mapEl.innerHTML = '';
      const adapter = new LeafletAdapter(); await adapter.init(this.mapEl, this.w, 18); this.adapter = adapter;
      adapter.onClick((lat, lng) => { if (!this.app.navigation?.mapClick(lat, lng)) this.addFood(lat, lng); });
      this.el.querySelector('#hud-backend').textContent = 'OpenStreetMap · Google unavailable';
      this.app.navigation?.invalidate();
      this.app.navigation?.status('Google Maps JavaScript API is not activated or authorized. Enable it and Street View Static API, then reload. Map preview uses OpenStreetMap.');
      this.app.toast('Google Maps API is unavailable; map preview uses OpenStreetMap.', 6000);
    } catch (error) { this.app.toast('Map preview failed: ' + error.message, 6000); }
    finally { this.ready = true; this.fallbackPending = false; }
  }
  resize() { if (this.adapter) this.adapter.invalidate(); }
  wireHud() {
    const q = (s) => this.el.querySelector(s);
    q('#hud-toggle').onclick = () => { this.showHud = !this.showHud; };
    q('#hud-backend').textContent = this.adapter.name;
    q('#hud-scatter').onclick = () => this.scatter(6);
    q('#hud-swat').onclick = () => { this.swatT = 0.4; };
    q('#hud-follow').onchange = (e) => (this.follow = e.target.checked);
    q('#hud-drive').onchange = (e) => { this.brainDrives = e.target.checked; if (!this.brainDrives) this.app.send({ cmd: 'senses', odor_L: 0, odor_R: 0, sugar: 0, loom: 0, hunger: 0, wander_L: 0, wander_R: 0 }); };
    q('#hud-find').onclick = async () => {
      try { const spots = await this.adapter.nearbyFood(this.adapter.getCenter(), 250); spots.forEach((s) => this.addFood(s.lat, s.lng, s.name)); this.app.toast(`${spots.length} places found`); }
      catch (e) { this.app.toast('food nearby: ' + e.message, 5000); }
    };
    q('#hud-locate').onclick = () => navigator.geolocation && navigator.geolocation.getCurrentPosition((p) => this.teleport(p.coords.latitude, p.coords.longitude), () => this.app.toast('location unavailable'));
    q('#hud-go').onclick = () => { const m = q('#hud-goto').value.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/); if (m) this.teleport(+m[1], +m[2]); };
  }
  teleport(lat, lng) { if (this.app.navigation?.active) { this.app.toast('Leave the route experiment before moving the release point.'); return; } this.w.lat = lat; this.w.lng = lng; this.adapter.setCenter(lat, lng); this.foods.forEach((f) => f.el.remove()); this.foods = []; this.scatter(5); this.onTeleport && this.onTeleport(); }
  snapTo(lat, lng) { this.w.lat = lat; this.w.lng = lng; }
  addFood(lat, lng, name) {
    const el = document.createElement('div'); el.className = 'food'; el.textContent = '🍓';
    if (name) { const s = document.createElement('span'); s.textContent = name; el.appendChild(s); }
    this.overlays.appendChild(el); this.foods.push({ lat, lng, amount: 1, el });
  }
  scatter(k) {
    const b = this.adapter.getBounds(); if (!b) return;
    for (let i = 0; i < k; i++) this.addFood(b.s + Math.random() * (b.n - b.s), b.w + Math.random() * (b.e - b.w));
  }
  odorAt(p) { let c = 0; for (const f of this.foods) c += f.amount * Math.exp(-metersBetween(p, f) / 45); return c / (c + 1.0); }

  render(dt) {
    if (!this.ready) return;
    this.t += dt;
    const nav = this.app.navigation;
    this.el.querySelector('.map-hud').hidden = !!nav?.active || !this.showHud;
    this.el.querySelector('#hud-toggle').hidden = !!nav?.active;
    if (nav?.active) {
      const w = this.w, p = this.adapter.project(w.lat, w.lng);
      if (p) this.flyEl.style.transform = `translate(${p.x - 60}px, ${p.y - 60}px)`;
      this.fly.group.rotation.y = -w.heading * DEG;
      this.fly.update(dt, nav.motor, this.t); this.renderer.render(this.scene, this.camera);
      return;
    }
    const m = this.app.ema, w = this.w;
    // --- motor neurons -> movement
    const wing = m.wing_mn || 0;
    this.jumpCd -= dt;
    if ((m.giant_fiber || 0) > 60 && this.jumpCd <= 0) { this.jumpT = 0.35; this.jumpCd = 1.5; if (wing > 25) this.flightT = 4; }
    if (this.flightT > 0) this.flightT = wing > 25 ? this.flightT - dt : 0;   // takeoff needs the escape jump
    const flying = this.flightT > 0;
    const fwd = clamp((m.walk || 0) / 30, 0, 1) + clamp((m.leg_mn || 0) / 40, 0, 0.6);
    let speed = 0, mode = 'idle';
    if (this.jumpT > 0) { speed = 28; mode = 'jumping'; this.jumpT -= dt; }
    else if (flying) { speed = 20 * (0.5 + fwd); mode = 'flying'; }
    else if (fwd > 0.05) { speed = 4 * fwd; mode = 'walking'; }
    if ((m.backward || 0) > 5 && !flying && this.jumpT <= 0) { speed = -2.5; mode = 'backing up'; }
    if ((m.groom || 0) > 4 && Math.abs(speed) < 0.1) mode = 'grooming';
    if (mode === 'idle' && wing > 25) mode = 'wings buzzing';
    if (this.eating) mode = 'eating';
    const turn = ((m.steer_R || 0) - (m.steer_L || 0)) * 2.5;
    const paused = !this.app.frame?.playing || this.app.ws?.readyState !== 1;
    if (!paused) w.heading += turn * dt;
    if (!paused && (mode === 'walking' || mode === 'flying')) w.heading += (Math.random() - 0.5) * 30 * dt;
    if (!this.frozen && !paused) { const np = offset(w, w.heading, speed * dt); w.lat = np.lat; w.lng = np.lng; }
    if (paused) { speed = 0; mode = 'paused'; }
    w.speed = speed; w.mode = mode;
    // --- world -> senses
    w.hunger = clamp(w.hunger + 0.012 * dt, 0, 1);
    let near = null, nearD = 1e9;
    for (const f of this.foods) { const d = metersBetween(w, f); if (d < nearD) { near = f; nearD = d; } }
    this.eating = false; this.sugarSense = 0;
    if (near && nearD < 7) {
      this.sugarSense = 1;
      if ((m.MN9 || 0) > 1.5) { near.amount -= 0.3 * dt; w.hunger = clamp(w.hunger - 0.25 * dt, 0, 1); this.eating = true; }
      if (near.amount <= 0) { near.el.remove(); this.foods.splice(this.foods.indexOf(near), 1); }
    }
    this.odor = [this.odorAt(offset(w, w.heading - 60, 12)), this.odorAt(offset(w, w.heading + 60, 12))];
    let loom = 0; this.swatT -= dt; if (this.swatT > 0) loom = 1;
    const fp = this.adapter.project(w.lat, w.lng);
    if (this.cursor && fp && performance.now() - this.cursor.t < 300) {
      const d = Math.hypot(this.cursor.x - fp.x, this.cursor.y - fp.y);
      const approach = this.prevD === undefined ? 0 : (this.prevD - d) / Math.max(dt, 1e-3);
      this.prevD = d;
      if (d < 200 && approach > 120) loom = Math.max(loom, clamp((approach - 120) / 700, 0, 1));
    } else this.prevD = undefined;
    this.loomSense = Math.max(loom, this.loomSense * Math.exp(-dt * 6));
    // --- senses to the brain at 10 Hz
    const now = performance.now();
    if (this.brainDrives && now - this.lastSense > 100) {
      this.lastSense = now;
      if (now - this.wander.t > 700) this.wander = { L: Math.random() < 0.5 ? Math.random() * 0.5 : 0, R: Math.random() < 0.5 ? Math.random() * 0.5 : 0, t: now };
      const hungerDrive = this.eating ? 0 : w.hunger;
      this.app.send({ cmd: 'senses', odor_L: this.odor[0], odor_R: this.odor[1], sugar: this.sugarSense, loom: this.loomSense, hunger: hungerDrive, wander_L: hungerDrive * this.wander.L, wander_R: hungerDrive * this.wander.R });
    }
    // --- draw
    if (this.follow && (mode !== 'idle' || Math.random() < 0.02)) this.adapter.setCenter(w.lat, w.lng);
    const p = this.adapter.project(w.lat, w.lng);
    if (p) {
      const hop = this.jumpT > 0 ? Math.sin((0.35 - this.jumpT) / 0.35 * Math.PI) * 30 : 0;
      this.flyEl.style.transform = `translate(${p.x - 60}px, ${p.y - 60 - hop}px) scale(${flying ? 1.25 : 1})`;
    }
    for (const f of this.foods) { const q = this.adapter.project(f.lat, f.lng); if (q) { f.el.style.left = q.x + 'px'; f.el.style.top = q.y + 'px'; f.el.style.fontSize = 12 + 18 * clamp(f.amount, 0, 1) + 'px'; } }
    this.fly.group.rotation.y = -w.heading * DEG;
    this.fly.update(dt, m, this.t);
    this.renderer.render(this.scene, this.camera);
    const q = (s) => this.el.querySelector(s);
    q('#hud-mode').textContent = mode; q('#hud-speed').textContent = Math.abs(speed).toFixed(1) + ' m/s';
    q('#hud-hunger').style.width = w.hunger * 100 + '%';
    q('#hud-senses').innerHTML = `<div>odor L <b>${this.odor[0].toFixed(2)}</b></div><div>odor R <b>${this.odor[1].toFixed(2)}</b></div><div>sugar <b>${this.sugarSense}</b></div><div>loom <b>${this.loomSense.toFixed(2)}</b></div>` +
      `<div>steer L <b>${Math.round(m.steer_L || 0)}</b></div><div>steer R <b>${Math.round(m.steer_R || 0)}</b></div><div>walk <b>${Math.round(m.walk || 0)}</b></div><div>MN9 <b>${(m.MN9 || 0).toFixed(1)}</b></div>`;
  }
}
