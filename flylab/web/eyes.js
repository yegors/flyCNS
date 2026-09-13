/* Eyes: project the view ahead of the fly onto its real retina and send photoreceptor rates to the brain.

   Sources: Google Street View (needs a key; images proxied by the server), a synthetic street scene, or a
   moving bar for optomotor tests. The image covers 120 x 60 degrees ahead. Each traced R1-R6 photoreceptor
   has a visual direction from the retina map (/api/retina); its brightness there sets its Poisson rate:
   rate = dark + (light - dark) * brightness. With the default 90 / 0 Hz, photoreceptors fire in the dark
   and fall silent in light, so lamina neurons held near threshold fire for light (the reference project's
   convention; the biological polarity is the reverse and gives a silent optic lobe in a spiking model). */
import { offset } from './map.js';
import { projectRay, wrap } from './navigation-core.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const FOV_H = 120, FOV_V = 60, W = 480, H = 240;
const READ = [['lamina_L', 'lamina ◀', 150], ['lamina_R', 'lamina ▶', 150], ['motion_L', 'T4/T5 ◀', 40], ['motion_R', 'T4/T5 ▶', 40],
  ['looming_L', 'LC4/LPLC2 ◀', 60], ['looming_R', 'LC4/LPLC2 ▶', 60], ['steer_L', 'steer ◀', 120], ['steer_R', 'steer ▶', 120]];

export class EyesView {
  constructor(app, map) {
    this.app = app; this.map = map; this.ready = false; this.source = 'off'; this.vision = { dark: 90, light: 0 };
    this.img = document.createElement('canvas'); this.img.width = W; this.img.height = H; this.ictx = this.img.getContext('2d', { willReadFrequently: true });
    this.lastSend = 0; this.lastFetch = 0; this.fetchHeading = 1e9; this.pano = null; this.panoPos = null; this.lastStep = 0; this.svStatus = ''; this.busy = false;
    this.meanL = 0; this.meanR = 0; this.barPos = -60; this.t = 0;
  }
  async mount(el) {
    this.el = el;
    el.innerHTML = `<div class="eyes"><div style="position:relative;min-width:0"><canvas class="scene"></canvas><div class="eye-title"><b id="eye-mode">off</b> <span id="eye-info"></span></div></div>
      <div class="side">
        <div><div class="k">source</div><select id="eye-src">
          <option value="off">off</option><option value="street">Google Street View</option><option value="synthetic">synthetic street</option><option value="bar">moving bar (optomotor)</option><option value="left">left half bright</option><option value="right">right half bright</option></select></div>
        <div class="lr"><div><span class="k">left eye</span><b id="eye-l">–</b></div><div><span class="k">right eye</span><b id="eye-r">–</b></div></div>
        <div class="bars" id="eye-bars"></div>
        <div class="sv-status" id="eye-status"></div>
      </div></div>`;
    this.canvas = el.querySelector('canvas.scene'); this.ctx = this.canvas.getContext('2d');
    const bars = el.querySelector('#eye-bars');
    for (const [k, label, max] of READ) { const d = document.createElement('div'); d.className = 'readout'; d.dataset.key = k; d.dataset.max = max; d.innerHTML = `<span class="name">${label}</span><div class="bar"><i></i></div><span class="val mono">0</span>`; bars.appendChild(d); }
    const sel = el.querySelector('#eye-src');
    sel.onchange = () => this.setSource(sel.value);
    this.retina = await (await fetch('/api/retina')).json();
    const n = this.retina.n; this.rates = new Uint8Array(n + 1); this.rates[0] = 1;
    this.frontal = []; for (let i = 0; i < n; i++) if (Math.abs(this.retina.az[i]) <= FOV_H / 2 + 5) this.frontal.push(i);
    if (!this.app.cfg.google_maps_api_key) { sel.querySelector('option[value=street]').textContent = 'Google Street View (needs key)'; }
    this.map.onTeleport = () => { this.pano = null; this.fetchHeading = 1e9; };
    this.ready = true; this.resize();
  }
  resize() { if (!this.canvas) return; const r = this.canvas.parentElement.getBoundingClientRect(); this.canvas.width = Math.max(2, Math.round(r.width * devicePixelRatio)); this.canvas.height = Math.max(2, Math.round(r.height * devicePixelRatio)); }
  setSource(src, internal = false) {
    if (!internal && this.app.navigation?.active) { this.app.toast('Use Free exploration to leave the route experiment.'); this.el.querySelector('#eye-src').value = this.source; return; }
    if (src === 'street' && !this.app.cfg.google_maps_api_key) { this.app.toast('Street View needs a Google Maps key in flylab.local.json', 5000); src = 'synthetic'; }
    this.source = src; this.el.querySelector('#eye-src').value = src; this.pano = null; this.fetchHeading = 1e9; this.hasImage = false; this.generation = (this.generation || 0) + 1;
    this.map.frozen = !!this.app.navigation?.active;
    this.navigationHeld = false;
    if (src === 'off') { this.rates.fill(0, 1); this.app.sendBytes(this.rates); this.svStatus = ''; }
  }

