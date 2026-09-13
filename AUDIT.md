# Street-learning audit · 2026-09-13

## What this version builds

A local visual-memory learning experiment over real Google Street View photos.
The main workflow is **choose A/B → Learn trip → Try from memory**. Brain tools
are optional. The detailed Janelia/DeepMind female fly body remains available;
MaleCNS is male, and body motion is illustrative rather than physical simulation.

## Learning and testing are separate

During a lesson, a bounded teacher finds a connected Street View route on public
OSM roads. It observes available directions at every route stop and stores visual
signatures paired with **go**, **avoid**, or **stop**. Where possible it also
teaches one off-route neighbour with a legal return. This is episodic imitation
learning: demonstrations add memories, not changes to the connectome's weights.

During a test, the environment presents images of the locally available street
directions in shuffled order, with seeded 10–20° camera perturbations. The learner
compares these images against all its memories. Its interface receives no GPS,
panorama IDs, destination coordinates, route index, or planned next-stop list.
It selects a direction or recognizes the finish. The environment independently
checks an arrival claim against the actual destination panorama; a visual false
positive fails the trial. Tests never add or modify memories.

The camera aligns using image error before movement. Movement follows OSM road
polylines between connected Google panoramas, rather than interpolating directly
across buildings. Simple one-way and access tags are respected. Capture-car
heading helps assign photos to the correct road at intersections. Nearby road
geometry and Google links are environment constraints, not learned perception.

## What the experiment does not demonstrate

- The biological fly brain has **not** learned navigation. It receives retinal
  input and its responses are observed. The known inactive motion pathway is
  not repaired by this change.
- This is memory-based navigation through previously demonstrated views. It does
  not establish generalization to unseen streets, seasons, weather or imagery.
  It can return from a specifically demonstrated wrong turn, not arbitrary loss.
- There is no traffic, lane keeping, signal recognition, vehicle avoidance,
  turn-restriction relation handling, muscle physics or real flight dynamics.
- Google panorama imagery is discontinuous and vehicle-height. A fly icon moves
  smoothly on the road while the camera updates at panorama stops.
- Google/OSM can disagree or lack coverage. Unmatched roads and uncertain images
  cause a stop. This is not road-safety software or a real self-driving system.
- Memories live in one browser tab and are cleared by Forget trip, point changes,
  a new lesson or reload. Images/signatures are not written into result exports.
- Multiple browser clients share one global neural simulation. Run one trial at
  a time. Learned state, external imagery and timing are not fully reproducible.

## Bugs addressed

- Removed competing free-roaming controls from the journey; movement always stays
  owned by the street environment, including before/after a trial.
- Fixed stale browser code mixing the old controls with a new page: versioned
  entry assets and no-store headers for HTML, JavaScript and CSS.
- Fixed intersection road assignment: nearest geometry alone could put a Bay
  Street panorama on a crossing one-way street and sever the route.
- Replaced narrow-strip recognition and noisy single-pixel samples with smoothed
  signatures and correlation over the full overlapping view.
- An ambiguous strongest memory cannot fall through to a weaker wrong memory.
  Conflicting actions and indistinguishable directions stop the learner.
- Pause/Stop use cancellation checkpoints around asynchronous work. Late photos
  cannot resume movement, and stopped photos remain visible without continuously
  stimulating the retina. Partial movement is included in exported distance.
- Controls, learned state and progress are reset together when the trip changes.
  Brain modifications are blocked during a running test.
- Street View transient UNKNOWN_ERROR receives bounded retries. Road extraction
  uses bounded requests, timeouts, a small cache, and rejects partial responses.

## Validation

All 27 automated tests passed (19 JavaScript, 8 Python), and all browser JavaScript
files passed syntax checks. The suite covers pixel yaw alignment, low-texture/occluded input,
learned vs empty memory, conflicting examples, shuffled directions, destination
false positives, learned recovery, directed street geometry, disconnected
crossings, intersection assignment, request limits, cancellation, pause/resume,
partial-distance accounting, API failures, key handling and anatomical assets.

The live CUDA smoke test passes: 165,122 neurons, 1,382 retinal receptors, reset
acknowledgement and binary retinal input. A real Bay Street lesson resolves a
103 m road route and builds 25 visual memories. Browser verification observed:

| Condition | Outcome | Distance |
| --- | --- | --- |
| Learned memory, seed 1 | Recognized finish; arrived | 103 m |
| Learned memory, seed 2 | Recognized finish; arrived | 103 m |
| Memory disabled, seed 1 | Stopped without knowing a direction | 0 m |
| Eyes covered, seed 1 | Stopped without vision | 0 m |
| Learned wrong turn, seed 1 | Returned and recognized finish | 114 m |

Pause held the recovery trial at 34 m; Resume completed it. Expanding Street View
and opening brain details preserved the trip. These results establish a working
demonstrated-route experiment, not general city-wide reliability.

## Sources

- [Google Street View service](https://developers.google.com/maps/documentation/javascript/reference/street-view-service).
- [Google Static camera parameters](https://developers.google.com/maps/documentation/streetview/request-streetview).
- [OSM highway tags](https://wiki.openstreetmap.org/wiki/Key:highway) and [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL).
- [Flybody research](https://doi.org/10.1038/s41586-025-09029-4) and [pinned anatomy source](https://github.com/google-deepmind/mujoco_menagerie/tree/ac6b2b09983786f3036cab1000221017fa2193b4/flybody).
