-- One row per centreline segment: trees per 100 m of street frontage.
--
-- A centreline segment runs between intersections, so it already is one block of
-- one street -- which is the unit the question is really about. Apportioning street
-- length to polygons instead would have to split every shared boundary street
-- between the two blocks facing it, and would answer a blurrier question.
--
-- Expressways and their ramps are excluded upstream (utils/geo.py): they are
-- grade-separated through-routes, never street-tree frontage, and leaving them in
-- would stripe the map with false zeroes along the 401, the DVP and the Gardiner.

with seg as (
    select centreline_id, street_name, street_class, length_m
    from {{ source('geo', 'street_segments') }}
),

trees as (
    select centreline_id, count(*) as tree_count
    from {{ source('geo', 'tree_segment') }}
    group by 1
),

aged as (
    select ts.centreline_id,
           count(*) as trees_with_age,
           round(median(a.age_years), 1) as median_age,
           round(avg(a.age_years), 1) as mean_age
    from {{ source('geo', 'tree_segment') }} ts
    join {{ ref('tree_age') }} a using (object_id)
    where a.plausible
    group by 1
)

select
    s.centreline_id,
    s.street_name,
    s.street_class,
    round(s.length_m, 1) as length_m,
    coalesce(t.tree_count, 0) as tree_count,
    coalesce(g.trees_with_age, 0) as trees_with_age,
    g.median_age,
    g.mean_age,
    b.north_south,
    b.high_cross,
    b.low_cross,
    b.cross_a,
    b.cross_b,
    -- Very short stubs make the ratio explode: a 6 m connector with two trees is
    -- not 33 trees per 100 m of streetscape. Below 20 m the measure is left null.
    case when s.length_m >= 20
         then round(coalesce(t.tree_count, 0) * 100.0 / s.length_m, 2) end as trees_per_100m
from seg s
left join trees t using (centreline_id)
left join aged g using (centreline_id)
left join {{ ref('segment_blocks') }} b using (centreline_id)
