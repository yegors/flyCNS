# flyCNS

## Street View route experiment

The lab now supports a bounded **A → B taught-route experiment**: select two map
points, teach a route through connected Google panoramas, then run the fly with
visual feedback. A seeded heading perturbation at each stop is corrected by
matching the current image against its taught view. Two aligned observations
authorize the next connected panorama step. Occluded vision stops movement.

**Scientific scope:** this is an external visual controller observing the live
MaleCNS simulation. It does not demonstrate that the connectome learned a route.
Coordinates and Google panorama links are used by the route teacher; only image
signatures enter the heading-error matcher. Translation uses the taught link.
The camera is Google's capture camera, not a reconstruction of a fly at street
level. Read [AUDIT.md](AUDIT.md) for the audit and remaining limitations.

Run `.venv/Scripts/python -m flylab serve` and open http://127.0.0.1:8000.

1. Configure the key as described below. Enable **Maps JavaScript API** and
   **Street View Static API**, with Google Cloud billing configured.
2. Use the default short Toronto route, enter `latitude, longitude`, or select
   **Pick A/B on map**. Points must be within 500 m and snap to different panoramas.
3. Click **Teach route**, then **Run trial**. Teaching may fail if coverage is
   disconnected or the graph/image budget is exceeded; choose a shorter route.
4. Repeat using **Vision occluded (control)** and the same seed. Expected result:
   no movement. Compare exported trial JSON, not just the animation.
5. **Pause**, **Stop**, **Export JSON**, and **Free exploration** control the trial.

Each observation records heading error, image correlation, ambiguity margin,
simulation time and smoothed neural readouts after at least 100 ms of biological
exposure. Exports include route/date metadata, seed, condition, model settings,
distance, request counts and explicit outcome. A session has a 160-image budget;
teaching allows 180 graph expansions and 25 panoramas. Trials have a five-minute
active wall-time limit. Google usage can be billable. Images and image signatures
are not included in exports; imagery is held briefly in memory only.

The default specimen uses **85 published anatomical meshes / 272,550 triangles**
from Janelia/DeepMind's flybody reconstruction, with joint hierarchy, original
material assignments and local asset provenance. This specimen is **female**;
the CNS dataset is **male**. Motion is illustrative joint animation, without
MuJoCo dynamics. The selector also provides the corrected procedural male model
with six articulated legs, trochanters, five tarsomeres, individual foreleg sex
comb teeth, posterior pigmentation, compound-eye lenses, ocelli and halteres.
See [anatomy attribution](flylab/web/assets/flybody/NOTICE.md) and the included
Apache-2.0 license. Rebuild these assets with
`.venv/Scripts/python scripts/import_flybody.py`.

Validation:

```bash
node --test tests/*.test.mjs
.venv/Scripts/python -m unittest discover -s tests -p "test_*.py" -v
```

Local verification on 2026-09-13 after API activation: Maps JavaScript display,
Street View metadata and actual Static imagery work. A live default Toronto
trial **arrived at B** over one connected 15 m step, using three visual
observations and ending at 0° heading error. A transient Google `UNKNOWN_ERROR`
on the first lookup cleared after repeating Teach route. The live CUDA/backend
smoke check also passed. Offline tests exercise pixel alignment and the full
trial state machine, including arrival, occlusion, pause/resume and cancellation.

## Connectome engine and earlier experiments

A GPU lab for running experiments on a simulated male fruit-fly nervous system, built on the
MaleCNS v1.0 connectome (HHMI Janelia / Google Research, released September 2026, CC-BY 4.0).

Every one of the fly's 165,122 traced neurons is simulated as a leaky integrate-and-fire unit,
wired with the real synapse counts and the predicted transmitter of each neuron. You activate
neurons by name ("sugar", "looming", "steer") and read out what fires ("proboscis_mn",
"giant_fiber", "wing_mn"). No neuroscience background is needed to run the experiments; the
glossary at the bottom covers the words that come up.

## Setup

Requires an NVIDIA GPU (tested on an RTX 5090) and Python 3.11.

```bash
python -m venv .venv
.venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv/Scripts/python -m pip install -r requirements.txt
```

Fetch the three data files (about 1.1 GB total) into `data/`:

```bash
mkdir -p data && cd data && B=https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome && curl -L -o weights.feather $B/connectome-weights-male-cns-v1.0-minconf-0.5.feather && curl -L -o annotations.feather $B/body-annotations-male-cns-v1.0-minconf-0.5.feather && curl -L -o neurotransmitters.feather $B/body-neurotransmitters-male-cns-v1.0.feather
```

