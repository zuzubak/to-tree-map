"""Fetch and mosaic the City's 2025 8 cm orthophoto from its Web Mercator tile cache.

Level 20 is ~0.149 m/px in Mercator, ~0.108 m/px on the ground at Toronto's latitude,
so a 10 m crown is ~90 px. Tiles are cached on disk as the server's JPEGs.
"""
import io, math, os, threading
import numpy as np, requests
from PIL import Image
from pyproj import Transformer

URL = 'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_ortho_2025_color_8cm/MapServer/tile/{z}/{y}/{x}'
Z = 20
ORIGIN = 20037508.342787
RES = 2 * ORIGIN / (256 * 2 ** Z)   # Mercator metres per pixel at level Z
CACHE = os.path.join(os.path.dirname(__file__), 'data', 'tiles', str(Z))
_utm_to_merc = Transformer.from_crs(32617, 3857, always_xy=True)
_local = threading.local()


def _session():
    if not hasattr(_local, 's'):
        _local.s = requests.Session()
        _local.s.headers['User-Agent'] = 'tree-crown-research/0.1'
    return _local.s


def _fetch(tx, ty, p):
    r = _session().get(URL.format(z=Z, y=ty, x=tx), timeout=30)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = f'{p}.{threading.get_ident()}.part'
    with open(tmp, 'wb') as f:      # empty file = the server has no imagery here
        if r.status_code == 200 and r.headers.get('content-type', '').startswith('image'):
            f.write(r.content)
    os.replace(tmp, p)              # atomic, so a concurrent reader never sees half a file


def tile(tx, ty):
    """One 256x256 RGB tile as uint8 array; black if the server has none there."""
    p = os.path.join(CACHE, str(ty), f'{tx}.jpg')
    for attempt in range(3):
        if not os.path.exists(p):
            _fetch(tx, ty, p)
        if os.path.getsize(p) == 0:
            return np.zeros((256, 256, 3), np.uint8)
        try:
            return np.asarray(Image.open(p).convert('RGB'))
        except OSError:              # truncated from an earlier crash: refetch
            os.remove(p)
    raise IOError(f'tile {tx},{ty} unreadable after retries')


def merc_pixel(mx, my):
    """Global pixel coordinates (float) at level Z for Mercator metres."""
    return (mx + ORIGIN) / RES, (ORIGIN - my) / RES


def utm_to_pixel(x, y):
    mx, my = _utm_to_merc.transform(x, y)
    return merc_pixel(np.asarray(mx), np.asarray(my))


def window(px, py, size):
    """size x size crop whose centre is global pixel (px, py)."""
    x0, y0 = int(round(px - size / 2)), int(round(py - size / 2))
    tx0, ty0, tx1, ty1 = x0 // 256, y0 // 256, (x0 + size - 1) // 256, (y0 + size - 1) // 256
    m = np.concatenate([np.concatenate([tile(tx, ty) for tx in range(tx0, tx1 + 1)], 1)
                        for ty in range(ty0, ty1 + 1)], 0)
    ox, oy = x0 - tx0 * 256, y0 - ty0 * 256
    return m[oy:oy + size, ox:ox + size], (x0, y0)


def tiles_for(px, py, size):
    x0, y0 = int(round(px - size / 2)), int(round(py - size / 2))
    return {(tx, ty) for tx in range(x0 // 256, (x0 + size - 1) // 256 + 1)
            for ty in range(y0 // 256, (y0 + size - 1) // 256 + 1)}
