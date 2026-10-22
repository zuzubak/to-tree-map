-- One row per dissemination area: the unit both block-level maps are drawn on.
--
-- DA rather than dissemination block, for two reasons. Population is only published
-- to block level in a file StatCan's WAF will not serve to a script, and a block
-- holding four trees produces an average age that swings wildly on one record.
-- A DA is a few blocks -- 3,727 of them inside Toronto, averaging ~750 residents.

with area as (
    select dauid, population, dwellings, area_m2
    from {{ source('geo', 'dissemination_areas') }}
),

trees as (
    select ta.dauid, count(*) as tree_count
    from {{ source('geo', 'tree_area') }} ta
    group by 1
),

aged as (
    select ta.dauid,
           count(*) as trees_with_age,
           round(avg(a.age_years), 1) as mean_age,
           round(median(a.age_years), 1) as median_age,
           round(quantile_cont(a.age_years, 0.9), 1) as p90_age,
           count(*) filter (where a.basis = 'isa') as aged_from_species
    from {{ source('geo', 'tree_area') }} ta
    join {{ ref('tree_age') }} a using (object_id)
    where a.plausible
    group by 1
),

-- Licensed parking on residential front land, counted at the address and so given to
-- the area holding most of its block rather than split along it the way street length
-- is. A permit sits at one house.
parking as (
    select d.dauid, sum(p.spaces) as parking_spaces, count(*) as parking_permits
    from {{ source('geo', 'parking_segment') }} p
    join {{ source('geo', 'segment_da') }} d using (centreline_id)
    group by 1
)

select
    a.dauid,
    m.municipality,
    a.population,
    a.dwellings,
    round(a.area_m2 / 10000, 2) as area_ha,
    coalesce(t.tree_count, 0) as tree_count,
    coalesce(g.trees_with_age, 0) as trees_with_age,
    g.mean_age,
    g.median_age,
    g.p90_age,
    g.aged_from_species,
    -- Trees per thousand residents. Null rather than infinity where nobody lives:
    -- an industrial block with 40 trees and no residents is not the leafiest place
    -- in the city, it is a place the measure does not describe.
    case when a.population > 0
         then round(coalesce(t.tree_count, 0) * 1000.0 / a.population, 1) end as trees_per_1000,
    case when a.area_m2 > 0
         then round(coalesce(t.tree_count, 0) / (a.area_m2 / 10000.0), 1) end as trees_per_ha,
    round(c.canopy_m2) as canopy_m2,
    -- Share of the block under tree canopy, mapped top-down in 2018: canopy overhanging
    -- a road or a roof counts as canopy, so this is what is over the block rather than
    -- what is rooted in it, and it can exceed what any count of trunks would suggest.
    case when a.area_m2 > 0 and c.canopy_m2 is not null
         then round(100.0 * c.canopy_m2 / a.area_m2, 2) end as canopy_pct,
    -- Surface shares from the same 2018 study. "other paved" is everything hard that
    -- is not a road: parking, driveways, hardstanding. It is the strongest single
    -- correlate of canopy once density is held constant, and unlike density it is
    -- something a by-law can act on.
    case when a.area_m2 > 0 and lcv.other_m2 is not null
         then round(100.0 * lcv.other_m2 / a.area_m2, 2) end as paved_pct,
    case when a.area_m2 > 0 and lcv.building_m2 is not null
         then round(100.0 * lcv.building_m2 / a.area_m2, 2) end as building_pct,
    -- Residents per hectare: the density axis of the scatter.
    case when a.area_m2 > 0
         then round(a.population / (a.area_m2 / 10000.0), 2) end as people_per_ha,
    round(s.street_m) as street_m,
    -- The same measure the street map draws, re-asked of an area rather than a block:
    -- every tree inside it over every metre of street inside it. Below 200 m of street
    -- the ratio is noise -- a stub of road through a ravine with four trees on it is
    -- not a densely planted place.
    case when s.street_m >= 200
         then round(coalesce(t.tree_count, 0) * 100.0 / s.street_m, 2) end as trees_per_100m,
    coalesce(k.parking_spaces, 0) as parking_spaces,
    coalesce(k.parking_permits, 0) as parking_permits,
    -- The same denominator the tree ratio uses, so the two are directly comparable.
    case when s.street_m >= 200
         then round(coalesce(k.parking_spaces, 0) * 100.0 / s.street_m, 2)
    end as parking_per_100m
from area a
left join trees t using (dauid)
left join aged g using (dauid)
left join {{ source('geo', 'da_municipality') }} m using (dauid)
left join {{ source('geo', 'segment_area') }} s using (dauid)
left join parking k using (dauid)
left join {{ ref('da_canopy') }} c using (dauid)
left join {{ ref('da_landcover') }} lcv using (dauid)
