"""Command line for the lab.  `python -m flylab --help`"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import typer

for _s in (sys.stdout, sys.stderr):  # Windows consoles default to cp1252, which cannot print rich tables
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from . import report  # noqa: E402
from .atlas import ALIASES, Atlas
from .data import DATA_DIR, download_cmd, load_brain, missing_files, nt_sign
from .engine import Params, Sim

app = typer.Typer(help="flylab: experiments on the simulated male fruit-fly nervous system (MaleCNS v1.0).",
                  no_args_is_help=True, add_completion=False)
console = report.console
RESULTS = Path(__file__).resolve().parent.parent / "results"
EXPERIMENTS = ["sugar", "looming", "runaway"]


def _brain_atlas(min_weight: int):
    if missing_files():
        console.print(f"[red]Missing data files in {DATA_DIR}.[/red] Fetch them with:\n{download_cmd()}")
        raise typer.Exit(1)
    b = load_brain(min_weight)
    return b, Atlas(b)


@app.command()
def prepare(min_weight: int = 5, rebuild: bool = False):
    """Build (and cache) the signed brain from the three feather files."""
    load_brain(min_weight, rebuild=rebuild)


@app.command()
def info(min_weight: int = 5):
    """Summary of the loaded brain."""
    b, atlas = _brain_atlas(min_weight)
    m = b.meta
    console.print(f"neurons {b.n:,}   edges {b.n_edges:,} (>= {b.min_weight} synapses)   synapses {b.n_synapses:,}")
    sc = m["superclass"].fillna("?").value_counts().rename_axis("superclass").reset_index(name="neurons")
    report.print_df(sc, "neurons by superclass")
    nt = m["nt"].value_counts().rename_axis("transmitter").reset_index(name="neurons")
    nt["sign"] = nt["transmitter"].map(lambda s: {1: "+", -1: "-", 0: "0"}[nt_sign(s)])
    report.print_df(nt, "neurons by predicted transmitter")


@app.command()
def find(text: str, min_weight: int = 5):
    """Search cell types by name or synonym."""
    _, atlas = _brain_atlas(min_weight)
    df = atlas.find(text)
    report.print_df(df.head(40), f"types matching {text!r} ({len(df)} total)")


@app.command()
def aliases():
    """List the human-friendly names you can stimulate or read."""
    rows = [dict(alias=k, spec=_spec_str(v), note=v.get("note", "")) for k, v in ALIASES.items()]
    report.print_df(pd.DataFrame(rows), "aliases")


@app.command()
def stim(targets: list[str] = typer.Argument(..., help="what to activate (aliases or queries)"),
         read: list[str] = typer.Option([], "--read", "-r", help="groups to report"),
         silence: list[str] = typer.Option([], "--silence", "-s", help="groups whose output is removed"),
         inhibit: list[str] = typer.Option([], "--inhibit", "-i", help="groups whose output is forced inhibitory"),
         ms: float = 1000.0, rate: float = 150.0, seed: int = 0,
         side: Optional[str] = typer.Option(None, help="restrict targets to L or R"),
         top: int = 15, name: str = "stim", min_weight: int = 5, no_plot: bool = False):
    """Generic experiment: activate TARGETS, optionally silence or re-sign groups, report what fires."""
    b, atlas = _brain_atlas(min_weight)
    sim = Sim(b, seed=seed)
    driven = {}
    for t in targets:
        idx = atlas.resolve(t, side)
        driven[t] = idx
        sim.drive(idx, rate_hz=rate)
    for s in silence:
        sim.silence(atlas.resolve(s))
    for s in inhibit:
        sim.set_sign(atlas.resolve(s), -1)
    console.print(f"driving {sum(len(v) for v in driven.values())} neurons at {rate:.0f} Hz for {ms:.0f} ms "
                  f"on {sim.device}, seed {seed}" + (f", silencing {silence}" if silence else "")
                  + (f", inhibitory {inhibit}" if inhibit else ""))
    res = sim.run(ms, verbose=True)
    groups = {**driven, **{r: atlas.resolve(r) for r in read}}
    report.print_df(report.group_stats(res, groups), "group activity")
    excl = np.concatenate(list(driven.values()))
    report.print_df(report.top_types(res, atlas, k=top, exclude=excl), f"most active downstream types")
    if not no_plot:
        path = report.raster(res, groups, RESULTS / f"{name}.png", title=f"{name}: drive {targets}" + (f" silence {silence}" if silence else ""))
        console.print(f"raster -> {path}")
    report.save_json(dict(targets=targets, read=read, silence=silence, inhibit=inhibit, seed=seed, ms=ms, rate=rate,
                          params=sim.params_dict(),
                          groups=report.group_stats(res, groups), spikes_total=int(res.counts.sum()),
                          wall_s=res.wall_s), RESULTS / f"{name}.json")


@app.command()
def run(experiment: str = typer.Argument("all", help="|".join(EXPERIMENTS + ["all"])), min_weight: int = 5):
    """Run a proof-of-concept experiment from flylab/experiments."""
    names = EXPERIMENTS if experiment == "all" else [experiment]
    b, atlas = _brain_atlas(min_weight)
    verdicts = {}
    for n in names:
        mod = importlib.import_module(f"flylab.experiments.{n}")
        console.rule(f"[bold]{n}")
        verdicts[n] = mod.run(b, atlas, RESULTS)
    console.rule()
    for n, v in verdicts.items():
        console.print(f"{n:10s} {'[green]PASS' if v['pass'] else '[red]FAIL'}[/]  {v['summary']}")


@app.command()
def bench(ms: float = 500.0, min_weight: int = 5, no_graph: bool = False):
    """Throughput check: drive the looming neurons and time the engine."""
    b, atlas = _brain_atlas(min_weight)
    sim = Sim(b, use_graph=not no_graph)
    console.print(f"engine: {sim.status()}")
    sim.drive(atlas.resolve("looming"))
    res = sim.run(ms, verbose=True)
    console.print(f"{res.steps / res.wall_s:,.0f} steps/s, {res.n_spikes:,} spikes, "
                  f"{int((res.counts > 0).sum()):,} neurons active")


@app.command()
def serve(host: str = "127.0.0.1", port: int = 8000, min_weight: int = 5,
          no_fix: bool = typer.Option(False, help="start with transmitters as labelled (no lLN fix)"),
          no_graph: bool = typer.Option(False, help="disable CUDA graph capture")):
    """Start the web lab (live brain, 3D fly, map, experiments) at http://HOST:PORT."""
    from .server import serve as _serve
    _serve(host=host, port=port, min_weight=min_weight, fix=not no_fix, use_graph=not no_graph)


def _spec_str(v: dict) -> str:
    parts = []
    for k in ("types", "regex", "cls", "superclass", "dimorphism"):
        if k in v:
            parts.append(f"{k}={v[k]}")
    return "; ".join(parts)
