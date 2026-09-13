"""GPU leaky integrate-and-fire engine for the whole male CNS.

Model and constants follow Shiu et al. 2024 (Nature), "A leaky integrate-and-fire computational
model based on the connectome of the entire adult Drosophila brain":

    dv/dt = (v_rest - v + g) / tau_m     (unless refractory)
    dg/dt = -g / tau_syn                 (unless refractory)
    spike when v >= v_th; then v = v_reset, g = 0; refractory 2.2 ms
    presynaptic spike -> g_post += sign * n_synapses * 0.275 mV, after a 1.8 ms delay
    "activated" neurons receive Poisson events (default 150 Hz) of 250 * 0.275 mV, no refractory period

Integration is exact for the linear system (Brian2 method='linear'). The network is silent at rest
by design: there is no background noise, so nothing fires until you drive something.

Implementation: all state lives in preallocated GPU tensors and the simulation clock is a device
scalar, so a chunk of `chunk` steps (default 100 = 10 ms) is captured once in a CUDA graph and
replayed with a single launch. Propagation is one sparse matrix-vector product per step (CSR,
rows = postsynaptic). Spikes are recorded per chunk without host syncs inside the step.
"""
from __future__ import annotations

import math
import time
import warnings
from dataclasses import dataclass, asdict

import numpy as np
import torch

from .data import Brain

warnings.filterwarnings("ignore", message="Sparse CSR tensor support is in beta")
warnings.filterwarnings("ignore", message="Sparse invariant checks are implicitly disabled")


@dataclass
class Params:
    dt: float = 0.1              # ms
    v_rest: float = -52.0        # mV
    v_reset: float = -52.0       # mV
    v_th: float = -45.0          # mV
    tau_m: float = 20.0          # ms
    tau_syn: float = 5.0         # ms
    t_refrac: float = 2.2        # ms
    delay: float = 1.8           # ms
    w_syn: float = 0.275         # mV per synapse
    poisson_rate: float = 150.0  # Hz, default drive for activated neurons
    poisson_gain: float = 250.0  # each Poisson event adds w_syn * gain to g
    brian2_delay_offset: bool = True  # Brian2 delivers spikes after the state update: +1 step of delay


@dataclass
class Result:
    dt: float
    steps: int
    times: np.ndarray    # spike times, ms
    idx: np.ndarray      # spiking neuron index, aligned with times
    counts: np.ndarray   # spikes per neuron over the run
    wall_s: float = 0.0

    @property
    def duration_ms(self) -> float:
        return self.steps * self.dt

    @property
    def n_spikes(self) -> int:
        return len(self.idx)

    def rate_hz(self, idx=None) -> np.ndarray:
        c = self.counts if idx is None else self.counts[np.asarray(idx)]
        return c * 1000.0 / self.duration_ms

    def spikes_of(self, idx):
        m = np.isin(self.idx, np.asarray(idx))
        return self.times[m], self.idx[m]

    def active(self) -> np.ndarray:
        return np.nonzero(self.counts)[0]


