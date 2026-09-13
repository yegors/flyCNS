import { BrainView } from './brain.js';
import { FlyView } from './fly.js';
import { MapView } from './map.js';
import { EyesView } from './eyes.js';
import { ExperimentsView } from './experiments.js';
import { NavigationLab } from './navigation.js';

const $ = (s) => document.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export const app = {
  cfg: null, ws: null, frame: null, drives: {}, ema: {}, rt: 0.5, simT: 0, wallAt: 0,
  spikes: new Float32Array(300), spikesPos: 0, views: {}, tab: 'lab', groupCache: new Map(),
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); },
  sendBytes(b) { if (this.ws && this.ws.readyState === 1 && this.ws.bufferedAmount < 200000) this.ws.send(b); },
  async group(query, side) {
    const key = query + (side ? ':' + side : '');
    if (!this.groupCache.has(key)) {
      const r = await fetch(`/api/group/${encodeURIComponent(query)}${side ? '?side=' + side : ''}`);
      this.groupCache.set(key, r.ok ? new Uint32Array(await r.arrayBuffer()) : new Uint32Array());
    }
    return this.groupCache.get(key);
  },
  toast(msg, ms = 2800) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(this._toastT); this._toastT = setTimeout(() => (t.hidden = true), ms);
  },
};
window.app = app;

const READOUT_META = {
  MN9: ['proboscis MN9', 40], giant_fiber: ['giant fiber', 400], wing_mn: ['wing motor', 300], leg_mn: ['leg motor', 120],
  steer_L: ['steer ◀ L', 160], steer_R: ['steer R ▶', 160], walk: ['walk DNp09', 160], backward: ['backward MDN', 160],
  groom: ['groom DNg11', 120], kenyon: ['Kenyon cells', 30], descending: ['descending', 60], courtship: ['courtship pC1', 60], song: ['song pIP10', 200],
};

async function main() {
  app.cfg = await (await fetch('/api/config')).json();
  buildPanel();
  app.views = {
    brain: new BrainView(app), fly: new FlyView(app), map: new MapView(app), experiments: new ExperimentsView(app),
  };
  app.views.eyes = new EyesView(app, app.views.map);
  await Promise.all([
    app.views.brain.mount($('#p-brain')), app.views.fly.mount($('#p-fly')),
    app.views.map.mount($('#p-map')).then(() => app.views.eyes.mount($('#p-eyes'))),
  ]);
  app.navigation = new NavigationLab(app);
  app.navigation.mount($('#navigation-lab'));
  $('#btn-details').onclick = () => {
    const on = document.body.classList.toggle('show-brain');
    $('#btn-details').setAttribute('aria-pressed', String(on));
    $('#btn-details').textContent = on ? 'Hide brain details' : 'Brain details';
    if (!on && app.tab !== 'lab') showTab('lab');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('max'));
    $('#lab').classList.remove('has-max');
    setTimeout(resizeAll, 30);
  };
  const ro = new ResizeObserver(() => resizeAll());
  document.querySelectorAll('.pb').forEach((el) => ro.observe(el));
  document.querMaxHandlers = document.querySelectorAll('.panel .exp').forEach((b) => (b.onclick = () => {
    const p = b.closest('.panel'), lab = $('#lab');
    const on = !p.classList.contains('max');
    document.querySelectorAll('.panel').forEach((x) => x.classList.remove('max'));
    lab.classList.toggle('has-max', on); if (on) p.classList.add('max');
    b.textContent = on ? '⤡' : '⤢';
    setTimeout(resizeAll, 30);
  }));
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.view); });
  connect();
  requestAnimationFrame(loop);
  $('#btn-play').onclick = () => { if (['running', 'paused'].includes(app.navigation.state)) app.navigation.pause(); else app.send({ cmd: app.frame && app.frame.playing ? 'pause' : 'play' }); };
  $('#btn-reset').onclick = () => { if (app.navigation.busy) app.navigation.stop('Trial stopped by brain reset.'); app.send({ cmd: 'reset' }); app.toast('brain reset to silence'); };
  $('#btn-clear').onclick = () => { if (app.navigation.busy) app.navigation.stop('Trial stopped by clear.'); app.send({ cmd: 'clear' }); app.views.eyes.setSource('off'); };
  $('#fix').onchange = (e) => app.send({ cmd: 'fix', on: e.target.checked });
  $('#rate').oninput = (e) => ($('#rate-label').textContent = e.target.value + ' Hz');
  const vision = () => {
    const hold = +$('#hold').value, dark = +$('#dark').value, light = +$('#light').value;
    $('#hold-label').textContent = hold.toFixed(1) + ' mV'; $('#rates-label').textContent = `${dark} / ${light} Hz`;
    app.send({ cmd: 'vision', hold_mv: hold, dark_hz: dark, light_hz: light });
    app.views.eyes.vision = { dark, light };
  };
  ['#hold', '#dark', '#light'].forEach((s) => ($(s).oninput = vision));
  const v0 = app.cfg.vision || {}; $('#hold').value = v0.hold_mv ?? 7.5; $('#dark').value = v0.dark_hz ?? 90; $('#light').value = v0.light_hz ?? 0;
  $('#hold-label').textContent = (+$('#hold').value).toFixed(1) + ' mV'; $('#rates-label').textContent = `${$('#dark').value} / ${$('#light').value} Hz`;
  app.views.eyes.vision = { dark: +$('#dark').value, light: +$('#light').value };
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); $('#btn-play').click(); } });
  window.addEventListener('resize', resizeAll);
  $('#st-eng').textContent = app.cfg.sim.graph ? `CUDA graph · ${app.cfg.sim.graph_kind}` : app.cfg.sim.device;
  if (location.hash === '#experiments') showTab('experiments');
}

