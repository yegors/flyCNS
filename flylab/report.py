"""Tables and raster plots for simulation results."""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np
import pandas as pd
from rich.console import Console
from rich.table import Table

from .engine import Result

console = Console(legacy_windows=False, width=150)


def group_stats(res: Result, groups: dict[str, np.ndarray]) -> pd.DataFrame:
    rows = []
    for name, idx in groups.items():
        idx = np.asarray(idx)
        c = res.counts[idx] if len(idx) else np.zeros(0)
        rows.append(dict(group=name, neurons=len(idx), active=int((c > 0).sum()), spikes=int(c.sum()),
                         mean_hz=float(c.mean() * 1000 / res.duration_ms) if len(idx) else 0.0,
                         max_hz=float(c.max() * 1000 / res.duration_ms) if len(idx) else 0.0))
    return pd.DataFrame(rows)


def top_types(res: Result, atlas, k: int = 15, exclude=None) -> pd.DataFrame:
    """Most active cell types in a run, optionally excluding the neurons you drove."""
    df = pd.DataFrame({"type": atlas.m["type"].fillna("?").values,
                       "superclass": atlas.m["superclass"].fillna("?").values,
                       "nt": atlas.m["nt"].values, "spikes": res.counts})
    if exclude is not None and len(exclude):
        df = df.drop(index=np.asarray(exclude))
    df = df[df.spikes > 0]
    if df.empty:
        return pd.DataFrame(columns=["type", "spikes", "active_neurons", "superclass", "nt"])
    g = df.groupby("type").agg(spikes=("spikes", "sum"), active_neurons=("spikes", "size"),
                               superclass=("superclass", "first"), nt=("nt", "first"))
    return g.sort_values("spikes", ascending=False).head(k).reset_index()


def print_df(df: pd.DataFrame, title: str | None = None):
    t = Table(title=title, title_justify="left")
    for c in df.columns:
        t.add_column(str(c), justify="right" if df[c].dtype.kind in "if" else "left")
    for _, r in df.iterrows():
        t.add_row(*[f"{v:.1f}" if isinstance(v, float) else str(v) for v in r.values])
    console.print(t)


def raster(res: Result, groups: dict[str, np.ndarray], path: Path | str, title: str | None = None,
           max_per_group: int = 60, min_rows: int = 5):
    """One band per group; within a band the most active neurons, one row each."""
    bands = []
    for name, idx in groups.items():
        idx = np.asarray(idx)
        if len(idx) == 0:
            continue
        c = res.counts[idx]
        sel = idx[np.argsort(-c, kind="stable")[:max_per_group]]
        bands.append((name, idx, sel, int(c.sum())))
    total_rows = sum(max(len(b[2]), min_rows) for b in bands) or 1
    fig, ax = plt.subplots(figsize=(11, max(2.8, 0.085 * total_rows + 1.4)))
    y0 = 0
    yticks, ylabels = [], []
    colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]
    for k, (name, idx, sel, spikes) in enumerate(bands):
        rows = max(len(sel), min_rows)
        pad = (rows - len(sel)) / 2
        pos = {int(n): i + pad for i, n in enumerate(sel)}
        t, i = res.spikes_of(sel)
        ax.scatter(t, [y0 + pos[int(n)] for n in i], s=6, marker="|", linewidths=0.9, color=colors[k % len(colors)])
        yticks.append(y0 + (rows - 1) / 2)
        ylabels.append(f"{name}\n{len(idx)} neurons, {spikes} spikes")
        y0 += rows
        ax.axhline(y0 - 0.5, color="0.85", lw=0.8)
    ax.set_yticks(yticks)
    ax.set_yticklabels(ylabels, fontsize=8)
    ax.set_ylim(-0.5, y0 - 0.5 if y0 else 0.5)
    ax.set_xlim(0, res.duration_ms)
    ax.set_xlabel("time (ms)")
    if title:
        ax.set_title(title, fontsize=10, loc="left")
    fig.tight_layout()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=130)
    plt.close(fig)
    return str(path)


def save_json(obj, path: Path | str):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, default=_jsonable)
    return str(path)


def _jsonable(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, pd.DataFrame):
        return o.to_dict(orient="records")
    return str(o)