class Sim:
    def __init__(self, brain: Brain, params: Params | None = None, device: str | None = None,
                 seed: int | None = 0, chunk: int = 100, use_graph: bool = True):
        self.brain = brain
        self.p = p = params or Params()
        self.seed = seed  # reset() re-seeds, so every condition starts from the same random state
        self.K = chunk
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
        dev = self.device
        n = self.n = brain.n

        # ---- connectome as CSR by postsynaptic neuron (for W @ spikes)
        indptr = torch.as_tensor(brain.indptr, device=dev)
        self.edge_pre = torch.repeat_interleave(torch.arange(n, device=dev), torch.diff(indptr))
        self.edge_post = torch.as_tensor(brain.post, device=dev)
        self.edge_count = torch.as_tensor(brain.count, device=dev).float()
        self.sign = torch.as_tensor(brain.meta["sign"].values.astype(np.float32), device=dev)
        self.w0 = self.sign[self.edge_pre] * self.edge_count * p.w_syn
        self.w = self.w0.clone()
        self.perm = torch.argsort(self.edge_post * n + self.edge_pre)
        self.rows = self.edge_post[self.perm]
        self.cols = self.edge_pre[self.perm]
        self.crow = torch.zeros(n + 1, dtype=torch.int64, device=dev)
        self.crow[1:] = torch.cumsum(torch.bincount(self.rows, minlength=n), 0)
        self.W_vals = self.w[self.perm].clone()
        self.W = torch.sparse_csr_tensor(self.crow, self.cols, self.W_vals, size=(n, n))

        # ---- constants
        self.k_m = math.exp(-p.dt / p.tau_m)
        self.k_s = math.exp(-p.dt / p.tau_syn)
        self.k_g = p.tau_syn / (p.tau_syn - p.tau_m) * (self.k_s - self.k_m)
        self.delay_steps = int(round(p.delay / p.dt)) + (1 if p.brian2_delay_offset else 0)
        self.D = self.delay_steps + 1
        self.rfc_default = int(round(p.t_refrac / p.dt))
        self.p_scale = p.dt / 1000.0
        self.drive_amp = p.w_syn * p.poisson_gain

        # ---- state, allocated once (CUDA graphs need stable addresses)
        self.v = torch.empty(n, device=dev)
        self.g = torch.empty(n, device=dev)
        self.ref_until = torch.empty(n, dtype=torch.int64, device=dev)
        self.rfc = torch.empty(n, dtype=torch.int64, device=dev)
        self.buf = torch.empty(self.D, n, device=dev)
        self.counts = torch.empty(n, dtype=torch.int32, device=dev)
        self.hist = torch.empty(self.K, n, dtype=torch.bool, device=dev)
        self.drive_rate = torch.empty(n, device=dev)
        self.hold = torch.zeros(n, device=dev)   # tonic depolarisation target above rest, mV (model config, survives reset)
        self.t_dev = torch.zeros((), dtype=torch.int64, device=dev)
        self._zero_state()

        self._propagate = self._propagate_spmm
        self.graph = None
        self.graph_kind = "none"
        self.capture_error = None
        if use_graph and dev.type == "cuda":
            self.graph = self._capture()
        self.reset()

    # ------------------------------------------------------------------ state
    def _zero_state(self):
        self.v.fill_(self.p.v_rest)
        self.g.zero_()
        self.ref_until.zero_()
        self.rfc.fill_(self.rfc_default)
        self.buf.zero_()
        self.counts.zero_()
        self.hist.zero_()
        self.drive_rate.zero_()
        self.t_dev.zero_()

    def reset(self):
        if self.seed is not None:
            torch.manual_seed(self.seed)
        self._zero_state()
        self.w.copy_(self.w0)
        self._sync_W()
        self.t = 0
        self._log_t, self._log_i = [], []
        self.record = True
        return self

    def _sync_W(self):
        self.W_vals.copy_(self.w[self.perm])

    def _idx(self, idx) -> torch.Tensor:
        if isinstance(idx, torch.Tensor):
            return idx.to(device=self.device, dtype=torch.int64).ravel()
        return torch.as_tensor(np.asarray(idx, dtype=np.int64).ravel(), device=self.device)

    # ---------------------------------------------------------- manipulations
    def drive(self, idx, rate_hz: float | None = None):
        """Activate neurons with Poisson input at rate_hz (default 150). rate 0 switches them off."""
        idx = self._idx(idx)
        rate = self.p.poisson_rate if rate_hz is None else float(rate_hz)
        self.drive_rate[idx] = rate
        self.rfc[idx] = 0 if rate > 0 else self.rfc_default
        return self

    def set_rates(self, idx, rates_hz):
        """Per-neuron Poisson drive rates (Hz) for the given neurons, e.g. a retina image."""
        idx = self._idx(idx)
        r = torch.as_tensor(np.asarray(rates_hz, dtype=np.float32), device=self.device) if not isinstance(rates_hz, torch.Tensor) \
            else rates_hz.to(self.device, torch.float32)
        self.drive_rate[idx] = r
        self.rfc[idx] = torch.where(r > 0, torch.zeros_like(self.rfc[idx]), torch.full_like(self.rfc[idx], self.rfc_default))
        return self

    def set_hold(self, idx, mv: float):
        """Tonic depolarisation of the given neurons by mv above rest (threshold is 7 mV above rest).
        Used to keep graded, non-spiking cells such as lamina neurons near threshold."""
        self.hold[self._idx(idx)] = float(mv)
        return self

    def clear_hold(self):
        self.hold.zero_()
        return self

    def clear_drive(self):
        self.drive_rate.zero_()
        self.rfc.fill_(self.rfc_default)
        return self

    def silence(self, idx):
        """Remove all output of the given neurons (the model's version of silencing)."""
        m = torch.isin(self.edge_pre, self._idx(idx))
        self.w[m] = 0.0
        self._sync_W()
        return self

    def set_sign(self, idx, sign: float):
        """Override the transmitter sign of the given neurons' output (+1 excitatory, -1 inhibitory, 0 none)."""
        m = torch.isin(self.edge_pre, self._idx(idx))
        self.w[m] = sign * self.edge_count[m] * self.p.w_syn
        self._sync_W()
        return self

    def scale_synapses(self, pre_idx, post_idx, factor: float) -> int:
        """Multiply weights of edges pre->post (for plasticity experiments). Returns edges touched."""
        m = torch.isin(self.edge_pre, self._idx(pre_idx)) & torch.isin(self.edge_post, self._idx(post_idx))
        self.w[m] *= factor
        self._sync_W()
        return int(m.sum())

    def restore(self):
        self.w.copy_(self.w0)
        self._sync_W()
        return self

    # --------------------------------------------------------------- dynamics
    def _propagate_spmm(self, spk_f: torch.Tensor) -> torch.Tensor:
        return torch.sparse.mm(self.W, spk_f.unsqueeze(1)).squeeze(1)

    def _propagate_gather(self, spk_f: torch.Tensor) -> torch.Tensor:
        out = torch.zeros(self.n, device=self.device)
        return out.index_add_(0, self.rows, self.W_vals * spk_f[self.cols])

    def _core(self):
        """One 0.1 ms step. No Python-side state, no host syncs: capturable in a CUDA graph."""
        p, t = self.p, self.t_dev
        v, g = self.v, self.g
        slot = torch.remainder(t, self.D).view(1)
        g += self.buf.index_select(0, slot).squeeze(0)
        self.buf.index_fill_(0, slot, 0.0)
        ev = torch.rand(self.n, device=self.device) < self.drive_rate * self.p_scale
        g += ev.float() * self.drive_amp
        active = self.ref_until <= t
        base = p.v_rest + self.hold
        v.copy_(torch.where(active, base + (v - base) * self.k_m + g * self.k_g, v))
        g.copy_(torch.where(active, g * self.k_s, g))
        spk = active & (v >= p.v_th)
        v.masked_fill_(spk, p.v_reset)
        g.masked_fill_(spk, 0.0)
        self.ref_until.copy_(torch.where(spk, t + 1 + self.rfc, self.ref_until))
        self.counts += spk
        inp = self._propagate(spk.float())
        self.buf.index_add_(0, torch.remainder(t + self.delay_steps, self.D).view(1), inp.unsqueeze(0))
        self.hist.index_copy_(0, torch.remainder(t, self.K).view(1), spk.unsqueeze(0))
        t.add_(1)

    def _capture(self):
        for prop in (self._propagate_spmm, self._propagate_gather):
            self._propagate = prop
            try:
                s = torch.cuda.Stream()
                s.wait_stream(torch.cuda.current_stream())
                with torch.cuda.stream(s):
                    for _ in range(3):
                        self._core()
                torch.cuda.current_stream().wait_stream(s)
                graph = torch.cuda.CUDAGraph()
                with torch.cuda.graph(graph):
                    for _ in range(self.K):
                        self._core()
                torch.cuda.synchronize()
                self.graph_kind = prop.__name__.replace("_propagate_", "")
                return graph
            except Exception as e:  # capture is best effort; fall back to eager stepping
                self.capture_error = f"{prop.__name__}: {type(e).__name__}: {e}"
                try:
                    torch.cuda.synchronize()
                except Exception:
                    pass
        self._propagate = self._propagate_spmm
        return None

    def step(self):
        self._core()
        self.t += 1

    def tick(self) -> torch.Tensor:
        """Advance one chunk (K steps). Returns a bool [N] device tensor: which neurons spiked in it."""
        t_start = self.t
        if self.graph is not None:
            self.graph.replay()
        else:
            for _ in range(self.K):
                self._core()
        self.t += self.K
        spiked = self.hist.any(0)
        if self.record:
            self._flush(t_start, self.K)
        else:
            self.hist.zero_()
        return spiked

    def _flush(self, t_start: int, nsteps: int):
        nz = self.hist.nonzero()
        if nz.numel():
            rel = torch.remainder(nz[:, 0] - (t_start % self.K), self.K)
            self._log_t.append(t_start + rel)
            self._log_i.append(nz[:, 1])
        self.hist.zero_()

    def run(self, ms: float, record: bool = True, verbose: bool = False) -> Result:
        self.record = record
        steps = int(round(ms / self.p.dt))
        t0 = time.time()
        full, rem = divmod(steps, self.K)
        for _ in range(full):
            self.tick()
        if rem:
            t_start = self.t
            for _ in range(rem):
                self._core()
            self.t += rem
            if record:
                self._flush(t_start, rem)
            else:
                self.hist.zero_()
        if self.device.type == "cuda":
            torch.cuda.synchronize()
        wall = time.time() - t0
        if verbose:
            print(f"[sim] {ms:.0f} ms biological in {wall:.2f}s wall "
                  f"({ms / 1000 / wall:.2f}x real time, {int(self.counts.sum()):,} spikes)")
        r = self.result()
        r.wall_s = wall
        return r

    def result(self) -> Result:
        if self._log_t:
            t = torch.cat(self._log_t).cpu().numpy() * self.p.dt
            i = torch.cat(self._log_i).cpu().numpy()
        else:
            t, i = np.zeros(0), np.zeros(0, dtype=np.int64)
        return Result(dt=self.p.dt, steps=self.t, times=t, idx=i, counts=self.counts.cpu().numpy())

    def params_dict(self) -> dict:
        return asdict(self.p)

    def status(self) -> dict:
        return dict(device=str(self.device), graph=self.graph is not None, graph_kind=self.graph_kind,
                    capture_error=self.capture_error, chunk=self.K, n=self.n, edges=int(self.w.numel()))
