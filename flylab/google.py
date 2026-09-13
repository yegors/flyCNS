"""Bounded, in-memory Google Street View transport. Never includes keys in errors."""
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict

from fastapi import HTTPException


class StreetViewClient:
    def __init__(self, config, opener=urllib.request.urlopen, interval=0.5):
        self.config, self.opener, self.interval = config, opener, interval
        self.lock = threading.Lock()
        self.cache = OrderedDict()
        self.last_request = 0.0

    def get(self, url, params, binary=False):
        cfg = self.config()
        key = cfg.get('google_maps_server_key') or cfg.get('google_maps_api_key')
        if not key:
            raise HTTPException(503, 'No Google Maps server key configured in flylab.local.json.')
        cache_key = (key, url, urllib.parse.urlencode(params))
        with self.lock:
            cached = self.cache.get(cache_key)
            if cached and time.monotonic() - cached[0] < 300:
                self.cache.move_to_end(cache_key)
                return cached[1]
            time.sleep(max(0, self.interval - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            request_url = url + '?' + urllib.parse.urlencode({**params, 'key': key})
            try:
                with self.opener(request_url, timeout=12) as response:
                    data = response.read(4_000_001)
                    if len(data) > 4_000_000:
                        raise HTTPException(502, 'Street View response exceeded the image size limit.')
                    if binary and not response.headers.get('Content-Type', '').startswith('image/'):
                        raise HTTPException(502, 'Street View did not return an image. Check API activation and billing.')
            except urllib.error.HTTPError as exc:
                message = {403: 'Street View Static API denied this request. Enable that API and billing; check server-key restrictions.',
                           404: 'No Street View image exists for this panorama.',
                           429: 'Google Street View quota exceeded. Try later.'}.get(exc.code, 'Google Street View request failed.')
                raise HTTPException(502, message) from None
            except (urllib.error.URLError, TimeoutError, OSError):
                raise HTTPException(504, 'Google Street View could not be reached within the request timeout.') from None
            if not binary:
                try:
                    metadata = json.loads(data)
                except (ValueError, UnicodeError):
                    raise HTTPException(502, 'Invalid Street View metadata response.') from None
                # Failed activation must not stay cached after the user fixes Cloud configuration.
                if metadata.get('status') != 'OK':
                    return data
            self.cache[cache_key] = (time.monotonic(), data)
            while len(self.cache) > 64:
                self.cache.popitem(last=False)
            return data
