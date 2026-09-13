import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createAnatomicalFly } from './anatomy.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- textures
function bandTexture() {
  // male abdomen: tan tergites with dark posterior bands, last segments black
  const c = document.createElement('canvas'); c.width = 64; c.height = 256; const g = c.getContext('2d');
  g.translate(0, 256); g.scale(1, -1); // local +y is posterior; Lathe v=1 samples the canvas top
  const grad = g.createLinearGradient(0, 0, 0, 256); grad.addColorStop(0, '#c99a62'); grad.addColorStop(1, '#a87a48');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 256);
  const bands = [[30, 10], [72, 14], [118, 18], [162, 22]];
  for (const [y, h] of bands) { g.fillStyle = '#231a16'; g.fillRect(0, y, 64, h); }
  g.fillStyle = '#1a1310'; g.fillRect(0, 200, 64, 56);   // black tip of the male abdomen
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function facetBump() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, 256, 256);
  const r = 7, dx = r * 1.75, dy = r * 1.5;
  for (let j = 0; j < 256 / dy + 1; j++) for (let i = 0; i < 256 / dx + 1; i++) {
    const x = i * dx + (j % 2) * dx / 2, y = j * dy;
    const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, '#ffffff'); rg.addColorStop(1, '#606060');
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); return t;
}

// ---------------------------------------------------------------- geometry helpers
function lathe(profile, mat, segments = 40) {
  // profile: [[radius, height], ...] along local +y
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, segments), mat);
  m.castShadow = true; return m;
}
function seg(len, r0, r1, mat) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 16), mat);
  m.rotation.z = -Math.PI / 2; m.position.x = len / 2; m.castShadow = true; return m;
}
function bristle(parent, from, to, mat, radius = .005) {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), d = b.clone().sub(a);
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(radius, d.length(), 5), mat);
  mesh.position.copy(a).addScaledVector(d, .5); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  parent.add(mesh); return mesh;
}

function compoundFacets(eye, material) {
  // Uniform surface lenses, instanced to keep the two live renderers responsive.
  const count = 1400, mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(.014, 6, 4), material, count);
  const transform = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const y = 1 - 2 * (i + .5) / count, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5));
    const normal = new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a));
    transform.position.copy(normal).multiplyScalar(.329); transform.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    transform.scale.set(1, 1, .24); transform.updateMatrix(); mesh.setMatrixAt(i, transform.matrix);
  }
  mesh.name = 'compound-eye corneal lenses (illustrative density)'; eye.add(mesh);
}
function wingGeometry() {
  // Drosophila wing outline, root at origin, extends along +x, ~2.2 mm long, ~0.85 mm wide
  const s = new THREE.Shape();
  s.moveTo(0, 0.04);
  s.bezierCurveTo(0.5, 0.22, 1.4, 0.34, 2.0, 0.2);      // costa (leading edge), nearly straight
  s.bezierCurveTo(2.2, 0.14, 2.28, 0.0, 2.2, -0.14);    // rounded tip
  s.bezierCurveTo(2.0, -0.45, 1.5, -0.66, 1.05, -0.62); // trailing edge
  s.bezierCurveTo(0.6, -0.58, 0.3, -0.42, 0.18, -0.3);
  s.bezierCurveTo(0.12, -0.2, 0.06, -0.1, 0, -0.06);    // alula and root
  s.closePath();
  return new THREE.ShapeGeometry(s, 36);
}
function wingVeins(mat) {
  const pts = [];
  const line = (...p) => { for (let i = 0; i < p.length - 1; i++) pts.push(new THREE.Vector3(p[i][0], 0, -p[i][1]), new THREE.Vector3(p[i + 1][0], 0, -p[i + 1][1])); };
  line([0.1, 0.06], [1.2, 0.28], [2.0, 0.19]);            // L1 costa
  line([0.15, 0.0], [1.1, 0.14], [2.15, 0.05]);           // L2
  line([0.15, -0.05], [1.0, -0.06], [2.1, -0.18]);        // L3
  line([0.15, -0.1], [0.9, -0.28], [1.7, -0.5]);          // L4
  line([0.15, -0.15], [0.6, -0.4], [1.05, -0.6]);         // L5
  line([0.55, 0.06], [0.55, -0.2]);                       // anterior crossvein
  line([1.25, -0.04], [1.2, -0.33]);                      // posterior crossvein
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.LineSegments(g, mat);
}

