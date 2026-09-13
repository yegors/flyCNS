const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1)) : String(v ?? ''));

function table(rows) {
  if (!rows || !rows.length) return '';
  const cols = Object.keys(rows[0]);
  return `<table class="data"><thead><tr>${cols.map((c) => `<th>${c.replace(/_/g, ' ')}</th>`).join('')}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${cols.map((c) => `<td>${fmt(r[c])}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
}

const DOCS = {
  sugar: 'A fly extends its proboscis when it tastes sugar and not when it tastes bitter. Shiu et al. 2024 showed the connectome model reproduces this; it is the standard first test that a whole-brain fly model is wired correctly. Readout: the proboscis motor neuron MN9.',
  looming: 'Fast-expanding objects excite LC4 and LPLC2, which drive the giant fiber, the command neuron for the escape jump. With the nerve cord in this dataset the command can be followed to the wing motor neurons that power takeoff.',
  runaway: 'About half of all trials fall into a runaway state where 8% of the brain fires whatever the stimulus, led by Kenyon cells and antennal-lobe local neurons the data labels excitatory. Forcing those 151 neurons inhibitory, as in the real fly, removes it.',
};

export class ExperimentsView {
  constructor(app) { this.app = app; this.active = false; this.polls = new Map(); }
  async mount(el) { this.el = el; this.active = true; el.innerHTML = ''; this.wrap = document.createElement('div'); el.appendChild(this.wrap); await this.list(); }
  unmount() { this.active = false; for (const t of this.polls.values()) clearInterval(t); this.polls.clear(); }

  async list() {
    const items = await (await fetch('/api/experiments')).json();
    const named = items.filter((i) => i.experiment), adhoc = items.filter((i) => !i.experiment);
    this.wrap.innerHTML = `<h2 style="margin:0 0 4px">Experiments</h2><div class="sub muted" style="margin-bottom:14px">${named.length} named experiments, ${adhoc.length} ad-hoc runs · <span class="mono">results/</span></div>` +
      `<div class="exp-grid">${named.map((i) => this.card(i)).join('')}</div>` +
      (adhoc.length ? `<h3 class="muted" style="margin:26px 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.8px">Ad-hoc stimulations</h3><div class="exp-grid">${adhoc.map((i) => this.card(i)).join('')}</div>` : '');
    this.wrap.querySelectorAll('.card').forEach((c) => (c.onclick = () => this.detail(c.dataset.name)));
  }
  card(i) {
    const badge = i.running ? '<span class="badge run">running</span>' : i.passed === true ? '<span class="badge pass">pass</span>' : i.passed === false ? '<span class="badge fail">fail</span>' : '';
    const sub = i.experiment ? `${(i.seeds || []).length || 1} seed${(i.seeds || []).length === 1 ? '' : 's'} · ${i.ms || 1000} ms` : `drive ${(i.targets || []).join(', ')}`;
    return `<div class="card" data-name="${i.name}"><h4>${i.name} ${badge}</h4><p>${i.summary || sub}</p><p class="muted" style="margin-top:6px">${sub} · ${new Date(i.modified * 1000).toLocaleString()}</p>` +
      `<div class="thumbs">${(i.images || []).slice(0, 4).map((s) => `<img src="${s}" loading="lazy">`).join('')}</div></div>`;
  }
  async detail(name) {
    const [d, meta] = await Promise.all([(await fetch(`/api/experiments/${name}`)).json(), (await fetch('/api/experiments')).json()]);
    const info = meta.find((m) => m.name === name) || {};
    const passed = d.passed === true ? '<span class="badge pass">pass</span>' : d.passed === false ? '<span class="badge fail">fail</span>' : '';
    const canRun = ['sugar', 'looming', 'runaway'].includes(name);
    this.wrap.innerHTML = `<div class="exp-detail"><button class="small" id="back">← all experiments</button>
      <h2 style="margin-top:14px">${name} ${passed} ${canRun ? `<button class="small primary" id="rerun" style="margin-left:auto">▶ run again</button>` : ''}</h2>
      <div class="sub">${d.summary || ''}</div>
      ${DOCS[name] ? `<p class="doc">${DOCS[name]}</p>` : ''}
      ${d.table ? `<h3 class="muted small" style="text-transform:uppercase;letter-spacing:.8px">Summary${d.seeds ? ` · mean over seeds ${d.seeds.join(', ')}` : ''}</h3>${table(d.table)}` : ''}
      ${d.groups ? table(d.groups) : ''}
      ${d.runs ? `<details><summary class="muted small" style="cursor:pointer">per-run table (${d.runs.length} runs)</summary>${table(d.runs)}</details>` : ''}
      <div id="runlog"></div>
      <h3 class="muted small" style="text-transform:uppercase;letter-spacing:.8px;margin-top:18px">Rasters</h3>
      <div class="imgs">${(info.images || []).map((s) => `<figure><img src="${s}" loading="lazy"><figcaption>${s.split('/').pop()}</figcaption></figure>`).join('')}</div>
      ${d.params ? `<details style="margin-top:16px"><summary class="muted small" style="cursor:pointer">model parameters</summary><pre class="log">${JSON.stringify(d.params, null, 2)}</pre></details>` : ''}
    </div>`;
    this.wrap.querySelector('#back').onclick = () => this.list();
    const rr = this.wrap.querySelector('#rerun');
    if (rr) rr.onclick = async () => { await fetch(`/api/experiments/${name}/run`, { method: 'POST' }); rr.textContent = 'running…'; rr.disabled = true; this.poll(name); };
    if (info.running) this.poll(name);
  }
  poll(name) {
    if (this.polls.has(name)) return;
    const tick = async () => {
      const s = await (await fetch(`/api/experiments/${name}/status`)).json();
      const box = this.wrap.querySelector('#runlog');
      if (box) box.innerHTML = `<h3 class="muted small" style="text-transform:uppercase;letter-spacing:.8px">${s.running ? 'running on the GPU…' : 'finished'}</h3><pre class="log">${(s.log || '').replace(/</g, '&lt;')}</pre>`;
      if (!s.running) { clearInterval(this.polls.get(name)); this.polls.delete(name); if (this.active) setTimeout(() => this.detail(name), 800); }
    };
    this.polls.set(name, setInterval(tick, 2000)); tick();
  }
}
