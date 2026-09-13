# Anatomical reference specimen

Geometry: Google DeepMind / HHMI Janelia, distributed through
[MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie/tree/ac6b2b09983786f3036cab1000221017fa2193b4/flybody).
Pinned revision: `ac6b2b09983786f3036cab1000221017fa2193b4`.
Upstream license: Apache-2.0, reproduced in `LICENSE`.

This is a **female Drosophila melanogaster** reconstructed from confocal imaging.
The lab's MaleCNS nervous-system dataset is male; displaying this reference does
not establish a sex-matched whole-animal simulation.

Publication: Vaxenburg et al., *Whole-body physics simulation of fruit fly
locomotion*, Nature (2025), https://doi.org/10.1038/s41586-025-09029-4.
Original project: https://github.com/TuragaLab/flybody.

Modifications in this repository: OBJ meshes packed into indexed float32/uint32
buffers; normals recomputed; MJCF hierarchy converted to JSON with centimetre
translations converted to millimetres; materials adapted for Three.js;
joint spring references used as a display posture; bounded illustrative joint
animation. Geometry is not decimated. Physics, contacts, actuators, and trained
locomotion policies are not imported. See `scripts/import_flybody.py`.

85 mesh assets, 272,550 triangles. Each original OBJ's SHA-256 and the packed
binary SHA-256 are recorded in `anatomy.json`. The corrected procedural male
illustration remains available in the specimen selector.