/** Procedural male Drosophila melanogaster, ~2.6 mm, forward = -z, up = +y. Returns { group, update(dt, motor, t) }. */
export function createFly() {
  const g = new THREE.Group();
  g.name = 'Male Drosophila melanogaster';
  g.userData.anatomy = { legs: 6, wings: 2, halteres: 2, ocelli: 3, tarsomeresPerLeg: 5,
    legSegments: ['coxa', 'trochanter', 'femur', 'tibia', 'tarsus'], sexCombs: 'foreleg basitarsi only', fidelity: 'procedural anatomical illustration; no morphometric validation' };
  const cuticle = new THREE.MeshStandardMaterial({ color: 0x4a3a31, roughness: 0.62, metalness: 0.08 });
  const cuticleDark = new THREE.MeshStandardMaterial({ color: 0x2a1f1a, roughness: 0.7 });
  const legMat = new THREE.MeshStandardMaterial({ color: 0x9a7a55, roughness: 0.7 });
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 0.7 });
  const eyeMat = new THREE.MeshPhysicalMaterial({ color: 0x9c2117, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.2, bumpMap: facetBump(), bumpScale: 0.012 });
  const ocellusMat = new THREE.MeshPhysicalMaterial({ color: 0xffb454, roughness: 0.2, clearcoat: 1, emissive: 0x4a2a00 });
  const wingMat = new THREE.MeshPhysicalMaterial({ color: 0xe6f1ff, transparent: true, opacity: 0.28, roughness: 0.12, metalness: 0.05, side: THREE.DoubleSide, iridescence: 0.85, iridescenceIOR: 1.35, depthWrite: false });
  const veinMat = new THREE.LineBasicMaterial({ color: 0x6b5a4a, transparent: true, opacity: 0.55 });
  const abdMat = new THREE.MeshStandardMaterial({ map: bandTexture(), roughness: 0.58 });

  // ---- thorax: scutum hump with scutellum, lying along z
  const thorax = lathe([[0.02, -0.62], [0.34, -0.5], [0.52, -0.25], [0.56, 0.0], [0.52, 0.25], [0.4, 0.45], [0.3, 0.55], [0.02, 0.62]], cuticle);
  thorax.rotation.x = Math.PI / 2; thorax.scale.set(1, 1, 0.82); thorax.position.set(0, 0.98, 0.02); g.add(thorax);
  const scutellum = new THREE.Mesh(new THREE.SphereGeometry(0.19, 20, 14), cuticle); scutellum.scale.set(1.2, 0.7, 1); scutellum.position.set(0, 1.28, 0.52); g.add(scutellum);
  // dorsal bristles
  for (let i = 0; i < 10; i++) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.012, 0.22, 4), cuticleDark);
    const side = i % 2 ? 1 : -1, row = Math.floor(i / 2);
    b.position.set(side * (0.12 + 0.08 * row), 1.36 - 0.04 * row, -0.35 + row * 0.2); b.rotation.x = -0.9; b.rotation.z = side * -0.35; g.add(b);
  }
  // ---- abdomen: tapered, banded, curving slightly down at the tip
  const abdomen = lathe([[0.02, -0.9], [0.3, -0.75], [0.46, -0.45], [0.5, -0.1], [0.44, 0.3], [0.3, 0.65], [0.14, 0.88], [0.02, 0.95]], abdMat, 44);
  abdomen.rotation.x = Math.PI / 2 + 0.12; abdomen.scale.set(1, 1, 0.8); abdomen.position.set(0, 0.86, 1.28); abdomen.name = 'abdomen · posterior male pigmentation'; g.add(abdomen);
  // Small cuticular setae distributed on the dorsal abdomen; deterministic geometry.
  for (let i = 0; i < 160; i++) {
    const a = (i * 2.39996) % (Math.PI * 2), y = -.65 + (i % 31) / 30 * 1.4;
    const radius = .48 * Math.sqrt(Math.max(.05, 1 - (y / 1.05) ** 2));
    const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
    bristle(abdomen, [x, y, z], [x * 1.09, y + .04, z * 1.09], cuticleDark, .0025);
  }
  const genitalia = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), cuticleDark); genitalia.position.set(0, 0.72, 2.2); g.add(genitalia);
  // ---- head with large compound eyes, ocelli, antennae, proboscis
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 32, 24), cuticle); head.scale.set(1.05, 1, 0.8); head.position.set(0, 1.02, -0.88); head.castShadow = true; g.add(head);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.33, 32, 24), eyeMat);
    eye.scale.set(0.62, 1.05, 0.95); eye.position.set(s * 0.3, 1.02, -0.9); eye.castShadow = true; g.add(eye);
    eye.name = `${s < 0 ? 'left' : 'right'} compound eye`; compoundFacets(eye, eyeMat);
    // antenna: scape + pedicel + funiculus + feathery arista
    const scape = new THREE.Mesh(new THREE.SphereGeometry(.04, 12, 8), jointMat); scape.position.set(s * .09, 1.1, -1.19); g.add(scape);
    const ped = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), cuticleDark); ped.position.set(s * 0.1, 1.06, -1.22); g.add(ped);
    const fun = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), jointMat); fun.scale.set(0.8, 1, 1.3); fun.position.set(s * 0.12, 0.98, -1.32); g.add(fun);
    const arista = new THREE.Group(); arista.position.set(s * 0.12, 1.04, -1.36); arista.rotation.set(-0.7, 0, s * 0.45);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.009, 0.42, 5), cuticleDark); shaft.position.y = 0.21; arista.add(shaft);
    for (let k = 0; k < 5; k++) { const br = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.004, 0.11, 4), cuticleDark); br.position.set(0, 0.12 + k * 0.07, 0); br.rotation.z = (k % 2 ? 1 : -1) * 1.1; arista.add(br); }
    g.add(arista);
    // haltere
    const halt = new THREE.Group(); halt.position.set(s * 0.46, 1.08, 0.62);
    halt.name = `${s < 0 ? 'left' : 'right'} metathoracic haltere`;
    bristle(halt, [0, 0, 0], [s * .28, .1, 0], legMat, .018);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), legMat); knob.position.set(s * 0.28, 0.1, 0); halt.add(knob);
    g.add(halt);
  }
  for (const [x, z] of [[0, -0.9], [-0.07, -0.82], [0.07, -0.82]]) { const o = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), ocellusMat); o.position.set(x, 1.4, z); o.name = 'ocellus'; g.add(o); }
  const probPivot = new THREE.Group(); probPivot.position.set(0, 0.78, -0.98);
  const rostrum = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.32, 12), cuticle); rostrum.position.y = -0.16; probPivot.add(rostrum);
  const haust = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.34, 12), jointMat); haust.position.y = -0.48; probPivot.add(haust);
  for (const s of [-1, 1]) { const lab = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), new THREE.MeshStandardMaterial({ color: 0x8a6a56, roughness: 0.85 })); lab.scale.set(1, 0.55, 1.2); lab.position.set(s * 0.08, -0.7, 0.02); probPivot.add(lab); }
  g.add(probPivot);

  // ---- legs: coxa, femur, tibia, 5 tarsomeres with claws; male sex comb on the foreleg
  const legs = [];
  const attach = [[0.36, 0.7, -0.5], [0.42, 0.62, -0.02], [0.36, 0.66, 0.42]];
  const yaw = [0.95, 0.1, -0.85];
  for (let i = 0; i < 3; i++) for (const s of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(s * attach[i][0], attach[i][1], attach[i][2]); hip.scale.x = s;
    hip.name = `${s < 0 ? 'left' : 'right'} ${['foreleg', 'midleg', 'hindleg'][i]}`;
    const hipYaw = new THREE.Group(); hip.add(hipYaw);
    const coxaP = new THREE.Group(); coxaP.rotation.z = -.35; hipYaw.add(coxaP); coxaP.add(seg(0.28, 0.08, 0.07, jointMat));
    const trochanter = new THREE.Group(); trochanter.name = 'trochanter'; trochanter.position.x = .28; coxaP.add(trochanter); trochanter.add(seg(.12, .07, .06, jointMat));
    const femurP = new THREE.Group(); femurP.position.x = .12; trochanter.add(femurP); femurP.add(seg(0.9, 0.065, 0.05, legMat));
    const tibiaP = new THREE.Group(); tibiaP.position.x = 0.9; femurP.add(tibiaP); tibiaP.add(seg(0.85, 0.045, 0.035, legMat));
    const tarsusP = new THREE.Group(); tarsusP.position.x = 0.85; tibiaP.add(tarsusP);
    let x = 0; for (const len of [0.32, 0.14, 0.12, 0.1, 0.1]) { const t = seg(len, 0.03, 0.026, legMat); t.name = 'tarsomere'; t.position.x = x + len / 2; tarsusP.add(t); x += len; }
    for (const c of [-1, 1]) { const claw = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.08, 6), cuticleDark); claw.position.set(x + 0.03, 0, c * 0.02); claw.rotation.z = -Math.PI / 2; tarsusP.add(claw); }
    if (i === 0) { const comb = new THREE.Group(); comb.name = 'male sex comb · basitarsus'; for (let tooth = 0; tooth < 11; tooth++) bristle(comb, [.075 + tooth * .016, -.025, .024], [.085 + tooth * .016, -.09, .055], cuticleDark, .008); tarsusP.add(comb); }
    for (const part of [femurP, tibiaP]) for (let k = 0; k < 12; k++) bristle(part, [.08 + k * .06, .045, 0], [.05 + k * .06, .115, .035 * (k % 2 ? 1 : -1)], cuticleDark, .003);
    g.add(hip);
    legs.push({ i, s, hipYaw, coxaP, femurP, tibiaP, tarsusP, height: attach[i][1], phase: ((i + (s > 0 ? 0 : 1)) % 2) * 0.5 });
  }
  // ---- wings with veins, folded flat over the abdomen at rest
  const wings = [];
  const wGeo = wingGeometry();
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group(); pivot.position.set(s * 0.22, 1.36, 0.22); pivot.scale.x = s;
    pivot.name = `${s < 0 ? 'left' : 'right'} mesothoracic wing`;
    const flap = new THREE.Group(); pivot.add(flap);
    const ghosts = [];
    for (let k = 0; k < 3; k++) {
      const holder = new THREE.Group();
      const w = new THREE.Mesh(wGeo, k ? wingMat.clone() : wingMat); w.rotation.x = -Math.PI / 2; holder.add(w);
      if (k) { w.material.opacity = 0.1; holder.visible = false; } else holder.add(wingVeins(veinMat));
      flap.add(holder); ghosts.push(holder);
    }
    g.add(pivot); wings.push({ s, pivot, flap, ghosts });
  }

  const st = { walkPhase: 0, prob: 0, wingSpread: 0, flap: 0, jumpV: 0, jumpY: 0, jumpCd: 0, flightT: 0, breathe: 0 };
  function update(dt, m, t) {
    m = m || {};
    const walk = clamp((m.walk || 0) / 25 + (m.leg_mn || 0) / 40, 0, 1.4);
    const wing = m.wing_mn || 0;
    // takeoff needs the escape jump (giant fiber); steady wing-motor activity on the ground is a buzz.
    st.jumpCd -= dt;
    if ((m.giant_fiber || 0) > 60 && st.jumpCd <= 0) { st.jumpV = 7; st.jumpCd = 1.4; if (wing > 25) st.flightT = 4; }
    if (st.flightT > 0) st.flightT = wing > 25 ? st.flightT - dt : 0;
    const flying = st.flightT > 0 || st.jumpY > 0.05;
    const buzzing = !flying && wing > 25;
    const grooming = (m.groom || 0) > 4 && !flying && walk < 0.2;
    const singing = ((m.song || 0) > 5 || (m.courtship || 0) > 12) && !flying;
    const backing = (m.backward || 0) > 5 && !flying;
    if (st.jumpY > 0 || st.jumpV > 0) { st.jumpV -= 32 * dt; st.jumpY = Math.max(0, st.jumpY + st.jumpV * dt); if (st.jumpY === 0) st.jumpV = 0; }
    g.position.y = st.jumpY;
    // tripod gait
    const gaitSpeed = flying ? 0 : (walk > 0.05 ? 1.6 + 2.4 * walk : 0) * (backing ? -0.7 : 1);
    st.walkPhase += gaitSpeed * dt;
    const moving = Math.abs(gaitSpeed) > 0.01 ? 1 : 0;
    for (const L of legs) {
      const ph = (st.walkPhase + L.phase) % 1;
      const swing = Math.sin(ph * Math.PI * 2), lift = Math.max(0, Math.sin(ph * Math.PI * 2));
      let hy = yaw[L.i] + moving * 0.32 * swing;
      // Two-link inverse kinematics plants stance feet on y=0; swing feet lift.
      const dx = 1.18 + moving * swing * .14, dy = -L.height + .4 * Math.sin(.35) + .035 + moving * lift * .18;
      const knee = -Math.acos(clamp((dx * dx + dy * dy - .9 ** 2 - .85 ** 2) / (2 * .9 * .85), -1, 1));
      const femur = Math.atan2(dy, dx) - Math.atan2(.85 * Math.sin(knee), .9 + .85 * Math.cos(knee));
      let fe = femur + .35, ti = knee, ta = -femur - knee;
      if (flying) { fe = -0.3; ti = 2.3; ta = -1.1; hy = yaw[L.i] * 0.4 + 0.5; }
      if (grooming && L.i === 0) { hy = 1.55 + 0.35 * Math.sin(t * 14 + L.s); fe = 0.7 + 0.25 * Math.sin(t * 14); ti = 1.2; ta = -0.6; }
      L.hipYaw.rotation.y = -hy; L.femurP.rotation.z = fe; L.tibiaP.rotation.z = ti; L.tarsusP.rotation.z = ta;
    }
    // wings
    st.wingSpread = lerp(st.wingSpread, flying ? 1 : 0, 1 - Math.exp(-dt * 10));
    st.flap += dt * (flying ? 110 : 0);
    for (const W of wings) {
      let yawA = lerp(-1.38, -0.25, st.wingSpread);
      let roll = flying ? Math.sin(st.flap) * 0.7 : buzzing ? 0.04 + Math.sin(t * 120) * 0.12 : 0.04;
      if (singing && W.s > 0) { yawA = -0.7; roll = 0.1 + Math.sin(t * 90) * 0.25; }
      W.pivot.rotation.y = yawA; W.flap.rotation.z = roll;
      W.ghosts.forEach((gg, k) => { if (k) { gg.visible = flying; gg.rotation.z = Math.sin(st.flap + k * 1.6) * 0.7 - roll; } });
    }
    // proboscis
    st.prob = lerp(st.prob, clamp((m.MN9 || 0) / 8, 0, 1), 1 - Math.exp(-dt * 6));
    probPivot.rotation.x = lerp(1.3, 0.05, st.prob); probPivot.scale.y = lerp(0.42, 1, st.prob);
    // body language
    st.breathe += dt;
    abdomen.scale.set(1 + 0.02 * Math.sin(st.breathe * 7), 1, 0.8 + 0.015 * Math.sin(st.breathe * 7));
    g.rotation.x = flying ? -0.2 : 0;
    return { walk, flying, buzzing, grooming, singing, backing, jumping: st.jumpY > 0.02, eating: st.prob > 0.5, speed: gaitSpeed };
  }
  return { group: g, update };
}

