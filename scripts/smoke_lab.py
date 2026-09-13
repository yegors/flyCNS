"""Check an already running localhost lab, without making any Google requests."""
import asyncio
import json
import struct
import sys
import urllib.error
import urllib.request

import websockets

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8000'


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=20) as response:
        return json.load(response)


async def main():
    cfg = get('/api/config')
    retina = get('/api/retina')
    assert cfg['n'] > 100000 and len(retina['az']) == retina['n']
    assert 'google_maps_server_key' not in cfg
    try:
        get('/api/streetview?lat=100&lng=0')
        raise AssertionError('Invalid coordinates accepted')
    except urllib.error.HTTPError as exc:
        assert exc.code == 422
    async with websockets.connect(BASE.replace('http', 'ws', 1) + '/ws', max_size=4_000_000) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), 10))
        assert hello['hello']
        await ws.send(json.dumps({'cmd': 'reset'}))
        await ws.send(json.dumps({'cmd': 'play'}))
        reset, frame = False, None
        for _ in range(100):
            message = await asyncio.wait_for(ws.recv(), 10)
            if isinstance(message, str):
                reset |= json.loads(message).get('event') == 'reset'
            else:
                size = struct.unpack_from('<I', message)[0]
                frame = json.loads(message[4:4 + size])
                assert (len(message) - 4 - size) % 4 == 0
            if reset and frame is not None: break
        assert reset and frame is not None
        rates = bytes([1]) + bytes([40]) * retina['n']
        await ws.send(rates)
        for _ in range(100):
            message = await asyncio.wait_for(ws.recv(), 10)
            if isinstance(message, bytes):
                size = struct.unpack_from('<I', message)[0]
                frame = json.loads(message[4:4 + size])
                if frame['retina']: break
        assert frame['retina']
        await ws.send(json.dumps({'cmd': 'clear'}))
        print(json.dumps({'neurons': cfg['n'], 'retina_receptors': retina['n'], 'device': cfg['sim']['device'],
                          'reset_acknowledged': reset, 'binary_retina_accepted': frame['retina'], 'coordinate_validation': 'passed'}))


asyncio.run(main())
