"""Select labelled trees, assign spatial splits, and cut 192 px (~21 m) ortho crops around each.

Label source: street-tree records whose point is actually on the boulevard -- within
MAX_BLVD_M of a centreline segment of their own street -- rather than geocoded onto the
parcel (the inventory is bimodal: boulevard points sit 5-10 m from the centreline, parcel
geocodes 18-30 m), that sit alone at their coordinate, and have no tree of a *different*
genus within 6 m. A crop centred on the point then shows the labelled crown, or a
same-genus neighbour. Park trees (site set) are included: their points are placed per tree.

Splits are by 1 km grid cell (hash -> train/val/test 80/10/10) so test neighbourhoods are
unseen. The Annex (+300 m) is withheld entirely: its street trees become `annex_street`, and
the Annex Neighbourwoods survey (incl. private/backyard trees) becomes `annex`.

Writes data/crops/<id>.jpg and data/manifest.csv. Resumable.
"""
import os, sys, zlib
sys.path.insert(0, os.path.dirname(__file__))
from concurrent.futures import ThreadPoolExecutor
import duckdb, numpy as np, pandas as pd
from PIL import Image
from scipy.spatial import cKDTree
import tiles

SIZE = 192
CAP = 5000            # max samples per (genus, species) class
MIN_SPECIES = 1000    # clean samples needed for a species to be its own class
MIN_GENUS = 800
MAX_BLVD_M = 11
OUT = os.path.join(os.path.dirname(__file__), 'data')

con = duckdb.connect(os.path.join(OUT, 'ml.duckdb'), read_only=True)
con.sql("attach '" + os.path.join(os.path.dirname(__file__), '..', 'data', 'warehouse.duckdb') + "' as wh (read_only)")
S = con.sql("""select s.object_id, s.x, s.y, s.lon, s.lat, s.genus, s.species, s.dbh_cm, s.site,
                      ts.dist_m, upper(seg.street_name) = upper(s.street_name) same_street
               from street s left join wh.geo.tree_segment ts using (object_id)
               left join wh.geo.street_segments seg using (centreline_id)""").df()
S['nstack'] = S.groupby(['x', 'y']).object_id.transform('size')
pairs = cKDTree(S[['x', 'y']].values).query_pairs(6.0, output_type='ndarray')
g = S.genus.fillna('?').values
conflict = np.zeros(len(S), bool)
conflict[pairs[g[pairs[:, 0]] != g[pairs[:, 1]]].ravel()] = True
on_blvd = (S.dist_m <= MAX_BLVD_M) & S.same_street.fillna(False).astype(bool)
S = S[(on_blvd | S.site.notna()) & (S.nstack == 1) & ~conflict & S.genus.notna() & (S.dbh_cm.fillna(0) >= 10)].copy()
S['genus'] = S.genus.str.capitalize()
S['sp'] = np.where(S.species.notna(), S.genus + ' ' + S.species.fillna('').str.lower(), None)

# class vocab
gcount = S.genus.value_counts()
genera = sorted(gcount[gcount >= MIN_GENUS].index)
scount = S.sp.value_counts()
species = sorted(scount[scount >= MIN_SPECIES].index)
S['genus_cls'] = np.where(S.genus.isin(genera), S.genus, 'other')
S['species_cls'] = np.where(S.sp.isin(species), S.sp, None)   # None = no species target

# spatial split
A = con.sql('select * from annex').df()
ax0, ax1, ay0, ay1 = A.x.min() - 300, A.x.max() + 300, A.y.min() - 300, A.y.max() + 300
in_annex = S.x.between(ax0, ax1) & S.y.between(ay0, ay1)
cell = (S.x // 1000).astype(int).astype(str) + '_' + (S.y // 1000).astype(int).astype(str)
h = cell.map(lambda c: zlib.crc32(c.encode()) % 10)
S['split'] = np.select([in_annex, h == 0, h == 1], ['annex_street', 'test', 'val'], 'train')

# cap per class (train only; val/test keep natural mix but also capped to keep size sane)
rng = np.random.default_rng(0)
S['key'] = S.genus_cls + '|' + S.species_cls.fillna('-')
S = S.sample(frac=1, random_state=0)
cap = {'train': CAP, 'val': CAP // 8, 'test': CAP // 8, 'annex_street': 10 ** 9}
S = S[S.groupby(['split', 'key']).cumcount() < S.split.map(cap)]
S = S.assign(id='s' + S.object_id.astype(str), source='street')[
    ['id', 'source', 'split', 'x', 'y', 'lon', 'lat', 'genus', 'sp', 'genus_cls', 'species_cls', 'dbh_cm', 'site']]

# Annex survey: labels are common names; map to botanical via a hand table (annex_species.csv)
A = A.assign(id='a' + A.annex_id.astype(str), source='annex', split='annex', site=A.ownership,
             common=A.species.str.strip())
amap_path = os.path.join(os.path.dirname(__file__), 'annex_species.csv')
if os.path.exists(amap_path):
    amap = pd.read_csv(amap_path)
    A = A.merge(amap, on='common', how='left')
else:
    A['genus'] = None; A['sp'] = None
A['genus_cls'] = np.where(A.genus.isin(genera), A.genus, np.where(A.genus.notna(), 'other', None))
A['species_cls'] = np.where(A.sp.isin(species), A.sp, None)
A = A[['id', 'source', 'split', 'x', 'y', 'lon', 'lat', 'genus', 'sp', 'genus_cls', 'species_cls', 'dbh_cm', 'site', 'common']]

M = pd.concat([S, A], ignore_index=True)
px, py = tiles.utm_to_pixel(M.x.values, M.y.values)
M['px'], M['py'] = px, py
M = M.sort_values(['py', 'px'])   # tile-cache locality
print(M.groupby(['split']).size().to_dict(), flush=True)
print('genus classes', len(genera), 'species classes', len(species))

os.makedirs(os.path.join(OUT, 'crops'), exist_ok=True)
pd.Series(genera + ['other']).to_csv(os.path.join(OUT, 'genus_classes.csv'), index=False, header=False)
pd.Series(species).to_csv(os.path.join(OUT, 'species_classes.csv'), index=False, header=False)
M.drop(columns=['px', 'py']).to_csv(os.path.join(OUT, 'manifest.csv'), index=False)


def cut(row):
    p = os.path.join(OUT, 'crops', row.id + '.jpg')
    if os.path.exists(p):
        return
    img, _ = tiles.window(row.px, row.py, SIZE)
    Image.fromarray(img).save(p + '.part', 'JPEG', quality=92)
    os.replace(p + '.part', p)


if __name__ == '__main__' and '--no-crops' not in sys.argv:
    rows = list(M.itertuples())
    done = 0
    with ThreadPoolExecutor(8) as ex:
        for _ in ex.map(cut, rows, chunksize=64):
            done += 1
            if done % 5000 == 0:
                print(done, '/', len(rows), flush=True)
    print('crops done')