Then build the cached brain once (about 10 s):

```bash
.venv/Scripts/python -m flylab prepare
```

## The web lab

```bash
.venv/Scripts/python -m flylab serve      # then open http://127.0.0.1:8000
```

The server runs the brain on the GPU and streams every spike to the browser over a WebSocket.
One screen holds the whole experiment, with a control panel where you switch stimuli on and off
by name and watch the motor readouts respond:

- **Map**: the fly lives on a map in closed loop. Food you drop (or restaurants found through
  Places) excites its smell and taste neurons, sweeping the cursor at it excites the looming
  neurons, and its steering, walking and wing neurons move it. Works on OpenStreetMap out of the
  box. One hack is declared in the interface: a hunger signal drives the forward-walking neuron
  DNp09, because nothing in a connectome starts walking on its own.
- **Brain**: all 165,122 neurons at their real positions, coloured by region, flashing as they
  spike. Orbit, zoom, click a neuron to identify it, hover a stimulus chip to see where those
  neurons are.
- **Eyes**: the view ahead of the fly projected onto its real retina. Each traced R1-R6
  photoreceptor has a visual direction (from the column of its lamina target in the connectome)
  and gets a Poisson rate from the brightness there. Sources: Google Street View, a synthetic
  street, a moving bar for optomotor tests, or a bright half-field. The side panel shows the
  lamina, T4/T5, LC4/LPLC2 and steering readouts per side.
- **Fly**: a published female anatomical reference with a separate procedural male illustration (compound eyes with facets,
  ocelli, aristae, scutellum, banded abdomen with the male's black tip, five-segment tarsi with
  claws and sex combs, veined wings, halteres), animated by its own motor neurons: MN9 extends
  the male illustration's proboscis, DNp09 walks, DNg11 grooms, the giant fiber jumps, wing motor neurons fly after a
  jump or buzz on the ground, pIP10 sings with one wing.
- **Experiments** (second tab): the results gallery, with re-run buttons.

Any panel expands to full size with the ⤢ button.

### Google Maps and Street View

Put a browser API key in `flylab.local.json` (`{"google_maps_api_key": "..."}`) or set
`GOOGLE_MAPS_API_KEY`. Enable Maps JavaScript API and Street View Static API on
the project. Places is optional and used only by the free-exploration food search.
The browser key is necessarily delivered to the Maps JavaScript client. For
separate browser/server restrictions, also set `google_maps_server_key` in the
ignored local JSON file or `GOOGLE_MAPS_SERVER_KEY`; this separate key is never
returned by `/api/config`. The local config is ignored by Git.

