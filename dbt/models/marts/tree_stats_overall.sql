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
    (select count(*) from trees where native_status = 'native_eastern_na') as native_eastern_na_count,
    (select count(*) from trees where native_status = 'non_native') as non_native_count,
    (select count(*) from trees where native_status = 'unknown') as unknown_count,
    (select count(*) from trees where invasive) as invasive_count,
    -- Counts of the five classes the map actually colours by, which are not the same as
    -- the status counts above: invasive wins the colour, so an invasive tree is counted
    -- there and nowhere else. The legend labels colour classes, so it must use these or
    -- its numbers won't match what the chips filter.
    (select count(*) from trees where native_status = 'native' and not invasive) as class_native,
    (select count(*) from trees where native_status = 'native_eastern_na' and not invasive) as class_native_eastern_na,
    (select count(*) from trees where native_status = 'non_native' and not invasive) as class_introduced,
    (select count(*) from trees where invasive) as class_invasive,
    (select count(*) from trees where native_status = 'unknown' and not invasive) as class_unknown,
    -- Share of *classified* trees native to Ontario. The denominator now includes the
    -- eastern North American tier, so the headline number answers "how much of Toronto's
    -- street canopy actually belongs to this forest" rather than counting near-natives
    -- as if they were local.
    (select round(100.0 * count(*) filter (where native_status = 'native')
                  / nullif(count(*) filter (where native_status in ('native', 'native_eastern_na', 'non_native')), 0), 1)
     from trees) as native_pct,
    (select round(100.0 * count(*) filter (where native_status = 'native_eastern_na')
                  / nullif(count(*) filter (where native_status in ('native', 'native_eastern_na', 'non_native')), 0), 1)
     from trees) as native_eastern_na_pct,
    (select round(avg(dbh_cm), 1) from trees) as mean_dbh_cm,
    (select median(dbh_cm) from trees) as median_dbh_cm,
    (select count(*) from trees where dbh_cm is null) as missing_dbh_count,
    (select count(*) from trees where dbh_suspect) as suspect_dbh_count,
    m.city_last_refreshed,
    m.ingest_route,
    m.pipeline_ran_at
from meta m
