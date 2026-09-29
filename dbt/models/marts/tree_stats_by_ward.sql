-- Per-ward rollup, for the map's ward choropleth and the "how does my ward compare" panel.
-- Species richness is counted at species level only: counting "Acer" as a species alongside
-- "Acer saccharum" would inflate a ward's diversity purely because an inspector wrote down
-- less detail.

with trees as (
    select t.*, x.native_status, x.invasive, x.genus, x.species
    from {{ ref('street_trees') }} t
    join {{ ref('dim_taxa') }} x using (taxon_id)
    where t.ward is not null
)

select
    ward,
    any_value(ward_name) as ward_name,
    count(*) as tree_count,
    count(distinct case when species is not null then genus || ' ' || species end) as species_count,
    count(distinct genus) as genus_count,
    count(*) filter (where native_status = 'native') as native_count,
    count(*) filter (where native_status = 'native_eastern_na') as native_eastern_na_count,
    count(*) filter (where native_status = 'non_native') as non_native_count,
    count(*) filter (where native_status = 'unknown') as unknown_count,
    count(*) filter (where invasive) as invasive_count,
    -- Share of *classified* trees that are native, so genus-only records don't drag the
    -- number down in wards where inspectors recorded less detail.
    round(
        100.0 * count(*) filter (where native_status = 'native')
        / nullif(count(*) filter (where native_status in ('native', 'native_eastern_na', 'non_native')), 0),
        1
    ) as native_pct,
    round(avg(dbh_cm), 1) as mean_dbh_cm,
    count(*) filter (where dbh_cm >= 50) as large_tree_count
from trees
group by ward
order by ward