function resizeAll() { for (const k of ['brain', 'fly', 'map', 'eyes']) app.views[k] && app.views[k].resize && app.views[k].resize(); }

function showTab(name) {
  app.tab = name; location.hash = name === 'lab' ? '' : name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  $('#lab').hidden = name !== 'lab'; $('#experiments').hidden = name !== 'experiments';
  if (name === 'experiments') app.views.experiments.mount($('#experiments')); else { app.views.experiments.unmount(); setTimeout(resizeAll, 30); }
}

function buildPanel() {
  const stims = $('#stims');
  for (const [group, names] of app.cfg.stimuli) {
    const g = document.createElement('div'); g.className = 'stim-group';
    g.innerHTML = `<div class="g">${group}</div><div class="chips"></div>`;
    const chips = g.querySelector('.chips');
    for (const name of names) {
      const alias = app.cfg.aliases.find((a) => a.name === name);
      const sides = name === 'steer' ? ['L', 'R'] : [null];
      for (const side of sides) {
        const c = document.createElement('span'); c.className = 'chip';
        c.dataset.group = name; if (side) c.dataset.side = side;
        const label = side ? (side === 'L' ? '◀ steer L' : 'steer R ▶') : name.replace('type:', '');
        c.innerHTML = `${label} <span class="n">${alias ? (side ? Math.round(alias.n / 2) : alias.n) : ''}</span>`;
        c.title = alias ? alias.note : name;
        c.onclick = () => {
          if (app.navigation?.busy) { app.toast('Stop the trial before changing stimuli.'); return; }
          const key = name + (side ? ':' + side : '');
          const on = !(key in app.drives);
          app.send({ cmd: 'drive', group: name, side, rate: on ? +$('#rate').value : 0 });
        };
        c.onmouseenter = async () => { const idx = await app.group(name, side); app.views.brain.highlight && app.views.brain.highlight(idx); };
        c.onmouseleave = () => { app.views.brain.highlight && app.views.brain.highlight(null); };
        chips.appendChild(c);
      }
    }
    stims.appendChild(g);
  }
  const ro = $('#readouts');
  for (const [key, [label, max]] of Object.entries(READOUT_META)) {
    const d = document.createElement('div'); d.className = 'readout'; d.dataset.key = key; d.dataset.max = max;
    d.innerHTML = `<span class="name">${label}</span><div class="bar"><i></i></div><span class="val mono">0</span>`;
    ro.appendChild(d);
  }
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  app.ws = ws;
  ws.onclose = () => { $('#st-eng').textContent = 'disconnected'; $('#connection').textContent = 'Reconnecting…'; if (app.navigation?.busy) app.navigation.stop('Connection lost. Stopped safely; wait for reconnection.'); setTimeout(connect, 1500); };
  ws.onopen = () => { $('#connection').textContent = '● Connected'; };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const m = JSON.parse(ev.data);
      if (m.error) app.toast('⚠ ' + m.error);
      if (m.event === 'reset') { app.resetSerial = (app.resetSerial || 0) + 1; app.ema = {}; }
      if (m.hello) { app.drives = m.drives || {}; $('#fix').checked = !!m.fix; $('#st-eng').textContent = m.sim.graph ? `CUDA graph · ${m.sim.graph_kind}` : m.sim.device; }
      return;
    }
    const dv = new DataView(ev.data);
    const hl = dv.getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ev.data, 4, hl)));
    const idx = new Uint32Array(ev.data.slice(4 + hl));
    onFrame(header, idx);
  };
}

