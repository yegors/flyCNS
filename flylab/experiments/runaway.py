"""Experiment 3, the first real lab question: why do half the runs blow up?

In the PoC runs, about half of all trials, regardless of stimulus, fall into a state where
~13,000 neurons (8% of the brain) fire at high rates for as long as the stimulus lasts. The
hottest types are Kenyon cells (the mushroom body) and the antennal-lobe local neurons lLN1/lLN2,
whose predicted transmitter here is acetylcholine (excitatory). In the real fly those local
neurons are inhibitory, and TheMrRaGe/flybrain found that re-signing them was necessary to stop
the antennal lobe from broadcasting every input to every glomerulus.

This experiment tests that hypothesis directly: same stimuli, same seeds, with and without the
lLN1/lLN2 output forced inhibitory. If the fix is right, the runaway state should disappear
and the specific pathway results (MN9, giant fiber) should survive.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from .. import report
from ..engine import Sim

MS = 1000.0
SEEDS = (0, 1, 2)
RUNAWAY_SPIKES = 300_000
LLN_QUERY = "antennal_lobe_ln"
STIMULI = {"sugar": ["sugar"], "bitter": ["bitter"], "water": ["water"], "LC4": ["type:LC4"]}
VARIANTS = {"as_labelled": None, "lLN_inhibitory": -1}


def run(brain, atlas, out: Path, seeds=SEEDS) -> dict:
    sim = Sim(brain)
    lln = atlas.resolve(LLN_QUERY)
    read = atlas.groups(["proboscis_mn", "giant_fiber", "kenyon"])
    report.console.print(f"lLN1/lLN2 neurons: {len(lln)}, labelled "
                         f"{atlas.describe(lln)['nt'].value_counts().to_dict()}")
    rows = []
    for variant, sign in VARIANTS.items():
        for stim, drives in STIMULI.items():
            driven = [atlas.resolve(d) for d in drives]
            for s in seeds:
                sim.seed = s
                sim.reset()
                if sign is not None:
                    sim.set_sign(lln, sign)
                for idx in driven:
                    sim.drive(idx)
                res = sim.run(MS, verbose=True)
                st = report.group_stats(res, read).set_index("group")
                rows.append(dict(variant=variant, stimulus=stim, seed=s,
                                 spikes=int(res.counts.sum()),
                                 active_neurons=int((res.counts > 0).sum()),
                                 kenyon_active=int(st.loc["kenyon", "active"]),
                                 MN9_hz=st.loc["proboscis_mn", "mean_hz"],
                                 giant_fiber_hz=st.loc["giant_fiber", "mean_hz"],
                                 runaway=bool(res.counts.sum() > RUNAWAY_SPIKES)))
                if s == seeds[0]:
                    report.raster(res, {**{d: i for d, i in zip(drives, driven)}, **read},
                                  out / f"runaway_{variant}_{stim}.png",
                                  title=f"runaway test | {variant} | drive {drives} at 150 Hz, seed {s}")
    runs = pd.DataFrame(rows)
    df = runs.groupby(["variant", "stimulus"], sort=False).agg(
        spikes=("spikes", "mean"), active_neurons=("active_neurons", "mean"),
        kenyon_active=("kenyon_active", "mean"), MN9_hz=("MN9_hz", "mean"),
        giant_fiber_hz=("giant_fiber_hz", "mean"), runaway_runs=("runaway", "sum")).reset_index()
    df["runaway_runs"] = df["runaway_runs"].astype(str) + f"/{len(seeds)}"
    report.print_df(df, f"runaway test: lLN1/lLN2 as labelled vs forced inhibitory, mean over {len(seeds)} seeds")

    r_lab = int(runs[runs.variant == "as_labelled"].runaway.sum())
    r_fix = int(runs[runs.variant == "lLN_inhibitory"].runaway.sum())
    n = len(runs) // 2
    fixed = runs[runs.variant == "lLN_inhibitory"].set_index(["stimulus", "seed"])
    sugar_mn9 = fixed.loc["sugar", "MN9_hz"].mean()
    bitter_mn9 = fixed.loc["bitter", "MN9_hz"].mean()
    gf = fixed.loc["LC4", "giant_fiber_hz"].mean()
    passed = bool(r_fix < r_lab and sugar_mn9 > bitter_mn9 and gf > 5)
    summary = (f"runaway runs as labelled {r_lab}/{n}, with lLN inhibitory {r_fix}/{n}; with the fix: "
               f"MN9 sugar {sugar_mn9:.1f} Hz vs bitter {bitter_mn9:.1f} Hz, giant fiber under LC4 {gf:.0f} Hz")
    out_json = report.save_json(dict(experiment="runaway", ms=MS, seeds=list(seeds), lln_neurons=len(lln),
                                     params=sim.params_dict(), table=df, runs=runs, passed=passed, summary=summary),
                                out / "runaway.json")
    return dict(**{"pass": passed}, summary=summary, table=df, json=out_json)
