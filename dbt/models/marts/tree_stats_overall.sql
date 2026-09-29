-- Single-row citywide summary plus the source freshness stamps, for the map's header.

with trees as (
    select t.*, x.native_status, x.invasive, x.genus, x.species
    from {{ ref('street_trees') }} t
    join {{ ref('dim_taxa') }} x using (taxon_id)
),

meta as (
    select city_last_refreshed, ingest_route, pipeline_ran_at
    from {{ source('raw', 'source_metadata') }}
)

select
    (select count(*) from trees) as tree_count,
    (select count(distinct case when species is not null then genus || ' ' || species end) from trees) as species_count,
    (select count(distinct genus) from trees) as genus_count,
    (select count(*) from trees where native_status = 'native') as native_count,
    (select count(*) from trees where native_status = 'non_native') as non_native_count,
    (select count(*) from trees where native_status = 'unknown') as unknown_count,
    (select count(*) from trees where invasive) as invasive_count,
    (select round(100.0 * count(*) filter (where native_status = 'native')
                  / nullif(count(*) filter (where native_status in ('native', 'non_native')), 0), 1)
     from trees) as native_pct,
    (select round(avg(dbh_cm), 1) from trees) as mean_dbh_cm,
    (select median(dbh_cm) from trees) as median_dbh_cm,
    (select count(*) from trees where dbh_cm is null) as missing_dbh_count,
    (select count(*) from trees where dbh_suspect) as suspect_dbh_count,
    m.city_last_refreshed,
    m.ingest_route,
    m.pipeline_ran_at
from meta m
