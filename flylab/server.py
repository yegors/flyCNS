"""Web lab: FastAPI server that runs the live simulation on the GPU and streams it over a WebSocket.

    python -m flylab serve            # then open http://127.0.0.1:8000

Protocol (WebSocket /ws)
  client -> server, JSON text:
    {"cmd":"drive","group":"sugar","rate":150,"side":null}   rate 0 switches a group off
    {"cmd":"clear"} {"cmd":"reset"} {"cmd":"play"} {"cmd":"pause"} {"cmd":"speed","x":1.0}
    {"cmd":"fix","on":true}            lLN1/lLN2 forced inhibitory (the runaway fix)
    {"cmd":"silence","group":...} {"cmd":"restore"}
    {"cmd":"senses", "odor_L":0..1, "odor_R":0..1, "sugar":0..1, "loom":0..1, "hunger":0..1, "wander_L":0..1, "wander_R":0..1}
    {"cmd":"vision", "hold_mv": 7.5}   tonic depolarisation of lamina neurons L1-L3 (0 = off)
  client -> server, binary: byte 0 = 1, then one uint8 Poisson rate (Hz) per photoreceptor in /api/retina order
  server -> client, one binary frame per simulation chunk (10 ms of fly time):
    uint32 LE header length | JSON header | uint32[] indices of neurons that spiked in the chunk
"""
from __future__ import annotations

import asyncio
import json
import os
import queue
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .atlas import ALIASES, Atlas
from .data import ROOT, load_brain, neuron_positions, retina_map
from .engine import Sim
from .google import StreetViewClient
from .roads import RoadClient

WEB = Path(__file__).resolve().parent / "web"
RESULTS = ROOT / "results"
LOCAL_CONFIG = ROOT / "flylab.local.json"

READOUTS = {  # name -> (atlas query, side)
    "MN9": ("proboscis_mn", None), "giant_fiber": ("giant_fiber", None), "wing_mn": ("wing_mn", None),
    "leg_mn": ("leg_mn", None), "steer_L": ("steer", "L"), "steer_R": ("steer", "R"),
    "walk": ("walk_forward", None), "backward": ("backward", None), "groom": ("groom", None),
    "kenyon": ("kenyon", None), "descending": ("descending", None), "motor": ("motor", None),
    "courtship": ("courtship", None), "song": ("song", None),
    "lamina_L": ("re:^L[123]$", "L"), "lamina_R": ("re:^L[123]$", "R"),
    "motion_L": ("motion", "L"), "motion_R": ("motion", "R"),
    "looming_L": ("looming", "L"), "looming_R": ("looming", "R"),
}
SENSES = {  # map-mode senses -> (atlas query, side, max rate Hz)
    "odor_L": ("food_odor", "L", 150.0), "odor_R": ("food_odor", "R", 150.0),
    "sugar": ("sugar", None, 150.0), "loom": ("looming", None, 150.0),
    "hunger": ("walk_forward", None, 150.0),  # artificial: nothing in the connectome drives spontaneous walking
    "wander_L": ("steer", "L", 40.0), "wander_R": ("steer", "R", 40.0),
}
STIMULI = [  # what the control panel offers, grouped
    ("Taste", ["sugar", "bitter", "water", "sugar_pegs"]),
    ("Vision", ["looming", "type:LC16", "motion", "photoreceptors"]),
    ("Smell", ["food_odor", "pheromone", "orn"]),
    ("Commands", ["walk_forward", "backward", "groom", "steer", "giant_fiber"]),
    ("Male circuits", ["courtship", "song"]),
    ("Learning", ["kenyon", "dopamine_reward", "dopamine_punish"]),
]
VISION_DEFAULT = {"hold_mv": 7.5, "dark_hz": 90.0, "light_hz": 0.0}
GOOGLE_MIN_INTERVAL = 0.35   # seconds between Street View image requests


def local_config() -> dict:
    cfg = {}
    if LOCAL_CONFIG.exists():
        try:
            cfg = json.loads(LOCAL_CONFIG.read_text())
        except Exception:
            cfg = {}
    key = os.environ.get("GOOGLE_MAPS_API_KEY") or cfg.get("google_maps_api_key") or ""
    return {"google_maps_api_key": key, "google_map_id": cfg.get("google_map_id", ""),
            "google_maps_server_key": os.environ.get("GOOGLE_MAPS_SERVER_KEY") or cfg.get("google_maps_server_key") or key}


