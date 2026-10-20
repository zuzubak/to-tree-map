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
)

select
    a.dauid,
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
         then round(coalesce(t.tree_count, 0) / (a.area_m2 / 10000.0), 1) end as trees_per_ha
from area a
left join trees t using (dauid)
left join aged g using (dauid)
