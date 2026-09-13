import * as THREE from 'three';

let shared;
async function assets() {
  if (!shared) shared = (async () => {
    const base = '/static/assets/flybody/';
    const [metaResponse, binResponse] = await Promise.all([fetch(base + 'anatomy.json'), fetch(base + 'anatomy.bin')]);
    if (!metaResponse.ok || !binResponse.ok) throw new Error('Research anatomy assets unavailable. Run scripts/import_flybody.py.');
    const meta = await metaResponse.json(), bytes = await binResponse.arrayBuffer(), geometry = {}, materials = {};
    for (const [name, m] of Object.entries(meta.meshes)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bytes, m.positionOffset, m.vertexCount * 3), 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(bytes, m.indexOffset, m.indexCount), 1));
      g.computeVertexNormals(); g.computeBoundingSphere(); geometry[name] = g;
    }
    for (const [name, rgba] of Object.entries(meta.materials)) {
      const membrane = name === 'membrane';
      materials[name] = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(...rgba.slice(0, 3)),
        roughness: membrane ? .18 : name === 'red' ? .32 : .58,
        clearcoat: name === 'red' || name === 'ocelli' ? .6 : .05,
        transparent: membrane, opacity: membrane ? .35 : rgba[3], side: THREE.DoubleSide,
        depthWrite: !membrane, iridescence: membrane ? .4 : 0 });
    }
    return { meta, geometry, materials };
  })();
  return shared;
}

// A display adapter for the upstream MJCF hierarchy. This is deliberately not a
// MuJoCo integrator: motions below are bounded illustrative joint excursions.
export async function createAnatomicalFly() {
  const { meta, geometry, materials } = await assets(), joints = [];
  const transform = (group, node) => {
    group.position.fromArray(node.pos);
    const [w, x, y, z] = node.quat; group.quaternion.set(x, y, z, w).normalize();
  };
  function build(node) {
    const base = new THREE.Group(); base.name = node.name; transform(base, node);
    let parent = base;
    for (const joint of node.joints) {
      const pivot = new THREE.Group(); pivot.position.fromArray(joint.pos); pivot.name = joint.name;
      const axis = new THREE.Vector3(...joint.axis).normalize(); pivot.quaternion.setFromAxisAngle(axis, joint.rest);
      parent.add(pivot); const inverse = new THREE.Group(); inverse.position.fromArray(joint.pos).negate(); pivot.add(inverse); parent = inverse;
      joints.push({ ...joint, pivot, axis });
    }
    for (const geom of node.geoms) {
      const mesh = new THREE.Mesh(geometry[geom.mesh], materials[geom.material] || materials.body);
      mesh.name = geom.mesh; mesh.castShadow = geom.material !== 'membrane'; mesh.receiveShadow = true; transform(mesh, geom); parent.add(mesh);
    }
    for (const child of node.children) parent.add(build(child));
    return base;
  }
  const group = new THREE.Group(), orientation = new THREE.Group();
  orientation.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)));
  orientation.add(build(meta.body)); group.add(orientation); group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group); orientation.position.y = -bounds.min.y;
  group.name = 'Janelia / DeepMind female anatomical reference'; group.userData.provenance = meta.commit;
  let phase = 0;
  function update(dt, motor = {}, time = 0) {
    const walk = Math.min(1, (motor.walk || 0) / 25); phase += dt * 2.5 * walk;
    for (const joint of joints) {
      let angle = joint.rest;
      const leg = joint.name.match(/T([123])_(left|right)/);
      if (leg) {
        const p = phase * Math.PI * 2 + ((Number(leg[1]) + (leg[2] === 'left' ? 1 : 0)) % 2) * Math.PI;
        if (joint.name.startsWith('coxa_abduct')) angle += .12 * walk * Math.sin(p);
        if (/^femur_T/.test(joint.name)) angle += .18 * walk * Math.sin(p);
        if (/^tibia_T/.test(joint.name)) angle += .16 * walk * Math.max(0, Math.sin(p));
      }
      if (joint.name.includes('haltere')) angle += .035 * walk * Math.sin(time * 40);
      joint.pivot.quaternion.setFromAxisAngle(joint.axis, Math.max(joint.range[0], Math.min(joint.range[1], angle)));
    }
    return { walk, speed: walk * 2.5, flying: false, jumping: false, eating: false, grooming: false, singing: false, backing: false, buzzing: false };
  }
  return { group, update, reference: true };
}
