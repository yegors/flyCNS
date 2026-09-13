import io
import json
import unittest
import urllib.error

from fastapi import HTTPException
from flylab.google import StreetViewClient


class Response(io.BytesIO):
    headers = {'Content-Type': 'image/jpeg'}


class GoogleTransportTests(unittest.TestCase):
    def test_success_cache_and_key_rotation(self):
        calls = []
        config = {'google_maps_api_key': 'secret-one'}
        def open_url(url, **kwargs):
            calls.append(url)
            return Response(b'jpeg')
        client = StreetViewClient(lambda: config, open_url, interval=0)
        for _ in range(2):
            self.assertEqual(client.get('https://maps.googleapis.com/maps/api/streetview', {'pano': 'a'}, True), b'jpeg')
        self.assertEqual(len(calls), 1)
        config['google_maps_api_key'] = 'secret-two'
        client.get('https://maps.googleapis.com/maps/api/streetview', {'pano': 'a'}, True)
        self.assertEqual(len(calls), 2)

    def test_denials_and_timeouts_hide_credentials(self):
        for error in [urllib.error.HTTPError('https://example/?key=SECRET', 403, 'SECRET', {}, None), urllib.error.URLError('SECRET')]:
            def fail(*args, **kwargs):
                raise error
            client = StreetViewClient(lambda: {'google_maps_api_key': 'SECRET'}, fail, interval=0)
            with self.assertRaises(HTTPException) as raised:
                client.get('https://maps.googleapis.com/maps/api/streetview', {}, True)
            self.assertNotIn('SECRET', raised.exception.detail)
            self.assertIn(raised.exception.status_code, [502, 504])

    def test_failed_metadata_is_not_cached(self):
        calls = []
        def open_url(*args, **kwargs):
            calls.append(1)
            return Response(json.dumps({'status': 'REQUEST_DENIED'}).encode())
        client = StreetViewClient(lambda: {'google_maps_api_key': 'secret'}, open_url, interval=0)
        client.get('https://maps.googleapis.com/maps/api/streetview/metadata', {})
        client.get('https://maps.googleapis.com/maps/api/streetview/metadata', {})
        self.assertEqual(len(calls), 2)

    def test_missing_key(self):
        with self.assertRaises(HTTPException) as raised:
            StreetViewClient(lambda: {}).get('https://maps.googleapis.com/maps/api/streetview', {})
        self.assertEqual(raised.exception.status_code, 503)


if __name__ == '__main__':
    unittest.main()
