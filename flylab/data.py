"""Load the MaleCNS v1.0 flat-connectome files and build a signed, indexed brain.

Files (CC-BY 4.0, HHMI Janelia / Google Research), expected in data/:
  annotations.feather        body-annotations-male-cns-v1.0-minconf-0.5.feather   (14 MB)
  neurotransmitters.feather  body-neurotransmitters-male-cns-v1.0.feather         (43 MB)
  weights.feather            connectome-weights-male-cns-v1.0-minconf-0.5.feather (1.05 GB)
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.feather as feather

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("FLYLAB_DATA", ROOT / "data"))
CACHE_DIR = DATA_DIR / "cache"

BUCKET = "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome"
FILES = {
    "annotations": ("annotations.feather", "body-annotations-male-cns-v1.0-minconf-0.5.feather"),
    "neurotransmitters": ("neurotransmitters.feather", "body-neurotransmitters-male-cns-v1.0.feather"),
    "weights": ("weights.feather", "connectome-weights-male-cns-v1.0-minconf-0.5.feather"),
}

META_COLS = ["bodyId", "type", "class", "superclass", "subclass", "somaSide", "rootSide",
             "somaNeuromere", "dimorphism", "fruDsx", "flywireType", "hemibrainType", "synonyms", "somaLocation",
             "assignedOlHex1", "assignedOlHex2"]
VOXEL_UM = 0.008  # somaLocation is in 8 nm voxels


def nt_sign(label) -> int:
    """Sign convention after Shiu et al. 2024 (Nature): acetylcholine excitatory; GABA and
    glutamate inhibitory (glutamate gates GluCl-alpha in the fly CNS); histamine inhibitory
    (photoreceptor -> lamina); monoamines treated as excitatory; unknown -> 0 (no effect)."""
    s = str(label).lower()
    if "acetyl" in s:
        return 1
    if "gaba" in s or "glut" in s or "hist" in s:
        return -1
    if "dopa" in s or "sero" in s or "octop" in s:
        return 1
    return 0


@dataclass
class Brain:
    meta: pd.DataFrame      # one row per neuron, positional index 0..N-1
    indptr: np.ndarray      # [N+1] int64, CSR grouped by presynaptic neuron
    post: np.ndarray        # [E] int64 postsynaptic neuron index
    count: np.ndarray       # [E] int32 synapse count
    min_weight: int

    @property
    def n(self) -> int:
        return len(self.meta)

    @property
    def n_edges(self) -> int:
        return len(self.post)

    @property
    def n_synapses(self) -> int:
        return int(self.count.sum())

    def pre(self) -> np.ndarray:
        return np.repeat(np.arange(self.n), np.diff(self.indptr))

    def index_of(self, body_ids) -> np.ndarray:
        lut = pd.Series(np.arange(self.n), index=self.meta["bodyId"].values)
        return lut.reindex(np.asarray(body_ids)).dropna().astype(int).values

    def out_edges(self, i: int):
        a, b = self.indptr[i], self.indptr[i + 1]
        return self.post[a:b], self.count[a:b]


def missing_files() -> list[str]:
    return [local for local, _ in FILES.values() if not (DATA_DIR / local).exists()]


def download_cmd() -> str:
    lines = [f'mkdir -p "{DATA_DIR}"']
    for local, remote in FILES.values():
        lines.append(f'curl -L -o "{DATA_DIR / local}" {BUCKET}/{remote}')
    return "\n".join(lines)


def build_brain(min_weight: int = 5, verbose: bool = True) -> Brain:
    t0 = time.time()
    log = print if verbose else (lambda *a, **k: None)
    if missing_files():
        raise FileNotFoundError(
            f"Missing {missing_files()} in {DATA_DIR}. Fetch with:\n{download_cmd()}")

    ann = feather.read_table(DATA_DIR / FILES["annotations"][0]).to_pandas()
    ann = ann[ann["status"] == "Traced"].sort_values("bodyId").reset_index(drop=True)
    meta = ann[[c for c in META_COLS if c in ann.columns]].copy()
    # sensory somas sit outside the imaged volume; their laterality is rootSide
    side = meta["somaSide"].fillna(meta["rootSide"]).fillna("?")
    meta["side"] = side.where(side.isin(["L", "R", "M"]), "?")
    n = len(meta)
    log(f"[data] {n:,} traced neurons ({time.time() - t0:.1f}s)")

    nt = feather.read_table(DATA_DIR / FILES["neurotransmitters"][0],
                            columns=["body", "consensus_nt"]).to_pandas()
    nt = nt.drop_duplicates("body").set_index("body")["consensus_nt"]
    meta["nt"] = nt.reindex(meta["bodyId"].values).fillna("unclear").values
    meta["sign"] = meta["nt"].map(nt_sign).astype(np.int8)
    log(f"[data] transmitter labels: {meta['nt'].value_counts().to_dict()}")

    w = feather.read_table(DATA_DIR / FILES["weights"][0]).to_pandas()
    w = w[w["weight"] >= min_weight]
    lut = pd.Series(np.arange(n), index=meta["bodyId"].values)
    pre = lut.reindex(w["body_pre"].values).values
    post = lut.reindex(w["body_post"].values).values
    ok = ~np.isnan(pre) & ~np.isnan(post)
    pre = pre[ok].astype(np.int64)
    post = post[ok].astype(np.int64)
    cnt = w["weight"].values[ok].astype(np.int32)
    order = np.lexsort((post, pre))
    pre, post, cnt = pre[order], post[order], cnt[order]
    indptr = np.zeros(n + 1, dtype=np.int64)
    np.cumsum(np.bincount(pre, minlength=n), out=indptr[1:])
    log(f"[data] {len(post):,} edges (>= {min_weight} synapses), {int(cnt.sum()):,} synapses "
        f"({time.time() - t0:.1f}s)")
    return Brain(meta=meta, indptr=indptr, post=post, count=cnt, min_weight=min_weight)


def cache_paths(min_weight: int):
    return CACHE_DIR / f"brain_w{min_weight}.npz", CACHE_DIR / f"meta_w{min_weight}.feather"


def neuron_positions(brain: Brain, verbose: bool = True) -> np.ndarray:
    """[N, 3] float32 positions in micrometres. Neurons whose soma lies outside the imaged volume
    (sensory neurons) are placed at the synapse-weighted centroid of their partners' somas."""
    path = CACHE_DIR / f"positions_w{brain.min_weight}.npy"
    if path.exists():
        return np.load(path)
    if "somaLocation" not in brain.meta.columns:
        raise RuntimeError("cache built without somaLocation; run `flylab prepare --rebuild`")
    n = brain.n
    pos = np.full((n, 3), np.nan, dtype=np.float32)
    loc = brain.meta["somaLocation"]
    has = loc.notna().values
    pos[has] = np.stack([np.asarray(v, dtype=np.float32) for v in loc[has]]) * VOXEL_UM
    pre, post, cnt = brain.pre(), brain.post, brain.count.astype(np.float64)
    for _ in range(3):
        miss = np.isnan(pos[:, 0])
        if not miss.any():
            break
        for src, dst in ((pre, post), (post, pre)):
            sel = miss[src] & ~np.isnan(pos[dst, 0])
            acc = np.zeros((n, 3))
            wsum = np.zeros(n)
            np.add.at(acc, src[sel], pos[dst[sel]] * cnt[sel, None])
            np.add.at(wsum, src[sel], cnt[sel])
            ok = miss & (wsum > 0)
            pos[ok] = (acc[ok] / wsum[ok, None]).astype(np.float32)
            miss = np.isnan(pos[:, 0])
    still = np.isnan(pos[:, 0])
    pos[still] = np.nanmean(pos, axis=0)
    if verbose:
        print(f"[data] positions: {int(has.sum()):,} somas, {int((~has).sum() - still.sum()):,} placed by partners, "
              f"{int(still.sum())} at centre")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    np.save(path, pos)
    return pos