let frameCount = 0;
function onFrame(h, idx) {
  const now = performance.now();
  if (app.frame) {
    const dSim = h.t - app.frame.t, dWall = now - app.wallAt;
    if (dWall > 0 && dSim > 0 && dSim < 500) app.rt = 0.9 * app.rt + 0.1 * (dSim / dWall);   // ignore the jump on (re)connect
  }
  app.frame = h; app.simT = h.t; app.wallAt = now; app.drives = h.drives || {};
  const a = 1 - Math.exp(-h.tick_ms / 160);
  for (const [k, v] of Object.entries(h.rates)) app.ema[k] = (app.ema[k] || 0) + a * (v - (app.ema[k] || 0));
  app.spikes[app.spikesPos++ % app.spikes.length] = h.spikes / h.tick_ms;
  if (app.tab === 'lab') app.views.brain.onFrame(h, idx);
  if (++frameCount % 3 === 0) updateDom(h);
}

function updateDom(h) {
  $('#st-time').textContent = (h.t / 1000).toFixed(2) + ' s';
  $('#st-rt').textContent = app.rt.toFixed(2) + '×';
  $('#st-spk').textContent = Math.round(h.spikes * 1000 / h.tick_ms).toLocaleString();
  $('#st-act').textContent = h.active.toLocaleString();
  $('#btn-play').textContent = app.navigation?.state === 'paused' ? '▶ resume trial' : h.playing ? '⏸ pause' : '▶ play';
  if (document.activeElement !== $('#fix')) $('#fix').checked = !!h.fix;
  document.querySelectorAll('.chip').forEach((c) => {
    const key = c.dataset.group + (c.dataset.side ? ':' + c.dataset.side : '');
    c.classList.toggle('on', key in app.drives);
  });
  document.querySelectorAll('#readouts .readout').forEach((d) => {
    const v = app.ema[d.dataset.key] || 0, max = +d.dataset.max;
    d.querySelector('i').style.width = clamp(v / max, 0, 1) * 100 + '%';
    const extra = (d.dataset.key === 'kenyon' || d.dataset.key === 'descending') ? ` · ${h.active_n[d.dataset.key]}` : '';
    d.querySelector('.val').textContent = (v >= 10 ? Math.round(v) : v.toFixed(1)) + extra;
    d.classList.toggle('hot', v > 0.5);
  });
  $('#brain-sub').textContent = `${h.active.toLocaleString()} neurons firing · ${Math.round(h.spikes * 1000 / h.tick_ms).toLocaleString()} spikes/s`;
}

let lastLoop = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - lastLoop) / 1000); lastLoop = now;
  if (app.tab === 'lab') for (const k of ['map', 'brain', 'fly', 'eyes']) { const v = app.views[k]; if (k === 'brain' && !document.body.classList.contains('show-brain')) continue; if (v && v.render) v.render(dt); }
  drawSpark();
  requestAnimationFrame(loop);
}

function drawSpark() {
  const c = $('#spark'); const ctx = c.getContext('2d');
  const W = c.width = c.clientWidth * devicePixelRatio, H = c.height = 64 * devicePixelRatio;
  ctx.clearRect(0, 0, W, H);
  const n = app.spikes.length; let max = 50;
  for (let i = 0; i < n; i++) max = Math.max(max, app.spikes[i]);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const v = app.spikes[(app.spikesPos + i) % n];
    const x = (i / (n - 1)) * W, y = H - (v / max) * (H - 6) - 2;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = '#59d1ff'; ctx.lineWidth = 1.5 * devicePixelRatio; ctx.stroke();
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(89,209,255,0.35)'); g.addColorStop(1, 'rgba(89,209,255,0)');
  ctx.fillStyle = g; ctx.fill();
  ctx.fillStyle = '#8a93a6'; ctx.font = `${10 * devicePixelRatio}px JetBrains Mono`;
  ctx.fillText(Math.round(max) + ' /ms', 6 * devicePixelRatio, 12 * devicePixelRatio);
}

main().catch((e) => { console.error(e); app.toast('failed to start: ' + e.message, 8000); });
