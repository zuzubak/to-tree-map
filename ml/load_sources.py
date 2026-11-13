"""Load the three label sources into ml/data/ml.duckdb, all in UTM 17N metres (EPSG:32617, the warehouse METRIC_CRS).

topo   — 1.25M City topographic tree points (LiDAR-derived height), the location truth
street — 688k street trees (species, DBH, address-geocoded point) from the main warehouse
annex  — ~10k Annex Neighbourwoods trees (2011-14, surveyed coords, incl. private)
"""
import sys
import duckdb, pyogrio, pandas as pd
from pyproj import Transformer

DL = '/Users/zuzubak/Downloads'
to_utm = Transformer.from_crs(4326, 32617, always_xy=True)
con = duckdb.connect('data/ml.duckdb')
con.sql("install spatial; load spatial")

t = pyogrio.read_dataframe(f'{DL}/Tree Point/TOPO_TREE_WGS84.shp',
                           columns=['DERIVED_HE', 'ELEVATION', 'OBJECTID', 'LAST_GEOME'])
x, y = to_utm.transform(t.geometry.x.values, t.geometry.y.values)
topo = pd.DataFrame({'topo_id': t.OBJECTID.astype('int64'), 'x': x, 'y': y,
                     'lon': t.geometry.x.values, 'lat': t.geometry.y.values,
                     'height': t.DERIVED_HE, 'geom_year': pd.to_numeric(t.LAST_GEOME.str[:4], errors='coerce')})
con.sql('create or replace table topo as select * from topo')

con.sql("attach '../data/warehouse.duckdb' as wh (read_only)")
s = con.sql("""select r.object_id, r.address, r.street_name, r.site, r.tree_position_number pos,
                      r.lon, r.lat, s.genus, s.species, s.canonical_name, s.dbh_cm, s.taxon_rank
               from wh.raw.street_trees r join wh.main.stg_street_trees s using (object_id)""").df()
s['x'], s['y'] = to_utm.transform(s.lon.values, s.lat.values)
con.sql('create or replace table street as select * from s')
con.sql("create or replace table centreline as select centreline_id, street_name, street_class, lo_num_l, hi_num_l, lo_num_r, hi_num_r, ST_AsWKB(geom_m) wkb from wh.geo.street_segments")
con.sql("create or replace table canopy as select ST_AsWKB(geom_m) wkb from wh.main.canopy")

a = pd.read_csv(f'{DL}/AnnexTrees - MK - AnnexTrees - main (5).csv')
a = a.rename(columns={'Y coordinate': 'lat', 'X coordinate': 'lon'})  # headers are swapped in this file
a = a[a.lat.between(43, 44) & a.lon.between(-80, -79) & (a.Dead.fillna('') != 'dead')]
a['x'], a['y'] = to_utm.transform(a.lon.values, a.lat.values)
a = a[['tree index', 'Species', 'species_code', 'ownership_code', 'location_code',
       'Diameter at Breast Height', 'Crown Width', 'Total Height', 'Date', 'lon', 'lat', 'x', 'y']]
a.columns = ['annex_id', 'species', 'species_code', 'ownership', 'location', 'dbh_cm',
             'crown_w', 'height', 'date', 'lon', 'lat', 'x', 'y']
con.sql('create or replace table annex as select * from a')
for tb in ['topo', 'street', 'annex']:
    print(tb, con.sql(f'select count(*) from {tb}').fetchone())