  showNavigation(canvas, blank, copyright) {
    this.source = 'navigation'; this.hasImage = true; this.navigationHeld = false;
    if (blank) { this.ictx.fillStyle = '#777'; this.ictx.fillRect(0, 0, W, H); }
    else this.ictx.drawImage(canvas, 0, 0, W, H);
    this.svStatus = `${blank ? 'Eyes covered · ' : ''}${copyright || '© Google'}`;
    this.sample();
  }
  holdNavigation() { this.navigationHeld = true; this.rates.fill(0, 1); this.app.sendBytes(this.rates); }

  // ------------------------------------------------------------- image sources
  drawSynthetic(heading) {
    const g = this.ictx;
    const sky = g.createLinearGradient(0, 0, 0, H * 0.55); sky.addColorStop(0, '#dfe9f5'); sky.addColorStop(1, '#f7f4ea'); g.fillStyle = sky; g.fillRect(0, 0, W, H * 0.55);
    g.fillStyle = '#6b6b66'; g.fillRect(0, H * 0.55, W, H * 0.45);
    // a street running north; buildings along both sides, a bright opening at the end
    const rel = ((heading % 360) + 540) % 360 - 180;       // -180..180, 0 = looking along the street
    const vx = W / 2 - rel * (W / FOV_H);                 // vanishing point x
    g.fillStyle = '#9c9a92'; g.beginPath(); g.moveTo(vx - 6, H * 0.55); g.lineTo(vx + 6, H * 0.55); g.lineTo(W * 1.3, H); g.lineTo(-W * 0.3, H); g.closePath(); g.fill();
    for (let k = 0; k < 14; k++) {
      const s = k % 2 ? 1 : -1, depth = 1 + Math.floor(k / 2) * 0.9;
      const x0 = vx + s * (0.03 + 0.9 / depth) * W * 0.5, x1 = vx + s * (0.03 + 0.9 / (depth + 0.9)) * W * 0.5;
      const top = H * 0.55 - (0.5 + ((k * 7919) % 5) * 0.12) * H / depth;
      g.fillStyle = k % 3 ? '#3a3a40' : '#4b4640'; g.beginPath(); g.moveTo(x0, H * 0.55 + 4 / depth); g.lineTo(x0, top); g.lineTo(x1, top + 12 / depth); g.lineTo(x1, H * 0.55 + 2 / depth); g.closePath(); g.fill();
    }
    const sunx = W / 2 - (rel - 40) * (W / FOV_H);          // a low sun 40 degrees right of the street
    const rg = g.createRadialGradient(sunx, H * 0.3, 0, sunx, H * 0.3, 60); rg.addColorStop(0, 'rgba(255,255,240,1)'); rg.addColorStop(1, 'rgba(255,255,240,0)');
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
  }
  drawBar(dt) {
    const g = this.ictx; g.fillStyle = '#202020'; g.fillRect(0, 0, W, H);
    this.barPos += 40 * dt; if (this.barPos > FOV_H / 2 + 12) this.barPos = -FOV_H / 2 - 12;   // 40 deg/s, left to right
    const x = W / 2 + this.barPos * (W / FOV_H); g.fillStyle = '#f4f4f4'; g.fillRect(x - 14, 0, 28, H);
  }
  drawHalf(side) { const g = this.ictx; g.fillStyle = '#141414'; g.fillRect(0, 0, W, H); g.fillStyle = '#f0f0f0'; g.fillRect(side === 'left' ? 0 : W / 2, 0, W / 2, H); }
  async fetchStreet(w) {
    if (this.busy || performance.now() < (this.retryAfter || 0)) return; this.busy = true;
    const generation = this.generation;
    try {
      const now = performance.now();
      const needPano = !this.pano || (w.mode === 'walking' || w.mode === 'flying') && now - this.lastStep > 1400;
      if (needPano) {
        const ahead = this.pano ? offset(w, w.heading, 14) : w;
        const r = await fetch(`/api/streetview/meta?lat=${ahead.lat}&lng=${ahead.lng}&radius=${this.pano ? 22 : 120}`);
        const meta = await r.json(); this.lastStep = now;
        if (generation !== this.generation) return;
        if (meta.status === 'OK') {
          if (meta.pano_id !== this.pano) { this.pano = meta.pano_id; this.panoPos = meta.location; this.map.snapTo(meta.location.lat, meta.location.lng); this.fetchHeading = 1e9; this.svStatus = `pano ${this.pano.slice(0, 10)}…`; }
        } else { this.svStatus = meta.error_message || `no Street View ahead (${meta.status})`; this.hasImage = false; this.retryAfter = now + 10000; }
      }
      if (this.pano && (!this.hasImage || Math.abs(wrap(w.heading - this.fetchHeading)) > 12)) {
        const h = ((w.heading % 360) + 360) % 360;
        const response = await fetch(`/api/streetview?pano=${encodeURIComponent(this.pano)}&lat=${this.panoPos.lat}&lng=${this.panoPos.lng}&heading=${h}&pitch=0&fov=${FOV_H}&size=${W}x${H}`);
        if (!response.ok) { const error = await response.json(); throw new Error(error.detail || 'Image unavailable'); }
        const bmp = await createImageBitmap(await response.blob());
        if (generation !== this.generation) { bmp.close(); return; }
        this.ictx.drawImage(bmp, 0, 0, W, H); bmp.close();
        this.fetchHeading = w.heading; this.lastFetch = now; this.hasImage = true;
      }
    } catch (e) { if (generation === this.generation) { this.hasImage = false; this.rates.fill(0, 1); this.app.sendBytes(this.rates); this.svStatus = 'Street View: ' + e.message; this.retryAfter = performance.now() + 10000; } }
    finally { this.busy = false; }
  }

