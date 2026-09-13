import hashlib
import json
import unittest
from pathlib import Path

import numpy as np

ASSETS = Path(__file__).resolve().parents[1] / 'flylab/web/assets/flybody'


class AnatomyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.meta = json.loads((ASSETS / 'anatomy.json').read_text())
        cls.data = (ASSETS / 'anatomy.bin').read_bytes()

    def test_packed_geometry_integrity_and_provenance(self):
        self.assertEqual(hashlib.sha256(self.data).hexdigest(), self.meta['binarySha256'])
        self.assertEqual(len(self.meta['meshes']), 85)
        self.assertEqual(sum(m['indexCount'] // 3 for m in self.meta['meshes'].values()), 272550)
        self.assertIn('female', self.meta['specimen'])
        for name, mesh in self.meta['meshes'].items():
            positions = np.frombuffer(self.data, dtype='<f4', count=mesh['vertexCount'] * 3, offset=mesh['positionOffset'])
            indices = np.frombuffer(self.data, dtype='<u4', count=mesh['indexCount'], offset=mesh['indexOffset'])
            self.assertTrue(np.isfinite(positions).all(), name)
            self.assertLess(indices.max(), mesh['vertexCount'], name)

    def test_hierarchy_keeps_paired_appendages_and_materials(self):
        stack, names = [self.meta['body']], []
        while stack:
            body = stack.pop(); names.append(body['name']); stack.extend(body['children'])
            self.assertAlmostEqual(sum(x * x for x in body['quat']), 1, delta=.005)
            for geom in body['geoms']:
                self.assertIn(geom['mesh'], self.meta['meshes'])
                self.assertIn(geom['material'], self.meta['materials'])
        for side in ['left', 'right']:
            self.assertIn('wing_' + side, names)
            self.assertIn('haltere_' + side, names)
            for leg in [1, 2, 3]: self.assertIn(f'coxa_T{leg}_{side}', names)


if __name__ == '__main__': unittest.main()