class Lab:
    def __init__(self, min_weight: int = 5, fix: bool = True, use_graph: bool = True):
        self.brain = load_brain(min_weight)
        self.atlas = Atlas(self.brain)
        self.positions = neuron_positions(self.brain)
        self.retina = retina_map(self.brain)
        self.sim = Sim(self.brain, use_graph=use_graph)
        self.sim.record = False
        dev = self.sim.device
        self.tick_ms = self.sim.K * self.sim.p.dt
        self.fix_on = fix
        self.lln = self.atlas.resolve("antennal_lobe_ln")
        self.lamina = self.atlas.resolve("re:^L[123]$")
        self.retina_idx = torch.as_tensor(self.retina["idx"].values.copy(), device=dev)
        self.readouts = {k: torch.as_tensor(self.atlas.resolve(q, s), device=dev) for k, (q, s) in READOUTS.items()}
        self.senses = {k: (torch.as_tensor(self.atlas.resolve(q, s), device=dev), mx) for k, (q, s, mx) in SENSES.items()}
        self.prev_counts = self.sim.counts.clone()
        self.drives: dict[str, float] = {}
        self.vision = dict(VISION_DEFAULT)
        self.retina_on = False
        self.cmds: queue.Queue = queue.Queue()
        self.playing = True
        self.speed = 1.0            # cap on real-time factor; 0 = unlimited
        self.clients: set[WebSocket] = set()
        self.frames: asyncio.Queue | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.wall_ms = 0.0
        self.stop = False
        self.procs: dict[str, subprocess.Popen] = {}
        self.sv_cache: dict[str, bytes] = {}
        self.sv_last = 0.0
        self.sv_lock = threading.Lock()
        self.google = StreetViewClient(local_config)
        self.roads = RoadClient()
        sc = self.brain.meta["superclass"].fillna("?")
        self.superclasses = list(sc.value_counts().index)
        self.class_ids = sc.map({s: i for i, s in enumerate(self.superclasses)}).values.astype(np.uint8)
        self.apply_fix()
        self.apply_vision()

    # ---------------------------------------------------------------- control
    def apply_fix(self):
        if self.fix_on:
            self.sim.set_sign(self.lln, -1)
        else:
            self.sim.restore()

    def apply_vision(self):
        self.sim.set_hold(self.lamina, float(self.vision.get("hold_mv", 0.0)))

    def handle(self, m: dict):
        cmd = m.get("cmd")
        try:
            if cmd == "drive":
                idx = self.atlas.resolve(m["group"], m.get("side"))
                rate = float(m.get("rate", 150.0))
                key = m["group"] + (f":{m['side']}" if m.get("side") else "")
                self.sim.drive(idx, rate)
                if rate > 0:
                    self.drives[key] = rate
                else:
                    self.drives.pop(key, None)
            elif cmd == "clear":
                self.sim.clear_drive()
                self.drives = {}
                self.retina_on = False
            elif cmd == "reset":
                self.sim.reset()
                self.sim.record = False
                self.apply_fix()
                self.prev_counts.zero_()
                self.drives = {}
                self.retina_on = False
                self.push(json.dumps({"event": "reset"}).encode(), text=True)
            elif cmd == "fix":
                self.fix_on = bool(m.get("on", True))
                self.apply_fix()
            elif cmd == "vision":
                self.vision.update({k: float(v) for k, v in m.items() if k in VISION_DEFAULT})
                self.apply_vision()
            elif cmd == "retina":
                rates = np.asarray(m["rates"], dtype=np.float32)
                if len(rates) == len(self.retina):
                    self.sim.set_rates(self.retina_idx, rates)
                    self.retina_on = bool(rates.max() > 0)
            elif cmd == "silence":
                self.sim.silence(self.atlas.resolve(m["group"], m.get("side")))
            elif cmd == "restore":
                self.sim.restore()
                self.apply_fix()
            elif cmd == "play":
                self.playing = True
            elif cmd == "pause":
                self.playing = False
            elif cmd == "speed":
                self.speed = float(m.get("x", 1.0))
            elif cmd == "senses":
                for name, (idx, mx) in self.senses.items():
                    if name in m:
                        val = min(max(float(m[name]), 0.0), 1.0)
                        self.sim.drive(idx, val * mx)
                        if val > 0:
                            self.drives["sense:" + name] = round(val * mx, 1)
                        else:
                            self.drives.pop("sense:" + name, None)
        except Exception as e:  # a bad command must not kill the sim thread
            self.push(json.dumps({"error": f"{cmd}: {e}"}).encode(), text=True)

    # ------------------------------------------------------------------- loop
    def frame(self) -> bytes:
        t0 = time.perf_counter()
        spiked = self.sim.tick()
        d = self.sim.counts - self.prev_counts
        self.prev_counts.copy_(self.sim.counts)
        scale = 1000.0 / self.tick_ms
        means = torch.stack([d[idx].float().mean() for idx in self.readouts.values()]) * scale
        actives = torch.stack([(d[idx] > 0).sum() for idx in self.readouts.values()]).float()
        totals = torch.stack([d.sum(), (d > 0).sum()]).float()
        idx = spiked.nonzero().squeeze(1).to(torch.int32)
        stats = torch.cat([means, actives, totals]).cpu().numpy()
        idx_np = idx.cpu().numpy()
        if self.sim.device.type == "cuda":
            torch.cuda.synchronize()
        self.wall_ms = 0.8 * self.wall_ms + 0.2 * (time.perf_counter() - t0) * 1000
        k = len(self.readouts)
        names = list(self.readouts)
        header = {
            "t": round(self.sim.t * self.sim.p.dt, 1), "tick_ms": self.tick_ms, "wall_ms": round(self.wall_ms, 2),
            "spikes": int(stats[2 * k]), "active": int(stats[2 * k + 1]),
            "rates": {n: round(float(stats[i]), 1) for i, n in enumerate(names)},
            "active_n": {n: int(stats[k + i]) for i, n in enumerate(names)},
            "drives": self.drives, "retina": self.retina_on, "fix": self.fix_on, "vision": self.vision,
            "playing": self.playing, "speed": self.speed,
        }
        hb = json.dumps(header).encode()
        return struct.pack("<I", len(hb)) + hb + idx_np.tobytes()

    def push(self, data: bytes, text: bool = False):
        if self.loop is not None and self.frames is not None:
            self.loop.call_soon_threadsafe(self._enqueue, (data, text))

    def _enqueue(self, item):
        if self.frames.full():
            try:
                self.frames.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self.frames.put_nowait(item)

    def run_forever(self):
        next_t = time.perf_counter()
        while not self.stop:
            while not self.cmds.empty():
                self.handle(self.cmds.get())
            if self.playing and self.clients:
                fr = self.frame()
                self.push(fr)
                if self.speed > 0:  # do not run faster than speed x real time
                    next_t += self.tick_ms / 1000.0 / self.speed
                    lag = next_t - time.perf_counter()
                    if lag > 0:
                        time.sleep(lag)
                    elif lag < -0.5:
                        next_t = time.perf_counter()
            else:
                next_t = time.perf_counter()
                time.sleep(0.02)

    # ------------------------------------------------------------ street view
    def google_get(self, url: str, params: dict, binary: bool) -> bytes:
        return self.google.get(url, params, binary)

    # ------------------------------------------------------------ experiments
    def experiments(self) -> list[dict]:
        out = []
        if not RESULTS.exists():
            return out
        for js in sorted(RESULTS.glob("*.json")):
            try:
                d = json.loads(js.read_text())
            except Exception:
                continue
            name = js.stem
            imgs = sorted(p.name for p in RESULTS.glob(f"{name}_*.png")) or ([f"{name}.png"] if (RESULTS / f"{name}.png").exists() else [])
            proc = self.procs.get(name)
            out.append(dict(name=name, experiment=d.get("experiment"), passed=d.get("passed"),
                            summary=d.get("summary", ""), images=[f"/results/{i}" for i in imgs],
                            seeds=d.get("seeds"), ms=d.get("ms"), targets=d.get("targets"),
                            running=bool(proc and proc.poll() is None),
                            modified=js.stat().st_mtime))
        return out

    def start_experiment(self, name: str) -> dict:
        if name not in ("sugar", "looming", "runaway", "all"):
            raise HTTPException(400, "unknown experiment")
        proc = self.procs.get(name)
        if proc and proc.poll() is None:
            return {"running": True}
        log = open(RESULTS / f"{name}.log", "w", encoding="utf-8")
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        self.procs[name] = subprocess.Popen([sys.executable, "-m", "flylab", "run", name], cwd=ROOT,
                                            stdout=log, stderr=subprocess.STDOUT, env=env)
        return {"running": True}

    def experiment_status(self, name: str) -> dict:
        proc = self.procs.get(name)
        log = RESULTS / f"{name}.log"
        tail = log.read_text(encoding="utf-8", errors="replace")[-4000:] if log.exists() else ""
        return {"running": bool(proc and proc.poll() is None),
                "returncode": None if not proc else proc.poll(), "log": tail}


