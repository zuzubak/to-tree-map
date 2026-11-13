"""Turn the Kaggle prediction run into the static payload for site/model/.

    python export_map.py data/pred1

Reads <run>/preds.npz + data/points.csv, joins the matched inventory tree, and writes
site/model/data/: coords.u32.gz (planar lon/lat offsets x1e7, like the main map),
attrs.u8.gz (planar columns, see COLS), inv.u16.gz (inventory taxon index, 0 = no match)
and meta.json.
"""
import gzip, json, os, sys
import duckdb, numpy as np, pandas as pd

ML = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ML, '..', 'site', 'model', 'data')
COLS = ['g1', 'g1p', 'g2', 'g2p', 's1', 's1p', 'dbh', 'src', 'invdbh']
SCALE = 1e7

run = sys.argv[1]
R = np.load(os.path.join(run, 'preds.npz'))
P = pd.read_csv(os.path.join(ML, 'data', 'points.csv'))
assert len(P) == len(R['g1']), (len(P), len(R['g1']))
P = P[R['g1'] != 255].reset_index(drop=True)   # not predicted (shouldn't happen)
pid = P.pid.values
genera, species = [str(g) for g in R['genera']], [str(s) for s in R['species']]

con = duckdb.connect(os.path.join(ML, '..', 'data', 'warehouse.duckdb'), read_only=True)
S = con.sql("""select t.object_id, d.botanical_display botanical, d.common_name common, t.dbh_cm, t.address
               from street_trees t join dim_taxa d using (taxon_id)""").df()
D = con.sql("select taxon_key, common_name, genus, genus_common from dim_taxa where taxon_rank in ('species', 'genus') and cultivar is null").df()
gl = dict(zip(D.genus, D.genus_common))
species_common = [dict(zip(D.taxon_key, D.common_name)).get(s) or {'Pyrus calleryana': 'Callery pear'}.get(s, '') for s in species]

P = P.merge(S, on='object_id', how='left')
taxa = P.dropna(subset=['botanical']).groupby(['botanical', 'common'], dropna=False).size().sort_values(ascending=False)
taxa_list = [{'b': b, 'c': c if isinstance(c, str) else ''} for b, c in taxa.index]
tix = {(t['b'], t['c']): i + 1 for i, t in enumerate(taxa_list)}
inv = np.array([tix.get((b, c if isinstance(c, str) else ''), 0) if isinstance(b, str) else 0
                for b, c in zip(P.botanical, P.common)], np.uint16)

q = lambda a: np.clip(np.rint(a.astype(np.float32) * 255), 0, 255).astype(np.uint8)
A = {'g1': R['g1'][pid], 'g1p': q(R['g1p'][pid]), 'g2': R['g2'][pid], 'g2p': q(R['g2p'][pid]),
     's1': R['s1'][pid], 's1p': q(R['s1p'][pid]),
     'dbh': np.clip(np.rint(R['dbh'][pid].astype(np.float32)), 0, 255).astype(np.uint8),
     'src': (P.src == 's').values.astype(np.uint8),
     'invdbh': np.clip(np.rint(P.dbh_cm.fillna(0).values), 0, 255).astype(np.uint8)}

n = len(P)
olon, olat = float(np.floor(P.lon.min() * 100) / 100), float(np.floor(P.lat.min() * 100) / 100)
coords = np.empty(2 * n, np.uint32)
coords[:n] = np.rint((P.lon.values - olon) * SCALE); coords[n:] = np.rint((P.lat.values - olat) * SCALE)

os.makedirs(OUT, exist_ok=True)
def write(name, arr):
    with gzip.open(os.path.join(OUT, name + '.gz'), 'wb', compresslevel=9) as f:
        f.write(arr.tobytes())
write('coords.u32', coords)
write('attrs.u8', np.concatenate([A[c] for c in COLS]))
write('inv.u16', inv)

counts = np.bincount(A['g1'], minlength=len(genera))
meta = {'n': n, 'coords': {'origin_lon': olon, 'origin_lat': olat, 'scale': SCALE}, 'cols': COLS,
        'genera': [{'name': g, 'common': gl.get(g, 'Other genera' if g == 'other' else ''), 'count': int(c)}
                   for g, c in zip(genera, counts)],
        'species': [{'name': s, 'common': c} for s, c in zip(species, species_common)],
        'inv_taxa': taxa_list,
        'n_topo': int((A['src'] == 0).sum()), 'n_inventory_only': int((A['src'] == 1).sum())}
json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w'), separators=(',', ':'))
print(n, 'trees;', {f: f'{os.path.getsize(os.path.join(OUT, f)) / 1e6:.1f} MB' for f in os.listdir(OUT)})
