"""Overlay topo (red), Annex (cyan), street-tree (yellow, label=pos) points on the 2025 ortho."""
import sys; sys.path.insert(0, '.')
import duckdb, tiles
from PIL import Image, ImageDraw

def render(cx, cy, R, out, con, extra=()):
    px, py = tiles.utm_to_pixel(cx, cy); size = int(2 * R / 0.108)
    img, (x0, y0) = tiles.window(float(px), float(py), size)
    im = Image.fromarray(img); d = ImageDraw.Draw(im)
    for t, col in [('topo', 'red'), ('annex', 'cyan'), ('street', 'yellow')] + list(extra):
        D = con.sql(f"select * from {t} where x between {cx-R} and {cx+R} and y between {cy-R} and {cy+R}").df()
        X, Y = tiles.utm_to_pixel(D.x.values, D.y.values)
        for i, (a, b) in enumerate(zip(X - x0, Y - y0)):
            d.ellipse([a-7, b-7, a+7, b+7], outline=col, width=3)
            if t == 'street': d.text((a+8, b-8), f"{D.address.iloc[i]}:{D.pos.iloc[i]} {D.genus.iloc[i]}", fill='yellow')
    im.save(out)