/** Showcase view with lighting, ground and orbit camera. */
export class FlyView {
  constructor(app) { this.app = app; this.ready = false; this.t = 0; }
  async mount(el) {
    this.el = el; if (!this.ready) this.init();
    el.appendChild(this.renderer.domElement); el.appendChild(this.title); this.resize();
    const toolbar = document.createElement('div'); toolbar.className = 'specimen-tools';
    toolbar.innerHTML = `<select aria-label="Specimen anatomy"><option value="research">Research anatomy · female</option><option value="male">Male illustration</option></select>`;
    el.appendChild(toolbar); const select = toolbar.querySelector('select'); select.disabled = true;
    try { this.researchFly = await createAnatomicalFly(); this.maleFly = this.fly; this.scene.remove(this.fly.group); this.fly = this.researchFly; this.scene.add(this.fly.group); }
    catch (error) { select.value = 'male'; this.app.toast(error.message, 8000); }
    select.disabled = false;
    select.onchange = () => { this.scene.remove(this.fly.group); this.fly = select.value === 'research' && this.researchFly ? this.researchFly : this.maleFly || this.fly; this.scene.add(this.fly.group); };
  }
  resize() {
    if (!this.ready || !this.el) return;
    const w = this.el.clientWidth || 300, h = this.el.clientHeight || 200;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const dist = 9 * Math.max(1, 1 / Math.max(0.35, w / h));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
  }
  init() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0a0d14, 12, 36);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(4.2, 2.6, 4.8);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.1;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.9, 0.3); this.controls.enableDamping = true; this.controls.autoRotate = true; this.controls.autoRotateSpeed = 0.7;
    this.controls.addEventListener('start', () => (this.controls.autoRotate = false));
    this.scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x2a1d14, 0.9));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.2); key.position.set(4, 7, 3); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); key.shadow.camera.near = 1; key.shadow.camera.far = 30; key.shadow.radius = 4;
    for (const k of ['left', 'right', 'top', 'bottom']) key.shadow.camera[k] = (k === 'left' || k === 'bottom' ? -1 : 1) * 6;
    this.scene.add(key);
    const rim = new THREE.PointLight(0x59d1ff, 30, 30); rim.position.set(-5, 3, -4); this.scene.add(rim);
    const amber = new THREE.PointLight(0xffb454, 18, 30); amber.position.set(3, 1.5, -5); this.scene.add(amber);
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
    g.fillStyle = '#0f131c'; g.fillRect(0, 0, 256, 256); g.strokeStyle = 'rgba(120,140,190,0.25)'; g.lineWidth = 1.5;
    for (let i = 0; i <= 256; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
    this.gridTex = new THREE.CanvasTexture(c); this.gridTex.wrapS = this.gridTex.wrapT = THREE.RepeatWrapping; this.gridTex.repeat.set(30, 30);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ map: this.gridTex, roughness: 0.95, color: 0xbfc8dd }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; this.scene.add(ground);
    this.fly = createFly(); this.scene.add(this.fly.group);
    this.title = document.createElement('div'); this.title.className = 'overlay-title';
    this.ready = true;
  }
  render(dt) {
    if (!this.ready) return;
    this.t += dt;
    const nav = this.app.navigation;
    const m = nav?.active ? nav.motor : this.app.frame?.playing ? this.app.ema : {};
    const s = this.fly.update(dt, m, this.t);
    const turn = ((m.steer_R || 0) - (m.steer_L || 0)) * 0.01;
    if (nav?.active) this.fly.group.rotation.y = -this.app.views.map.w.heading * Math.PI / 180;
    else this.fly.group.rotation.y -= turn * dt;
    this.gridTex.offset.y -= s.speed * 0.02 * dt;
    const mode = s.jumping ? 'jumping' : s.flying ? 'flying' : s.eating ? 'proboscis extended' : s.grooming ? 'grooming' : s.singing ? 'singing' : s.backing ? 'backing up' : s.walk > 0.05 ? 'walking' : s.buzzing ? 'wings buzzing' : 'idle';
    this.title.innerHTML = `<span style="color:var(--amber)">${mode}</span> · ${nav?.active ? 'street journey' : 'brain activity'}<br><span class="muted">${this.fly.reference ? 'Janelia / DeepMind · female anatomy, male CNS · illustrative motion' : 'Male illustration · 6 legs · 2 wings · halteres · sex combs'}</span>`;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

