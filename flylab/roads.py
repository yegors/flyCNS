"""Small, cached public-road extracts for the local street-navigation environment."""
import json
import math
import threading
import time
import urllib.parse
import urllib.request
from fastapi import HTTPException


class RoadClient:
    def __init__(self, opener=urllib.request.urlopen):
        self.opener = opener
        self.lock = threading.Lock()
        self.cache = {}

    def get(self, lat, lng):
        # One bounded neighbourhood; rounded centres share an extract between trials.
        lat, lng = round(lat, 3), round(lng, 3)
        key = (lat, lng)
        with self.lock:
            cached = self.cache.get(key)
            if cached and time.monotonic() - cached[0] < 3600:
                return cached[1]
            dy = .008
            dx = min(.08, dy / max(.1, math.cos(math.radians(lat))))
            bbox = f'{lat-dy:.6f},{lng-dx:.6f},{lat+dy:.6f},{lng+dx:.6f}'
            query = ('[out:json][timeout:20];way["highway"~"^(primary|secondary|tertiary|'
                     'residential|unclassified|living_street|primary_link|secondary_link|tertiary_link)$"]'
                     f'({bbox});out geom;')
            request = urllib.request.Request('https://overpass-api.de/api/interpreter',
                data=urllib.parse.urlencode({'data': query}).encode(),
                headers={'User-Agent': 'flyCNS-local-lab/1.0'})
            try:
                with self.opener(request, timeout=25) as response:
                    raw = response.read(4_000_001)
                if len(raw) > 4_000_000:
                    raise ValueError('oversize')
                payload = json.loads(raw)
                if payload.get('remark') or not isinstance(payload.get('elements'), list):
                    raise ValueError('incomplete')
                result = {'elements': payload['elements'], 'attribution': '© OpenStreetMap contributors',
                          'fetchedAt': time.time()}
            except (OSError, ValueError):
                raise HTTPException(503, 'Street map is temporarily unavailable. Try Learn trip again in a minute.') from None
            if not result['elements']:
                raise HTTPException(404, 'No public city streets here. Choose points on nearby roads.')
            if len(self.cache) >= 8:
                self.cache.pop(next(iter(self.cache)))
            self.cache[key] = (time.monotonic(), result)
            return result
