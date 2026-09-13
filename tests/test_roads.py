import io
import json
import unittest
from fastapi import HTTPException
from flylab.roads import RoadClient

class RoadTests(unittest.TestCase):
    def test_bounded_query_is_cached_and_never_includes_google_credentials(self):
        calls = []
        def open_request(request, timeout):
            calls.append((request, timeout))
            return io.BytesIO(json.dumps({'elements': [{'id': 1}]}).encode())
        client = RoadClient(open_request)
        first = client.get(43.6541, -79.3832)
        self.assertEqual(first, client.get(43.65412, -79.38321))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], 25)
        self.assertNotIn('key=', calls[0][0].data.decode())
        self.assertIn('OpenStreetMap', first['attribution'])

    def test_partial_extract_and_transport_failure_are_not_cached(self):
        responses = [b'{"remark":"runtime error", "elements": []}', b'{"elements":[{"id":2}]}']
        client = RoadClient(lambda *a, **k: io.BytesIO(responses.pop(0)))
        with self.assertRaises(HTTPException):
            client.get(43, -79)
        self.assertEqual(client.get(43, -79)['elements'][0]['id'], 2)
        def failed(*a, **k):
            raise OSError('network failed')
        with self.assertRaises(HTTPException) as error:
            RoadClient(failed).get(43, -79)
        self.assertEqual(error.exception.status_code, 503)

if __name__ == '__main__':
    unittest.main()
