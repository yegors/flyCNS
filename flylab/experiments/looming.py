"""PoC 2: looming -> escape.

When something expands quickly in a fly's visual field (a swatting hand), looming-sensitive
visual projection neurons LC4 and LPLC2 excite the giant fiber (DNp01), the command neuron for
the escape jump. This is one of the best-understood reflexes in any brain and a second
independent check of the wiring: a completely different sensory system and output. Because this
dataset includes the nerve cord, the command can be followed all the way to the wing motor
neurons (DLMn, DVMn) that power the takeoff.

Conditions (1 s each, driven neurons at 150 Hz, several random seeds):
  rest        nothing                          -> silent
  looming     LC4 + LPLC2                      -> giant fiber should fire
  LC4         LC4 alone                        -> partial drive
  LPLC2       LPLC2 alone                      -> partial drive
  LC16        LC16 (a different visual type)   -> giant fiber should stay quiet
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .. import report
from ..engine import Sim

MS = 1000.0
SEEDS = (0, 1, 2)
RUNAWAY_SPIKES = 300_000
READ = {"giant_fiber": "giant_fiber", "descending": "descending", "wing_mn": "wing_mn",
        "proboscis_mn": "proboscis_mn", "kenyon": "kenyon"}
CONDITIONS = {
    "rest": [],
    "looming": ["looming"],
    "LC4": ["type:LC4"],
    "LPLC2": ["type:LPLC2"],
    "LC16": ["type:LC16"],
}


def run(brain, atlas, out: Path, seeds=SEEDS) -> dict:
    sim = Sim(brain)
    read = {k: atlas.resolve(q) for k, q in READ.items()}
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
                             giant_fiber_hz=st.loc["giant_fiber", "mean_hz"],
                             wing_mn_hz=st.loc["wing_mn", "mean_hz"],
                             descending_active=int(st.loc["descending", "active"]),
                             MN9_hz=st.loc["proboscis_mn", "mean_hz"],
                             kenyon_active=int(st.loc["kenyon", "active"]),
                             active_neurons=int((res.counts > 0).sum()) - n_driven,
                             spikes=int(res.counts.sum()),
                             runaway=bool(res.counts.sum() > RUNAWAY_SPIKES)))
            if s == seeds[0]:
                excl = np.concatenate(list(driven.values())) if driven else np.zeros(0, dtype=int)
                tops[cond] = report.top_types(res, atlas, k=12, exclude=excl)
                report.raster(res, {**driven, "giant_fiber": read["giant_fiber"], "wing_mn": read["wing_mn"],
                                    "descending": read["descending"]},
                              out / f"looming_{cond}.png",
                              title=f"looming -> escape | {cond}: drive {drives or 'nothing'} at 150 Hz, seed {s}")
    runs = pd.DataFrame(rows)
    df = runs.groupby("condition", sort=False).agg(
        driven=("driven", "first"), giant_fiber_hz=("giant_fiber_hz", "mean"), GF_min=("giant_fiber_hz", "min"),
        GF_max=("giant_fiber_hz", "max"), wing_mn_hz=("wing_mn_hz", "mean"),
        descending_active=("descending_active", "mean"), MN9_hz=("MN9_hz", "mean"),
        kenyon_active=("kenyon_active", "mean"), active_neurons=("active_neurons", "mean"),
        spikes=("spikes", "mean"), runaway_runs=("runaway", "sum")).reset_index()
    df["runaway_runs"] = df["runaway_runs"].astype(str) + f"/{len(seeds)}"
    report.print_df(df, f"looming -> giant fiber DNp01, mean over {len(seeds)} seeds (Hz)")
    report.print_df(tops["looming"], "looming (seed 0): most active downstream types")

    d = df.set_index("condition")
    rest_silent = d.loc["rest", "spikes"] == 0
    gf_ok = d.loc["looming", "GF_min"] >= 5.0
    control_ok = d.loc["LC16", "GF_max"] < 1.0
    passed = bool(rest_silent and gf_ok and control_ok)
    summary = (f"giant fiber: looming {d.loc['looming','giant_fiber_hz']:.0f} Hz, LC4 {d.loc['LC4','giant_fiber_hz']:.0f}, "
               f"LPLC2 {d.loc['LPLC2','giant_fiber_hz']:.0f}, LC16 control {d.loc['LC16','giant_fiber_hz']:.1f} Hz; "
               f"wing motor neurons under looming {d.loc['looming','wing_mn_hz']:.1f} Hz; "
               f"runaway runs: {int(runs.runaway.sum())}/{len(runs)}")
    out_json = report.save_json(dict(experiment="looming", ms=MS, seeds=list(seeds), params=sim.params_dict(),
                                     table=df, runs=runs, top_types=tops, passed=passed, summary=summary),
                                out / "looming.json")
    return dict(**{"pass": passed}, summary=summary, table=df, json=out_json)
