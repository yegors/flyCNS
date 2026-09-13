"""PoC 1: taste -> feeding.

A real fly extends its proboscis (its "tongue") when sugar touches its mouthparts, and does not
when it tastes bitter. Shiu et al. 2024 showed the connectome-based LIF model reproduces this:
activating sugar-sensing neurons makes the proboscis motor neuron MN9 fire. This is the standard
first test that a whole-brain fly model is wired up correctly.

Conditions (1 s each, driven neurons at 150 Hz, several random seeds):
  rest          nothing driven            -> the network must be silent
  sugar         LB3c sugar GRNs           -> MN9 should fire
  bitter        LB1a-d bitter GRNs        -> MN9 should stay quiet
  water         LB3a water GRNs           -> reported
  sugar+bitter  both                      -> bitter should reduce the sugar response
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .. import report
from ..engine import Sim

MS = 1000.0
SEEDS = (0, 1, 2)
RUNAWAY_SPIKES = 300_000   # runs above this have fallen into the global runaway state (see runaway.py)
READ = ["proboscis_mn", "feeding_mn", "giant_fiber", "kenyon"]
CONDITIONS = {
    "rest": [],
    "sugar": ["sugar"],
    "bitter": ["bitter"],
    "water": ["water"],
    "sugar+bitter": ["sugar", "bitter"],
}


def run(brain, atlas, out: Path, seeds=SEEDS) -> dict:
    sim = Sim(brain)
    read = atlas.groups(READ)
    rows, tops = [], {}
    for cond, drives in CONDITIONS.items():
        driven = {d: atlas.resolve(d) for d in drives}
        n_driven = int(sum(len(v) for v in driven.values()))
        for s in seeds:
            sim.seed = s
            sim.reset()
            for idx in driven.values():
                sim.drive(idx)
            res = sim.run(MS, verbose=True)
            st = report.group_stats(res, read).set_index("group")
            rows.append(dict(condition=cond, seed=s, driven=n_driven,
                             MN9_hz=st.loc["proboscis_mn", "mean_hz"],
                             feeding_mn_hz=st.loc["feeding_mn", "mean_hz"],
                             kenyon_active=int(st.loc["kenyon", "active"]),
                             active_neurons=int((res.counts > 0).sum()) - n_driven,
                             spikes=int(res.counts.sum()),
                             runaway=bool(res.counts.sum() > RUNAWAY_SPIKES)))
            if s == seeds[0]:
                excl = np.concatenate(list(driven.values())) if driven else np.zeros(0, dtype=int)
                tops[cond] = report.top_types(res, atlas, k=12, exclude=excl)
                report.raster(res, {**driven, **read}, out / f"sugar_{cond}.png",
                              title=f"taste -> feeding | {cond}: drive {drives or 'nothing'} at 150 Hz, seed {s}")
    runs = pd.DataFrame(rows)
    df = runs.groupby("condition", sort=False).agg(
        driven=("driven", "first"), MN9_hz=("MN9_hz", "mean"), MN9_min=("MN9_hz", "min"), MN9_max=("MN9_hz", "max"),
        feeding_mn_hz=("feeding_mn_hz", "mean"), kenyon_active=("kenyon_active", "mean"),
        active_neurons=("active_neurons", "mean"), spikes=("spikes", "mean"),
        runaway_runs=("runaway", "sum")).reset_index()
    df["runaway_runs"] = df["runaway_runs"].astype(str) + f"/{len(seeds)}"
    report.print_df(df, f"taste -> proboscis motor neuron MN9, mean over {len(seeds)} seeds (Hz)")
    report.print_df(tops["sugar"], "sugar (seed 0): most active downstream types")

    d = df.set_index("condition")
    rest_silent = d.loc["rest", "spikes"] == 0
    sugar_ok = d.loc["sugar", "MN9_hz"] >= 2.0
    bitter_ok = d.loc["bitter", "MN9_hz"] < 1.0
    suppress = d.loc["sugar+bitter", "MN9_hz"] < d.loc["sugar", "MN9_hz"]
    passed = bool(rest_silent and sugar_ok and bitter_ok)
    summary = (f"rest silent={rest_silent}; MN9 sugar {d.loc['sugar','MN9_hz']:.1f} Hz "
               f"[{d.loc['sugar','MN9_min']:.1f}-{d.loc['sugar','MN9_max']:.1f}], bitter {d.loc['bitter','MN9_hz']:.1f} Hz, "
               f"sugar+bitter {d.loc['sugar+bitter','MN9_hz']:.1f} Hz (bitter suppresses: {suppress}); "
               f"runaway runs: {int(runs.runaway.sum())}/{len(runs)}")
    out_json = report.save_json(dict(experiment="sugar", ms=MS, seeds=list(seeds), params=sim.params_dict(),
                                     table=df, runs=runs, top_types=tops, passed=passed, summary=summary),
                                out / "sugar.json")
    return dict(**{"pass": passed}, summary=summary, table=df, json=out_json)