Route mode requests images by the exact panorama ID, heading and a rectilinear
120° field of view. The server serializes requests at up to two per second and
holds at most 64 responses for five minutes in memory. HTTP responses use
`Cache-Control: no-store`. Image failures stop a trial and remain visible.
See [Google's request documentation](https://developers.google.com/maps/documentation/streetview/request-streetview)
and [panorama-link documentation](https://developers.google.com/maps/documentation/javascript/reference/street-view-service).

What to expect from the **connectome alone**: the fly does not read signs. In the current model, visual input modulates the
lamina and drives the looming detectors LC4/LPLC2 strongly, while the motion pathway T4/T5 stays
silent and the steering asymmetry from a bright half-field is small (see Findings). So on Street
View it behaves like a phototactic insect at best: it tends toward the brighter side of the view,
which on a street is usually the open road and sky. Making the motion pathway work (holds for the
medulla interneurons, or a graded model of them) is the next modelling step.

## Using the lab from the command line

```bash
python -m flylab aliases                      # names you can stimulate or read
python -m flylab find sugar                   # search cell types by name or synonym
python -m flylab info                         # dataset summary
python -m flylab run all                      # the three experiments below (about 4 min)
python -m flylab stim sugar -r proboscis_mn -r feeding_mn --name my_test
python -m flylab stim looming -r giant_fiber -r wing_mn --silence type:LC4
python -m flylab stim steer --side L -r descending -r leg_mn
python -m flylab stim bitter -r kenyon --inhibit antennal_lobe_ln   # with the runaway fix
python -m flylab bench                        # engine throughput
```

Every run writes a raster plot and a JSON summary to `results/`.

From Python:

```python
from flylab import load_brain, Atlas, Sim
brain = load_brain()
atlas = Atlas(brain)
sim = Sim(brain, seed=0)
sim.set_sign(atlas.resolve("antennal_lobe_ln"), -1)   # the runaway fix, see Findings
sim.drive(atlas.resolve("sugar"))                    # 150 Hz Poisson drive, like optogenetic activation
res = sim.run(1000)                                  # 1 s of biological time
print(res.rate_hz(atlas.resolve("proboscis_mn")))
```

Queries accepted anywhere a name is: an alias, an exact type name (`DNp01`), `type:A,B`,
`re:^DNa0`, `class:gustatory`, `super:descending_neuron`, `body:10001`. Manipulations:
`drive` (activate), `silence` (remove a neuron's output), `set_sign` (override its transmitter
sign), `scale_synapses` (change specific connections, for plasticity experiments).

## Experiments and findings

Three seeds per condition, 1 s of biological time each, driven neurons at 150 Hz. Numbers are
from `results/*.json` on 2026-09-13.

**1. Taste to feeding** (`sugar`). A fly extends its proboscis when it tastes sugar and not when
it tastes bitter. Shiu et al. 2024 showed the connectome model reproduces this, which makes it
the standard first test that a whole-brain fly model is wired correctly.

| drive | MN9 proboscis motor neuron, mean Hz | notes |
|---|---|---|
| nothing | 0.0 | network silent at rest, as designed |
| sugar (23 neurons) | 13.0 (range 4.5 to 27.5) | |
| bitter (38) | 0.7 | |
| sugar + bitter | 3.7 | bitter suppresses the sugar response |
| water (17) | 24.5 | see runaway below; 0.0 with the fix |

**2. Looming to escape** (`looming`). Fast-expanding objects excite LC4 and LPLC2, which drive
the giant fiber, the command neuron for the escape jump. Because this dataset includes the nerve
cord, the command can be followed across the neck to the wing motor neurons that power takeoff.

| drive | giant fiber, Hz | wing motor neurons DLMn/DVMn, Hz |
|---|---|---|
| LC4 + LPLC2 (311 neurons) | 384 | 217 |
| LC4 alone | 212 | 206 |
| LPLC2 alone | 328 | 178 |
| LC16, a different visual type (control) | 0 | 184 |

**3. The runaway state** (`runaway`). In the runs above, 14 of 30 trials fell into a state where
about 13,000 neurons (8% of the brain) fire for as long as the stimulus lasts, whatever the
stimulus. The hottest cells are Kenyon cells and the antennal-lobe local neurons lLN1/lLN2, 82
of which are labelled cholinergic (excitatory) although they are inhibitory in the real fly.
TheMrRaGe/flybrain reported the same. Forcing those 151 neurons inhibitory:

| variant | runaway trials | Kenyon cells active | MN9 sugar / bitter, Hz | giant fiber under LC4, Hz |
|---|---|---|---|---|
| transmitters as labelled | 10 of 12 | about 2,600 | 13.0 / 0.7 | 212 |
| lLN1/lLN2 forced inhibitory | 0 of 12 | about 40 | 6.2 / 0.0 | 336 |

The fix removes the instability and the specific pathway results survive, so it is the
recommended default for further work (`--inhibit antennal_lobe_ln`, or `set_sign` in Python).

**4. Vision** (live, in the Eyes panel). With lamina neurons L1-L3 held 7.5 mV above rest and
photoreceptors firing 90 Hz in the dark and 0 Hz in light (the reference project's convention;
the biological polarity gives a silent optic lobe in a spiking model), a bright left half-field
gives left lamina 13 Hz vs right 10 Hz, drives LC4/LPLC2 to about 60 Hz vs 45 Hz, and produces
only a small steering-neuron asymmetry (about 1.5 vs 0.5 Hz). T4/T5 motion detectors do not fire
under any stimulus tried, moving bar included: the medulla interneurons between lamina and T4/T5
are graded cells with no drive of their own in this model.

Three things the reader should know. Firing rates of hundreds of Hz on the giant fiber reflect a
maximal artificial stimulus, not a natural one. The wing power-muscle motor neurons (DLMn, DVMn)
fire under almost any stimulus, sugar included; they are very large cells with thousands of
inputs and the model has no size normalisation, so the web lab only lets the fly take off after
an escape jump and shows steady wing-motor activity as a buzz. And the engine has not yet been
checked spike for spike against the Brian2 reference implementation; that is on the list.

## How the model works

The neuron model and every constant follow Shiu et al. 2024 (Nature), the paper that
established connectome-based LIF simulation for the fly:

| quantity | value |
|---|---|
| resting and reset potential | -52 mV |
| threshold | -45 mV |
| membrane time constant | 20 ms |
| synaptic time constant | 5 ms |
| refractory period | 2.2 ms |
| synaptic delay | 1.8 ms |
| weight per synapse | 0.275 mV, signed by the presynaptic neuron's transmitter |
| activation | 150 Hz Poisson events of 250 x 0.275 mV; refractory period removed |
| timestep | 0.1 ms |

Sign convention: acetylcholine excitatory; GABA, glutamate and histamine inhibitory; monoamines
excitatory; unknown transmitter contributes nothing. Connections with fewer than 5 synapses are
dropped by default (`--min-weight 1` keeps all 25.5M edges). The network has no background
noise, so it is completely silent until you drive something. That is by design in the reference
model and also the reason some circuits that depend on tonic inhibition behave oddly.

Engine: `flylab/engine.py`, PyTorch on CUDA. All state lives in preallocated GPU tensors and the
clock is a device scalar, so 100 steps (10 ms of fly time) are captured once in a CUDA graph and
replayed with one launch; propagation is one sparse matrix-vector product per 0.1 ms step.
6,100 steps/s on an RTX 5090, 0.6x real time (1,700 steps/s without the graph). Data loading
and caching: `flylab/data.py`. Name resolution and curated aliases: `flylab/atlas.py`.
Experiments: `flylab/experiments/`. Web server and protocol: `flylab/server.py`, frontend in
`flylab/web/` (three.js, no build step).

## Next steps

- Wake the motion pathway: holds (or a graded model) for the medulla interneurons Mi1, Tm3, Mi4,
  Mi9, Tm1, Tm2 so T4/T5 and the optomotor response work; then test steering on the moving bar.
- Reach real time: a larger chunk, a smaller readout set, or a fused elementwise kernel.
- Cross-validate against the Brian2 reference model on a small circuit.
- Make the lLN fix (and any others that earn it) a named preset.
- Then the fun part: a mushroom-body novelty detector on a real data stream, the lab exposed
  as an MCP server, courtship song from the pC1 to pIP10 to wing motor pathway, and the nerve
  cord's leg motor neurons driving a MuJoCo body.

## Glossary for non-biologists

- **connectome**: the complete wiring diagram, which neuron connects to which and with how many synapses.
- **LIF, leaky integrate-and-fire**: the simplest useful neuron model. Inputs push a voltage up, it leaks back down, and when it crosses a threshold the neuron spikes and resets.
- **GRN, gustatory receptor neuron**: a taste-sensing neuron. Labellar GRNs sit on the fly's mouthparts. Types here are named by body part and cluster (LB3c is the sugar class).
- **MN9**: the motor neuron that extends the proboscis. If it fires, the fly is trying to feed.
- **DN, descending neuron**: about 1,300 neurons that carry commands from the brain down the neck to the nerve cord. DNp01 is the giant fiber (escape), DNa02 steers.
- **VNC, ventral nerve cord**: the fly's spinal cord, where leg and wing motor neurons live. New in this dataset: the brain and cord are connected.
- **LC4, LPLC2**: visual neurons that respond to looming (approaching) objects. **DLMn, DVMn**: motor neurons of the wing power muscles.
- **antennal lobe, lLN**: the first smell-processing stage and its local interneurons, which normally keep each odour channel separate.
- **Kenyon cells, MBONs, PAM, PPL1**: the mushroom body, the fly's learning centre. Kenyon cells encode a sparse code of what the fly senses, dopamine neurons (PAM reward, PPL1 punishment) modify their synapses onto MBONs, whose output biases approach or avoidance.
- **pC1 / P1, pIP10**: male-specific courtship command neurons and the song neuron. This dataset is the first to contain them.
- **Poisson drive**: feeding a neuron random input pulses at a set rate, the simulation's stand-in for switching neurons on with light (optogenetics).

## Credits

Data: FlyEM (HHMI Janelia), Cambridge Connectomics, MRC LMB, Google Research. Model: Shiu et al.
2024. Taste cell-type assignments: the companion taste connectome (Cell 2026) as summarised in
TheMrRaGe/flybrain FINDINGS.md, whose empirical notes on this dataset were invaluable.
