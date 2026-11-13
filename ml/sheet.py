"""Contact sheet of crops with their labels; centre ring marks the labelled point."""
import os, sys, pandas as pd
from PIL import Image, ImageDraw
M = pd.read_csv('data/manifest.csv', low_memory=False).set_index('id')
have = [f[:-4] for f in os.listdir('data/crops') if f.endswith('.jpg')]
sel = M.loc[have]
if len(sys.argv) > 2: sel = sel[sel.split == sys.argv[2]]
ids = sel.sample(min(30, len(sel)), random_state=1).index
sheet = Image.new('RGB', (6 * 192, 5 * 212), 'white'); d = ImageDraw.Draw(sheet)
for k, i in enumerate(ids):
    x, y = (k % 6) * 192, (k // 6) * 212
    sheet.paste(Image.open(f'data/crops/{i}.jpg'), (x, y))
    d.ellipse([x + 92, y + 92, x + 100, y + 100], outline='red', width=2)
    r = M.loc[i]; d.text((x + 2, y + 194), f"{r.sp if isinstance(r.sp, str) else r.genus} {r.dbh_cm} {r.split}", fill='black')
sheet.save(sys.argv[1])