def retina_map(brain: Brain, verbose: bool = True) -> pd.DataFrame:
    """One row per traced R1-R6 photoreceptor: idx, side, az, el (degrees), column hex coords.

    Photoreceptor somas lie in the retina, outside the volume, and carry no column label, so each
    photoreceptor takes the column of its strongest lamina target (L1/L2/L3). Columns are placed in
    visual space from the lamina somas: elevation follows the dorsal-ventral axis (y), azimuth the
    principal axis of the lamina sheet in the horizontal plane, with the medial end taken as frontal.
    Azimuth is 0 straight ahead, positive to the right; the left eye has negative azimuths."""
    path = CACHE_DIR / f"retina_w{brain.min_weight}.feather"
    if path.exists():
        return feather.read_feather(path)
    m = brain.meta
    if "assignedOlHex1" not in m.columns:
        raise RuntimeError("cache built without column labels; run `flylab prepare --rebuild`")
    types = m["type"].fillna("")
    hex_ok = m["assignedOlHex1"].notna().values
    is_r = types.eq("R1-R6").values
    is_lam = types.isin(["L1", "L2", "L3"]).values & hex_ok
    pre, post, cnt = brain.pre(), brain.post, brain.count
    sel = is_r[pre] & is_lam[post]
    pairs = pd.DataFrame({"r": pre[sel], "l": post[sel], "c": cnt[sel]}).sort_values("c", ascending=False).drop_duplicates("r")
    h1 = m["assignedOlHex1"].values.astype(float)
    h2 = m["assignedOlHex2"].values.astype(float)
    root = m["rootSide"].values
    soma_side = m["somaSide"].values
    out = pd.DataFrame({"idx": pairs.r.values.astype(np.int64), "h1": h1[pairs.l.values], "h2": h2[pairs.l.values]})
    out["side"] = [s if s in ("L", "R") else soma_side[l] for s, l in zip(root[pairs.r.values], pairs.l.values)]
    out["az"] = 0.0
    out["el"] = 0.0
    for s in ("L", "R"):
        lam = (types == "L1").values & hex_ok & m["somaLocation"].notna().values & (m["somaSide"] == s).values
        xyz = np.stack([np.asarray(v, dtype=float) for v in m.loc[lam, "somaLocation"]]) * VOXEL_UM
        A = np.c_[h1[lam], h2[lam], np.ones(lam.sum())]
        coef = np.linalg.lstsq(A, xyz, rcond=None)[0]          # hex -> (x, y, z) of the lamina sheet
        fit = A @ coef
        xz = fit[:, [0, 2]] - fit[:, [0, 2]].mean(0)
        axis = np.linalg.svd(xz, full_matrices=False)[2][0]     # principal horizontal axis of the sheet
        if np.dot(axis, [np.sign(fit[:, 0].mean()), 0]) < 0:   # orient so + points lateral (posterior)
            axis = -axis
        proj_all = xz @ axis
        rows = (out["side"] == s).values
        B = np.c_[out.h1.values[rows], out.h2.values[rows], np.ones(rows.sum())]
        f = B @ coef
        proj = (f[:, [0, 2]] - fit[:, [0, 2]].mean(0)) @ axis
        az = (proj - proj_all.min()) / max(np.ptp(proj_all), 1e-6) * 175 - 10
        el = -(f[:, 1] - fit[:, 1].mean()) / max(np.ptp(fit[:, 1]) / 2, 1e-6) * 60
        out.loc[rows, "az"] = np.clip(az, -15, 170) * (1 if s == "R" else -1)
        out.loc[rows, "el"] = np.clip(el, -70, 70)
    out = out.reset_index(drop=True)
    if verbose:
        print(f"[data] retina: {len(out)} R1-R6 photoreceptors mapped to columns "
              f"({(out.side == 'L').sum()} left, {(out.side == 'R').sum()} right)")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    feather.write_feather(out, path)
    return out


def load_brain(min_weight: int = 5, verbose: bool = True, rebuild: bool = False) -> Brain:
    """Load the brain, building and caching it (data/cache/) on first use."""
    npz, metaf = cache_paths(min_weight)
    if not rebuild and npz.exists() and metaf.exists():
        z = np.load(npz)
        meta = feather.read_feather(metaf)
        b = Brain(meta=meta, indptr=z["indptr"], post=z["post"], count=z["count"], min_weight=min_weight)
        if verbose:
            print(f"[data] cache {npz.name}: {b.n:,} neurons, {b.n_edges:,} edges, {b.n_synapses:,} synapses")
        return b
    b = build_brain(min_weight, verbose)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    np.savez(npz, indptr=b.indptr, post=b.post, count=b.count)
    feather.write_feather(b.meta, metaf)
    return b
