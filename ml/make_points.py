"""Every place we'll ask the model about: the City's topographic tree points (crowns traced
from 2021 aerial survey, private trees included) plus inventory street trees that sit on
the boulevard or in a park but have no topo point within 3 m. Parcel-geocoded inventory
points are left out: they sit on roofs, not trees.

Each point carries the nearest boulevard/park inventory tree within 3 m (if any), so the
map can show what the City's inventory says next to what the model says.

Writes data/points.csv (pid, lon, lat, src, object_id) for the Kaggle job.
"""
import os
import duckdb, numpy as np, pandas as pd
from scipy.spatial import cKDTree

D = os.path.join(os.path.dirname(__file__), 'data')
con = duckdb.connect(os.path.join(D, 'ml.duckdb'), read_only=True)
con.sql("attach '" + os.path.join(os.path.dirname(__file__), '..', 'data', 'warehouse.duckdb') + "' as wh (read_only)")
T = con.sql('select x, y, lon, lat from topo').df()
S = con.sql("""select s.object_id, s.x, s.y, s.lon, s.lat, s.site, ts.dist_m,
                      upper(seg.street_name) = upper(s.street_name) same_street
               from street s left join wh.geo.tree_segment ts using (object_id)
               left join wh.geo.street_segments seg using (centreline_id)""").df()
S = S[((S.dist_m <= 11) & S.same_street.fillna(False).astype(bool)) | S.site.notna()]
S = S.drop_duplicates(['x', 'y'])          # stacked records share one crown

d, j = cKDTree(S[['x', 'y']].values).query(T[['x', 'y']].values, distance_upper_bound=3)
T['src'] = 't'
T['object_id'] = np.where(np.isfinite(d), S.object_id.values[np.minimum(j, len(S) - 1)], -1)
dt, _ = cKDTree(T[['x', 'y']].values).query(S[['x', 'y']].values)
extra = S[dt > 3].assign(src='s')
P = pd.concat([T[['lon', 'lat', 'src', 'object_id']], extra[['lon', 'lat', 'src', 'object_id']]], ignore_index=True)
P['object_id'] = P.object_id.astype('int64')

# order by z20 tile so the Kaggle job walks the city tile by tile
n = 256 * 2 ** 20
px = (P.lon + 180) / 360 * n
py = (1 - np.log(np.tan(np.radians(P.lat)) + 1 / np.cos(np.radians(P.lat))) / np.pi) / 2 * n
P = P.iloc[np.lexsort(((px // 256).values, (py // 256).values, (px // 4096).values, (py // 4096).values))]   # 16x16-tile blocks, row-major inside
P.insert(0, 'pid', np.arange(len(P)))
P.to_csv(os.path.join(D, 'points.csv'), index=False, float_format='%.7f')

tiles = set()
for dx in (-96, 95):
    for dy in (-96, 95):
        tiles |= set(zip(((px + dx) // 256).astype(int), ((py + dy) // 256).astype(int)))
print(P.src.value_counts().to_dict(), 'with inventory match', int((P.object_id >= 0).sum()), 'tiles', len(tiles))
