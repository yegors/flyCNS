"""Reproducibly import the Apache-2.0 Janelia/DeepMind anatomical reference.

Downloads are cached under ignored data/. Outputs contain geometry, hierarchy,
joint limits, material assignments, provenance and the upstream license. No
MuJoCo dynamics are implied by this Three.js visualization conversion.
"""
import hashlib
import json
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
COMMIT = 'ac6b2b09983786f3036cab1000221017fa2193b4'
BASE = f'https://raw.githubusercontent.com/google-deepmind/mujoco_menagerie/{COMMIT}/flybody/'
CACHE = ROOT / 'data' / 'flybody-source'
OUT = ROOT / 'flylab' / 'web' / 'assets' / 'flybody'


def get(name):
    path = CACHE / name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(BASE + name, timeout=45) as response:
            path.write_bytes(response.read())
    return path.read_bytes()


def vector(text, default):
    return [float(x) for x in text.split()] if text else default


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    xml = get('fruitfly.xml')
    root = ET.fromstring(xml)
    definitions = root.findall('./asset/mesh')
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda m: get('assets/' + m.attrib['file']), definitions))
    defaults = {}
    def default_tree(element, inherited=None):
        value = {k: dict(v) for k, v in (inherited or {}).items()}
        for child in element:
            if child.tag != 'default': value.setdefault(child.tag, {}).update(child.attrib)
        defaults[element.get('class', '')] = value
        for child in element.findall('default'): default_tree(child, value)
    default_tree(root.find('default'))
    blob = bytearray()
    meshes = {}
    for mesh in definitions:
        raw = get('assets/' + mesh.attrib['file'])
        positions, faces = [], []
        for line in raw.decode().splitlines():
            fields = line.split()
            if not fields: continue
            if fields[0] == 'v': positions.append([float(x) for x in fields[1:4]])
            elif fields[0] == 'f':
                ids = [int(x.split('/')[0]) for x in fields[1:]]
                ids = [i - 1 if i > 0 else len(positions) + i for i in ids]
                for i in range(1, len(ids) - 1): faces.extend([ids[0], ids[i], ids[i + 1]])
        vertices = np.asarray(positions, dtype='<f4')
        indices = np.asarray(faces, dtype='<u4')
        assert vertices.size and indices.max() < len(vertices)
        meshes[mesh.attrib['name']] = dict(positionOffset=len(blob), vertexCount=len(vertices),
            indexOffset=len(blob) + vertices.nbytes, indexCount=len(indices), source=mesh.attrib['file'], sha256=hashlib.sha256(raw).hexdigest())
        blob.extend(vertices.tobytes()); blob.extend(indices.tobytes())
    def body(element, inherited='body'):
        klass = element.get('childclass', inherited)
        out = dict(name=element.get('name', ''), pos=[x * 10 for x in vector(element.get('pos'), [0, 0, 0])],
                   quat=vector(element.get('quat'), [1, 0, 0, 0]), geoms=[], joints=[], children=[])
        for geom in element.findall('geom'):
            if not geom.get('mesh'): continue
            props = {**defaults.get(geom.get('class', klass), {}).get('geom', {}), **geom.attrib}
            out['geoms'].append(dict(mesh=props['mesh'], material=props.get('material', 'body'),
                pos=[x * 10 for x in vector(props.get('pos'), [0, 0, 0])], quat=vector(props.get('quat'), [1, 0, 0, 0])))
        for joint in element.findall('joint'):
            props = {**defaults.get(joint.get('class', klass), {}).get('joint', {}), **joint.attrib}
            out['joints'].append(dict(name=props.get('name', ''), axis=vector(props.get('axis'), [0, 0, 1]),
                pos=[x * 10 for x in vector(props.get('pos'), [0, 0, 0])], range=vector(props.get('range'), [-3.14, 3.14]), rest=float(props.get('springref', '0'))))
        out['children'] = [body(b, klass) for b in element.findall('body')]
        return out
    materials = {m.attrib['name']: vector(m.get('rgba'), [1, 1, 1, 1]) for m in root.findall('./asset/material')}
    document = dict(source=BASE, commit=COMMIT, specimen='female Drosophila melanogaster', license='Apache-2.0',
        units='mm', conversion='OBJ indexed positions; recomputed normals; MJCF centimetres to millimetres; spring-reference joint posture; display only',
        binarySha256=hashlib.sha256(blob).hexdigest(), meshes=meshes, materials=materials, body=body(root.find('./worldbody/body')))
    (OUT / 'anatomy.bin').write_bytes(blob)
    (OUT / 'anatomy.json').write_text(json.dumps(document, separators=(',', ':')), encoding='utf-8')
    (OUT / 'LICENSE').write_bytes(get('LICENSE'))
    print(f"Imported {len(meshes)} anatomical meshes, {len(blob)/1e6:.1f} MB, pinned commit {COMMIT}")


if __name__ == '__main__': main()
