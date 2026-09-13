import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PALETTE = {
  ol_intrinsic: '#3f74b3', cb_intrinsic: '#4fb3a9', vnc_intrinsic: '#8a63d2', visual_projection: '#2fc4e0',
  vnc_sensory: '#7bd36a', cb_sensory: '#a3e05a', ol_sensory: '#5ec26a', ascending_neuron: '#e8c547',
  descending_neuron: '#ff9a3c', vnc_motor: '#ff5c5c', cb_motor: '#ff7a7a', visual_centrifugal: '#39a2ff',
  sensory_ascending: '#b8e986', vnc_efferent: '#ff8fa3', cb_endocrine: '#f0a6ff', '?': '#8892a6',
};
const LEGEND = ['ol_intrinsic', 'visual_projection', 'cb_intrinsic', 'vnc_intrinsic', 'cb_sensory', 'vnc_sensory', 'descending_neuron', 'ascending_neuron', 'vnc_motor', 'cb_motor'];

const VERT = `
attribute vec3 col; attribute float last; attribute float mask;
uniform float uNow, uTau, uSize, uPx;
varying vec3 vColor; varying float vAlpha;
void main() {
  float age = uNow - last;
  float b = age >= 0.0 ? exp(-age / uTau) : 0.0;
  vColor = mix(col * 0.7, vec3(1.0, 0.92, 0.7), b);
  vAlpha = (0.16 + 0.5 * b) * mask;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = (uSize + 5.0 * b) * uPx * (150.0 / -mv.z) * (0.4 + 0.6 * mask);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
varying vec3 vColor; varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5; float r = length(d);
  if (r > 0.5) discard;
  float soft = smoothstep(0.5, 0.12, r);
  gl_FragColor = vec4(vColor, vAlpha * soft);
}`;

export class BrainView {
  constructor(app) { this.app = app; this.ready = false; this.active = false; this.simT = 0; this.wallAt = 0; }

  async mount(el) {
    this.el = el;
    if (!this.ready) await this.init();
    el.appendChild(this.renderer.domElement);
    el.appendChild(this.legend);
    this.active = true;
    this.resize();
  }
  unmount() { this.active = false; }
  resize() {
    if (!this.ready || !this.el) return;
    const w = this.el.clientWidth || 300, h = this.el.clientHeight || 200;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.mat) this.mat.uniforms.uSize.value = 1.6 * Math.min(1, h / 700);   // smaller dots in small panels
  }

  async init() {
    const [pb, cb] = await Promise.all([fetch('/api/positions').then((r) => r.arrayBuffer()), fetch('/api/classes').then((r) => r.arrayBuffer())]);
    const raw = new Float32Array(pb); const n = this.n = raw.length / 3;
    const cls = new Uint8Array(cb, 0, n);
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const v = raw[3 * i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    const c = mn.map((a, k) => (a + mx[k]) / 2), ext = Math.max(...mx.map((a, k) => a - mn[k]));
    const s = 120 / ext;
    // data axes: x left-right, y dorsal-ventral, z brain -> nerve cord. Show the long axis vertical, brain up.
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const names = this.app.cfg.superclasses; const colors = names.map((nm) => new THREE.Color(PALETTE[nm] || '#7f8797'));
    for (let i = 0; i < n; i++) {
      pos[3 * i] = (raw[3 * i] - c[0]) * s;
      pos[3 * i + 1] = -(raw[3 * i + 2] - c[2]) * s;
      pos[3 * i + 2] = (raw[3 * i + 1] - c[1]) * s;
      const k = colors[cls[i]] || colors[0];
      col[3 * i] = k.r; col[3 * i + 1] = k.g; col[3 * i + 2] = k.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('col', new THREE.BufferAttribute(col, 3));
    this.lastAttr = new THREE.BufferAttribute(new Float32Array(n).fill(-1e7), 1);
    this.lastAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('last', this.lastAttr);
    this.maskAttr = new THREE.BufferAttribute(new Float32Array(n).fill(1), 1);
    geo.setAttribute('mask', this.maskAttr);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uNow: { value: 0 }, uTau: { value: 70 }, uSize: { value: 1.6 }, uPx: { value: Math.min(devicePixelRatio, 2) } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.scene = new THREE.Scene();
    this.scene.add(this.points);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 2000);
    this.camera.position.set(90, 30, 170);
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08; this.controls.autoRotate = true; this.controls.autoRotateSpeed = 0.5;
    this.controls.addEventListener('start', () => (this.controls.autoRotate = false));
    this.raycaster = new THREE.Raycaster(); this.raycaster.params.Points.threshold = 0.9;
    this.renderer.domElement.addEventListener('click', (e) => this.pick(e));
    this.legend = document.createElement('div'); this.legend.className = 'legend';
    this.legend.innerHTML = LEGEND.filter((k) => names.includes(k)).map((k) => `<div><i style="background:${PALETTE[k]}"></i>${k.replace(/_/g, ' ')}</div>`).join('');
    this.title = document.createElement('div'); this.title.className = 'overlay-title';
    this.title.innerHTML = `<b>${n.toLocaleString()} neurons</b> · ${this.app.cfg.edges.toLocaleString()} connections · brain above, nerve cord below`;
    this.ready = true;
  }

  onFrame(h, idx) {
    const last = this.lastAttr.array;
    for (let k = 0; k < idx.length; k++) last[idx[k]] = h.t;
    this.lastAttr.needsUpdate = true;
    this.simT = h.t; this.wallAt = performance.now();
  }

  highlight(idx) {
    const m = this.maskAttr.array;
    if (!idx) m.fill(1); else { m.fill(0.12); for (let k = 0; k < idx.length; k++) m[idx[k]] = 1; }
    this.maskAttr.needsUpdate = true;
  }

  render() {
    if (!this.active || !this.ready) return;
    const now = this.simT + (performance.now() - this.wallAt) * (this.app.rt || 0.5);
    this.mat.uniforms.uNow.value = now;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  async pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const m = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(m, this.camera);
    const hits = this.raycaster.intersectObject(this.points);
    const tip = document.getElementById('tooltip');
    if (!hits.length) { tip.hidden = true; return; }
    hits.sort((a, b) => a.distanceToRay - b.distanceToRay);
    const i = hits[0].index;
    const d = await (await fetch(`/api/neuron/${i}`)).json();
    tip.innerHTML = `<b>${d.type || 'untyped'}</b> ${d.side && d.side !== '?' ? '· ' + d.side : ''}<br>${(d.superclass || '').replace(/_/g, ' ')}${d.class ? ' · ' + d.class : ''}<br>` +
      `<span class="muted">${d.nt} (${d.sign > 0 ? 'excitatory' : d.sign < 0 ? 'inhibitory' : 'no effect'}) · ${d.out_degree} outputs · body ${d.bodyId}</span>` +
      (d.dimorphism ? `<br><span class="muted">${d.dimorphism}</span>` : '');
    tip.style.left = e.clientX + 14 + 'px'; tip.style.top = e.clientY + 10 + 'px'; tip.hidden = false;
    clearTimeout(this._tipT); this._tipT = setTimeout(() => (tip.hidden = true), 6000);
  }
}
