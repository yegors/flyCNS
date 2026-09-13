# Repository audit and experiment contract · 2026-09-13

Scope: data loading, LIF engine, live server/protocol, map and eye feedback,
specimen geometry, experiment controls and existing documentation. This was a
functional/scientific audit and implementation pass, not an independent
replication of the existing neuroscience findings.

## Findings and changes

| Priority | Finding | Resolution |
| --- | --- | --- |
| P1 | No destination, route planning, arrival criterion or trial record existed. | Added bounded connected-panorama route teaching, visual alignment, explicit outcomes, seeds, occlusion controls and JSON export. |
| P1 | The existing connectome's T4/T5 pathway is documented as silent; goal-directed visual navigation could not be attributed to it. | External controller is explicitly labelled; retina drives the CNS and neural activity is recorded. No claim of learned connectome navigation. |
| P1 | Coordinate probes in the old Street View loop could select the same panorama or an unrelated location. | Route trials traverse only provider-declared directed links and request imagery by exact panorama ID. The old free-exploration mode remains a demonstration, outside the trial protocol. |
| P1 | Failed imagery could leave stale visual input active; failures were retried on render ticks. | Status checks, bounded backoff, generation checks, exact image identity and stop-on-failure behavior. |
| P1 | Latitude/longitude, panorama, heading, image-size and FOV requests were not constrained. | Validated query ranges, fixed sizes, bounded transport responses, request serialization and nonpersistent cache. |
| P1 | Eye sampling treated a perspective image as an angular panorama and clamped all rear receptors onto edge pixels. | Pinhole ray projection and explicit out-of-view masking. Retina angular calibration itself remains approximate. |
| P2 | Fly limbs omitted trochanters, sex combs were blocks, stance geometry lifted feet off the ground, and rest wings pointed forward. | Added leg segments, individual foreleg teeth, inverse-kinematic stance feet, corrected wing fold, posterior pigmentation and fine surface details. |
| P2 | Procedural geometry could not justify a high-fidelity reconstruction claim. | Added the published Janelia/DeepMind female flybody reference (85 original mesh parts, 272,550 triangles), pinned provenance, source hashes, rebuild script and Apache-2.0 license. Retained labelled male illustration. |
| P2 | Pause/disconnection could leave the world moving on old motor values. | Route-owned world, pause checkpoints, stop generation/cancellation, connection-loss stop, frozen model settings during trials. |
| P2 | Neural records could precede image exposure or retain old smoothing after reset. | Reset acknowledgement, smoothing reset, at least 100 ms biological exposure before each sample. |
| P2 | Server had no simulation/broadcast shutdown cleanup. | Added shutdown handling. |

## What the experiment tests

The teacher resolves A/B to outdoor Google panoramas, searches the actual link
graph, and captures a reference looking along each chosen exit. In a trial each
stop starts with a seeded 15–27° heading error. Normalized cross-correlation of
angular luminance samples estimates the error; the controller corrects it and
requires two observations within 3°. A weak or ambiguous match halts movement.
Traversal then follows the taught link at a virtual 4 m/s. The observation
matcher cannot access GPS, destination coordinates, panorama IDs or link headings.
The teacher and transition scheduler can access those values.

This is **route following with taught visual alignment**, not novel-route visual
SLAM, semantic street understanding, collision-aware flight, learned homing or
biological proof of cognition. It observes only a forward 120° camera view, with
off-camera receptors masked; it is not a 360° compound-eye rendering. The same
panorama's shifted views are an intentionally easier task than cross-location
visual place recognition. Identical seeds reproduce perturbations, but Google
imagery, GPU stochastic streams, timing and neural records are not guaranteed
bit-for-bit reproducible across sessions.

An occlusion trial must record `occluded`, travel zero metres and stay at A.
An intact trial can record `arrived` only at B's snapped panorama, after connected
transitions and valid observations. Missing coverage/API activation, low texture,
budget exhaustion, stalled simulation or cancellation must never count as arrival.

## Remaining scientific limitations

- The imported anatomical specimen is female while MaleCNS is male. This is
  disclosed in the viewer and metadata. The male alternative is an illustration,
  not a measured reconstruction. No shared whole-animal biological validation is
  claimed for either option.
- Research mesh topology and joint placement are retained, but browser motion is
  illustrative. MuJoCo contacts, body forces, trained policies, wing aerodynamics,
  haltere feedback and muscle dynamics are not simulated.
- The connectome retains the original inverse photoreceptor-drive convention,
  lamina hold and lLN transmitter override. The route controller does not repair
  or validate the inactive graded-cell motion circuit.
- Soma-derived retinal angles, approximate transmitter signs, thresholded edge
  counts and a common LIF model remain modelling assumptions. Existing raster
  findings were supplied by the repository and were not all rerun in this audit.
- This is a local, single-experiment lab. Multiple browser clients share one
  global brain. Do not run competing experiments from multiple tabs.
- Arrival is graph-based. Street View imagery is discontinuous, vehicle-height,
  potentially old and not a metric simulation of a fruit fly's environment.

## Validation evidence

- Existing environment: PyTorch 2.11.0+cu128, NVIDIA RTX 5090; live CUDA graph and
  neural readouts observed in the browser.
- After project API activation, real Google Maps display, Street View metadata
  (`OK`) and Static imagery (`200 image/jpeg`) were verified.
- A live intact trial on the default Toronto route reached B's snapped panorama:
  one connected step, 15 m, three visual observations, final heading error 0°.
  The session used five image requests including teaching and arrival imagery.
  The first panorama lookup returned Google's transient `UNKNOWN_ERROR`;
  repeating Teach route succeeded. One short successful route does not establish
  reliability across arbitrary streets or imagery conditions.
- Live backend smoke passed: 165,122 neurons, 1,382 retinal receptors, CUDA,
  reset acknowledgement, binary retina reception, invalid-coordinate rejection.
- Offline JavaScript tests cover synthetic image yaw recovery in both directions,
  rectilinear masking, ambiguous/blank input, graph detours and cycles, coverage
  failure, request budgets, deterministic seeds, complete trial arrival,
  occlusion, pause/resume and stale-request cancellation.
- Backend tests cover credentials in error messages, failed metadata caching,
  key rotation and missing configuration.

## Primary references

- [Google Street View panorama service and links](https://developers.google.com/maps/documentation/javascript/reference/street-view-service).
- [Google Street View Static camera parameters](https://developers.google.com/maps/documentation/streetview/request-streetview).
- [Vaxenburg et al., Whole-body physics simulation of fruit fly locomotion, Nature 2025](https://doi.org/10.1038/s41586-025-09029-4).
- [Pinned anatomy source and license](https://github.com/google-deepmind/mujoco_menagerie/tree/ac6b2b09983786f3036cab1000221017fa2193b4/flybody).
- [Held et al., Drosophila leg and sex-comb anatomy](https://www.depts.ttu.edu/biology/people/Faculty/Held/DISHeldEtAl2018.pdf).