  // ------------------------------------------------------------------- retina
  sample() {
    const px = this.ictx.getImageData(0, 0, W, H).data;
    const { az, el, side, n } = this.retina, h = this.map.w.heading;
    const dark = this.vision.dark, light = this.vision.light;
    let sl = 0, nl = 0, sr = 0, nr = 0;
    this.samples = this.samples || new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const point = projectRay(az[i], el[i], W, H, FOV_H);
      if (!point) { this.samples[i] = -1; this.rates[i + 1] = 0; continue; }
      const [x, y] = point;
      const k = (y * W + x) * 4;
      const b = Math.pow((0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2]) / 255, 0.9);
      this.samples[i] = b;
      this.rates[i + 1] = clamp(Math.round(dark + (light - dark) * b), 0, 255);
      if (side[i] === 'L') { sl += b; nl++; } else { sr += b; nr++; }
    }
    this.meanL = nl ? sl / nl : 0; this.meanR = nr ? sr / nr : 0;
    this.app.sendBytes(this.rates);
  }

  render(dt) {
    if (!this.ready) return;
    this.t += dt;
    const w = this.map.w;
    if (this.source === 'synthetic') this.drawSynthetic(w.heading);
    else if (this.source === 'bar') this.drawBar(dt);
    else if (this.source === 'left' || this.source === 'right') this.drawHalf(this.source);
    else if (this.source === 'street') this.fetchStreet(w);
    const now = performance.now();
    if (!this.navigationHeld && this.source !== 'off' && (this.source !== 'street' || this.hasImage) && this.app.navigation?.state !== 'paused' && now - this.lastSend > 100) { this.lastSend = now; this.sample(); }
    // draw
    const c = this.canvas, g = this.ctx, cw = c.width, ch = c.height;
    g.fillStyle = '#000'; g.fillRect(0, 0, cw, ch);
    const scale = Math.min(cw / W, ch / H), dw = W * scale, dh = H * scale, ox = (cw - dw) / 2, oy = (ch - dh) / 2;
    if (this.source !== 'off') {
      g.drawImage(this.img, ox, oy, dw, dh);
      if (this.samples && document.body.classList.contains('show-brain')) {
        const { az, el, side, n } = this.retina;
        for (let i = 0; i < n; i++) {
          const point = projectRay(az[i], el[i], W, H, FOV_H);
          if (!point || this.samples[i] < 0) continue;
          const x = ox + point[0] / W * dw, y = oy + point[1] / H * dh, b = this.samples[i];
          if (point[1] > H - 25) continue; // keep Google's embedded attribution unobscured
          g.beginPath(); g.arc(x, y, 3.2 * devicePixelRatio, 0, Math.PI * 2);
          g.fillStyle = side[i] === 'L' ? `rgba(89,209,255,${0.25 + 0.75 * b})` : `rgba(255,180,84,${0.25 + 0.75 * b})`; g.fill();
        }
        g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = devicePixelRatio; g.beginPath(); g.moveTo(ox + dw / 2, oy); g.lineTo(ox + dw / 2, oy + dh); g.stroke();
      }
    } else { g.fillStyle = '#8a93a6'; g.font = `${14 * devicePixelRatio}px Inter`; g.textAlign = 'center'; g.fillText('Click Learn trip to open your fly’s eyes.', cw / 2, ch / 2); }
    const q = (s) => this.el.querySelector(s);
    q('#eye-mode').textContent = this.source === 'off' ? 'off' : ['street', 'navigation'].includes(this.source) ? 'Street View' : this.source;
    q('#eye-info').textContent = this.source === 'off' ? '' : this.app.navigation?.state === 'paused' ? 'Paused · current view' : document.body.classList.contains('show-brain') ? `heading ${Math.round(((w.heading % 360) + 360) % 360)}° · ${this.frontal.length} of ${this.retina.n} photoreceptors in view` : this.navigationHeld ? 'Last view · stopped' : 'Looking at the street';
    q('#eye-l').textContent = this.source === 'off' ? '–' : this.meanL.toFixed(2); q('#eye-r').textContent = this.source === 'off' ? '–' : this.meanR.toFixed(2);
    q('#eye-status').textContent = this.svStatus;
    const m = this.app.ema;
    this.el.querySelectorAll('.readout').forEach((d) => { const v = m[d.dataset.key] || 0; d.querySelector('i').style.width = clamp(v / +d.dataset.max, 0, 1) * 100 + '%'; d.querySelector('.val').textContent = v >= 10 ? Math.round(v) : v.toFixed(1); });
  }
}
