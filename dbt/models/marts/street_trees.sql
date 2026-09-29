-- The map's source of truth: one row per tree, joined to its taxon and ward, ordered for
-- compression.
--
-- The ordering is not cosmetic. export/ writes these rows into parallel binary columns, and
-- gzip only shrinks the street-name and taxon columns if neighbouring rows tend to agree.
-- Sorting by a coarse spatial grid (roughly 300 m cells, row-major) puts trees on the same
-- block next to each other, which is exactly when they share a street name and a species.

with trees as (
    select * from {{ ref('stg_street_trees') }}
),

taxa as (
    select taxon_id, botanical_display, taxon_key, cultivar from {{ ref('dim_taxa') }}
),

joined as (
    select
        t.object_id,
        t.struct_id,
        tx.taxon_id,
        t.dbh_cm,
        t.dbh_suspect,
        t.lon,
        t.lat,
        t.address,
        t.street_name,
        t.cross_street_1,
        t.cross_street_2,
        t.ward,
        w.ward_name
    from trees t
    join taxa tx
        on tx.botanical_display = t.botanical_display
       and tx.taxon_key is not distinct from t.taxon_key
       and tx.cultivar is not distinct from t.cultivar
    left join {{ source('raw', 'wards') }} w on w.ward = t.ward
),

gridded as (
    select
        *,
        -- ~300 m cells over the city's extent; 1024 columns is plenty for Toronto's width.
        cast((lat - 43.55) / 0.0027 as integer) * 1024
            + cast((lon + 79.70) / 0.0037 as integer) as grid_cell
    from joined
)

-- tree_index makes the row order an explicit column rather than a property of how DuckDB
-- happened to materialise the table: the export orders by it, so two rebuilds of the same
-- input produce byte-identical output.
--
-- object_id breaks ties in the spatial sort. 193,559 trees share an exact lon/lat with
-- another tree -- the City geocodes to the parcel, so every tree at one address lands on
-- the same point -- and without a unique tiebreaker that ordering is arbitrary.
select
    row_number() over (order by grid_cell, lon, lat, object_id) - 1 as tree_index,
    * exclude (grid_cell)
from gridded
order by tree_index