def create_app(min_weight: int = 5, fix: bool = True, use_graph: bool = True) -> FastAPI:
    lab = Lab(min_weight=min_weight, fix=fix, use_graph=use_graph)
    app = FastAPI(title="flyCNS lab")
    app.state.lab = lab
    @app.middleware("http")
    async def fresh_lab_ui(request, call_next):
        response = await call_next(request)
        if request.url.path == "/" or request.url.path.endswith((".js", ".css", ".html")):
            response.headers["Cache-Control"] = "no-store"
        return response

    RESULTS.mkdir(exist_ok=True)
    app.mount("/static", StaticFiles(directory=WEB), name="static")
    app.mount("/results", StaticFiles(directory=RESULTS), name="results")

    @app.on_event("startup")
    async def _startup():
        lab.loop = asyncio.get_running_loop()
        lab.frames = asyncio.Queue(maxsize=4)
        app.state.sim_thread = threading.Thread(target=lab.run_forever, daemon=True, name="sim")
        app.state.sim_thread.start()
        app.state.broadcast_task = asyncio.create_task(_broadcast())

    @app.on_event("shutdown")
    async def _shutdown():
        lab.stop = True
        app.state.broadcast_task.cancel()
        await asyncio.to_thread(app.state.sim_thread.join, 5)

    async def _broadcast():
        while True:
            data, text = await lab.frames.get()
            for ws in list(lab.clients):
                try:
                    if text:
                        await ws.send_text(data.decode())
                    else:
                        await ws.send_bytes(data)
                except Exception:
                    lab.clients.discard(ws)

    @app.get("/")
    async def index():
        return FileResponse(WEB / "index.html")

    @app.get("/api/config")
    async def config():
        b, s = lab.brain, lab.sim
        aliases = []
        for name, spec in ALIASES.items():
            n = len(lab.atlas.resolve(name))
            aliases.append(dict(name=name, n=n, note=spec.get("note", "")))
        return dict(n=b.n, edges=b.n_edges, synapses=b.n_synapses, min_weight=b.min_weight,
                    dt=s.p.dt, tick_ms=lab.tick_ms, sim=s.status(), fix=lab.fix_on, vision=lab.vision,
                    aliases=aliases, stimuli=STIMULI, readouts=list(READOUTS), senses=list(SENSES),
                    superclasses=lab.superclasses, params=s.params_dict(), retina_n=len(lab.retina),
                    **{k: v for k, v in local_config().items() if k != "google_maps_server_key"})

    @app.get("/api/positions")
    async def positions():
        return Response(lab.positions.astype(np.float32).tobytes(), media_type="application/octet-stream")

    @app.get("/api/classes")
    async def classes():
        sign = (lab.brain.meta["sign"].values.astype(np.int8) + 1).astype(np.uint8)
        return Response(np.concatenate([lab.class_ids, sign]).tobytes(), media_type="application/octet-stream")

    @app.get("/api/retina")
    async def retina():
        r = lab.retina
        return dict(n=len(r), idx=r["idx"].tolist(), side=r["side"].tolist(),
                    az=[round(float(v), 1) for v in r["az"]], el=[round(float(v), 1) for v in r["el"]],
                    vision=lab.vision)

    @app.get("/api/group/{query}")
    async def group(query: str, side: str | None = None):
        try:
            idx = lab.atlas.resolve(query, side)
        except KeyError as e:
            raise HTTPException(404, str(e))
        return Response(idx.astype(np.uint32).tobytes(), media_type="application/octet-stream")

    @app.get("/api/neuron/{i}")
    async def neuron(i: int):
        if not 0 <= i < lab.brain.n:
            raise HTTPException(404)
        row = lab.atlas.describe([i]).iloc[0].to_dict()
        row = {k: (None if (isinstance(v, float) and np.isnan(v)) else (v.item() if hasattr(v, "item") else v))
               for k, v in row.items()}
        row["index"] = i
        row["out_degree"] = int(lab.brain.indptr[i + 1] - lab.brain.indptr[i])
        return JSONResponse(row)

    @app.get("/api/find")
    async def find(q: str):
        df = lab.atlas.find(q).head(40)
        return JSONResponse(json.loads(df.to_json(orient="records")))

    @app.get("/api/roads")
    def roads(lat: float = Query(ge=-80, le=80), lng: float = Query(ge=-179.9, le=179.9)):
        return lab.roads.get(lat, lng)

    @app.get("/api/streetview")
    def streetview(lat: float = Query(ge=-85, le=85), lng: float = Query(ge=-180, le=180),
                   heading: float = Query(0, ge=0, le=360), pitch: float = Query(0, ge=-90, le=90),
                   fov: float = Query(120, ge=10, le=120), size: str = Query("480x240", pattern=r"^(480x240|640x320)$"),
                   pano: str | None = Query(None, min_length=1, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")):
        params = dict(size=size, heading=round(heading, 1) % 360,
                      pitch=pitch, fov=int(fov), source="outdoor", return_error_code="true")
        params.update({"pano": pano} if pano else {"location": f"{lat:.6f},{lng:.6f}"})
        data = lab.google_get("https://maps.googleapis.com/maps/api/streetview", params, binary=True)
        return Response(data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @app.get("/api/streetview/meta")
    def streetview_meta(lat: float = Query(ge=-85, le=85), lng: float = Query(ge=-180, le=180), radius: int = Query(30, ge=1, le=200)):
        params = dict(location=f"{lat:.6f},{lng:.6f}", radius=radius, source="outdoor")
        data = lab.google_get("https://maps.googleapis.com/maps/api/streetview/metadata", params, binary=False)
        return Response(data, media_type="application/json")

    @app.get("/api/experiments")
    async def experiments():
        return lab.experiments()

    @app.get("/api/experiments/{name}")
    async def experiment(name: str):
        p = RESULTS / f"{name}.json"
        if not p.exists():
            raise HTTPException(404)
        return FileResponse(p)

    @app.post("/api/experiments/{name}/run")
    async def run_experiment(name: str):
        return lab.start_experiment(name)

    @app.get("/api/experiments/{name}/status")
    async def experiment_status(name: str):
        return lab.experiment_status(name)

    @app.websocket("/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        lab.clients.add(sock)
        try:
            await sock.send_text(json.dumps({"hello": True, "fix": lab.fix_on, "playing": lab.playing,
                                             "drives": lab.drives, "vision": lab.vision, "sim": lab.sim.status()}))
            while True:
                msg = await sock.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    b = msg["bytes"]
                    if len(b) > 1 and b[0] == 1:
                        lab.cmds.put({"cmd": "retina", "rates": np.frombuffer(b, dtype=np.uint8, offset=1)})
                elif msg.get("text"):
                    try:
                        lab.cmds.put(json.loads(msg["text"]))
                    except json.JSONDecodeError:
                        pass
        except WebSocketDisconnect:
            pass
        finally:
            lab.clients.discard(sock)

    return app


def serve(host: str = "127.0.0.1", port: int = 8000, min_weight: int = 5, fix: bool = True, use_graph: bool = True):
    import uvicorn
    app = create_app(min_weight=min_weight, fix=fix, use_graph=use_graph)
    lab: Lab = app.state.lab
    print(f"[lab] {lab.brain.n:,} neurons on {lab.sim.device}, graph={lab.sim.graph_kind}, "
          f"fix={'on' if fix else 'off'}  ->  http://{host}:{port}")
    if lab.sim.capture_error:
        print(f"[lab] CUDA graph capture fell back: {lab.sim.capture_error}")
    uvicorn.run(app, host=host, port=port, log_level="warning")
