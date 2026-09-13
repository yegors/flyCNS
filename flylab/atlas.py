"""Name resolution: turn human words into neuron indices, so experiments read like biology.

Aliases come from the MaleCNS v1.0 annotations plus the companion taste connectome
(Cell 2026, receptor assignments summarised in TheMrRaGe/flybrain FINDINGS.md).
Everything else is reachable through 'type:', 're:', 'class:', 'super:' and 'body:' queries.
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

from .data import Brain

ALIASES: dict[str, dict] = {
    # ---- taste (labellar gustatory receptor neurons, GRNs)
    "sugar":        dict(types=["LB3c"], note="labellar sugar GRNs (Gr64f)"),
    "sugar_pegs":   dict(types=["claw_tpGRN", "dorsal_tpGRN"], note="taste-peg GRNs, sweet-like (Gr5a/Gr64e)"),
    "bitter":       dict(types=["LB1a", "LB1b", "LB1c", "LB1d"], note="labellar bitter GRNs (Gr33a)"),
    "water":        dict(types=["LB3a"], note="labellar water GRNs (ppk28)"),
    "low_salt":     dict(types=["LB3b"], note="labellar low-salt GRNs (Ir56b)"),
    "heavy_metal":  dict(types=["LB3d"], note="labellar aversive GRNs (Ir47a)"),
    "proboscis_mn": dict(types=["MN9"], note="proboscis-extension motor neuron, the Shiu et al. readout"),
    "feeding_mn":   dict(types=["MN9", "MN10", "MN11D", "MN11V", "MN12D", "MNx01"], note="feeding motor neurons"),
    # ---- vision and escape
    "looming":      dict(types=["LC4", "LPLC2"], note="looming-sensitive visual projection neurons"),
    "giant_fiber":  dict(types=["DNp01"], note="giant fiber, the escape (jump) command neuron"),
    "photoreceptors": dict(regex=r"^R[1-8]", note="R1-R8 photoreceptors (histaminergic: light INHIBITS targets)"),
    "motion":       dict(regex=r"^T[45][a-d]$", note="T4/T5 direction-selective motion detectors"),
    # ---- descending neurons (brain -> nerve cord commands)
    "steer":        dict(types=["DNa01", "DNa02", "DNa03", "DNg13"], note="steering descending neurons; drive one side to turn"),
    "food_odor":    dict(types=["ORN_DM1", "ORN_DM2", "ORN_DM4"], note="fruit/vinegar-attracted olfactory receptor neurons"),
    "walk_forward": dict(types=["DNp09"], note="DNp09 forward walking"),
    "backward":     dict(types=["MDN"], note="moonwalker descending neurons (walk backward)"),
    "groom":        dict(types=["DNg11"], note="DNg11 grooming"),
    "descending":   dict(superclass=["descending_neuron"], note="all descending neurons"),
    "motor":        dict(superclass=["vnc_motor", "cb_motor"], note="all motor neurons"),
    "leg_mn":       dict(regex=r"(?:ti|tr|fe|ta|cx|sternal|tergo|ltm|acc\.).*MN$", superclass=["vnc_motor"], note="leg motor neurons"),
    "wing_mn":      dict(regex=r"^(?:DLMn|DVMn)", note="flight power-muscle motor neurons (takeoff)"),
    "antennal_lobe_ln": dict(regex=r"^lLN[12]", note="antennal-lobe local neurons; inhibitory in the real fly, 82 labelled cholinergic here"),
    # ---- smell, memory, reinforcement
    "orn":          dict(regex=r"^ORN_", note="olfactory receptor neurons"),
    "pheromone":    dict(types=["ORN_DA1"], note="cVA pheromone ORNs (drive courtship circuitry)"),
    "kenyon":       dict(regex=r"^KC", note="Kenyon cells, the mushroom body's sparse code"),
    "mbon":         dict(regex=r"^MBON", note="mushroom body output neurons (learned valence)"),
    "dopamine_reward": dict(regex=r"^PAM", note="PAM dopamine neurons (reward)"),
    "dopamine_punish": dict(regex=r"^PPL1", note="PPL1 dopamine neurons (punishment)"),
    "apl":          dict(types=["APL"], note="mushroom body inhibitory feedback neuron"),
    # ---- courtship (male-specific circuitry, new in this dataset)
    "courtship":    dict(regex=r"^pC1_", note="pC1/P1 courtship command neurons"),
    "song":         dict(types=["pIP10"], note="pIP10 courtship-song descending neuron"),
    "male_specific": dict(dimorphism=["male-specific"], note="all male-specific neurons"),
}


class Atlas:
    def __init__(self, brain: Brain):
        self.b = brain
        self.m = brain.meta
        self._type = self.m["type"].fillna("").astype(str)

    # ---------------------------------------------------------------- lookup
    def _from_spec(self, spec: dict) -> np.ndarray:
        mask = np.ones(len(self.m), dtype=bool)
        used = False
        if "types" in spec:
            mask &= self._type.isin(spec["types"]).values
            used = True
        if "regex" in spec:
            mask &= self._type.str.contains(spec["regex"], regex=True, case=False).values
            used = True
        if "cls" in spec:
            mask &= self.m["class"].isin(_aslist(spec["cls"])).values
            used = True
        if "superclass" in spec:
            mask &= self.m["superclass"].isin(_aslist(spec["superclass"])).values
            used = True
        if "dimorphism" in spec:
            mask &= self.m["dimorphism"].isin(_aslist(spec["dimorphism"])).values
            used = True
        if not used:
            raise ValueError(f"empty alias spec {spec}")
        return np.nonzero(mask)[0]

    def resolve(self, query, side: str | None = None) -> np.ndarray:
        """Return neuron indices for an alias, 'type:NAME', 'types:A,B', 're:PATTERN',
        'class:NAME', 'super:NAME', 'body:ID,ID', an exact type name, or an index array."""
        if not isinstance(query, str):
            idx = np.asarray(query, dtype=np.int64).ravel()
        else:
            q = query.strip()
            if q in ALIASES:
                idx = self._from_spec(ALIASES[q])
            elif ":" in q:
                kind, val = (s.strip() for s in q.split(":", 1))
                kind = kind.lower()
                if kind in ("type", "types"):
                    idx = self._from_spec(dict(types=[v.strip() for v in val.split(",")]))
                elif kind in ("re", "regex"):
                    idx = self._from_spec(dict(regex=val))
                elif kind == "class":
                    idx = self._from_spec(dict(cls=val.split(",")))
                elif kind in ("super", "superclass"):
                    idx = self._from_spec(dict(superclass=val.split(",")))
                elif kind in ("body", "bodies"):
                    idx = self.b.index_of([int(v) for v in val.split(",")])
                else:
                    raise KeyError(f"unknown query kind {kind!r} in {query!r}")
            else:
                idx = np.nonzero((self._type == q).values)[0]
                if len(idx) == 0:
                    hits = list(self.find(q)["type"][:8])
                    raise KeyError(f"{q!r} is neither an alias nor an exact type. Similar types: {hits}. "
                                   f"Use 're:PATTERN' for a regex, or see `flylab aliases`.")
        if side is not None:
            idx = idx[self.m["side"].values[idx] == side.upper()]
        return idx

    def groups(self, names, side: str | None = None) -> dict[str, np.ndarray]:
        return {n: self.resolve(n, side) for n in names}

    # ---------------------------------------------------------------- search
    def find(self, text: str) -> pd.DataFrame:
        """Types whose name, synonyms or cross-dataset names mention `text` (case-insensitive)."""
        pat = re.escape(text)
        hay = pd.concat([self.m[c].fillna("").astype(str) for c in
                         ["type", "synonyms", "hemibrainType", "flywireType"] if c in self.m.columns], axis=1)
        mask = hay.apply(lambda s: s.str.contains(pat, case=False, regex=True)).any(axis=1).values
        sub = self.m[mask]
        if sub.empty:
            return pd.DataFrame(columns=["type", "n", "class", "superclass", "nt"])
        g = sub.groupby(sub["type"].fillna("?")).agg(
            n=("bodyId", "size"),
            **{"class": ("class", lambda s: _mode(s)), "superclass": ("superclass", lambda s: _mode(s)),
               "nt": ("nt", lambda s: _mode(s))})
        return g.sort_values("n", ascending=False).reset_index()

    def describe(self, idx) -> pd.DataFrame:
        cols = [c for c in ["bodyId", "type", "side", "nt", "sign", "superclass", "class", "dimorphism"] if c in self.m.columns]
        return self.m.iloc[np.asarray(idx)][cols].reset_index(drop=True)

    def type_of(self, idx) -> np.ndarray:
        return self._type.values[np.asarray(idx)]


def _aslist(x):
    return [x] if isinstance(x, str) else list(x)


def _mode(s: pd.Series):
    s = s.dropna()
    return s.mode().iloc[0] if len(s) else ""
