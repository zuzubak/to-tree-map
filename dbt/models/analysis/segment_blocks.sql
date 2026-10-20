-- What to call each street segment: the street, and the cross streets at its ends.
--
-- "Albion Rd, N: Finch Ave, S: Sheppard Ave" locates a block the way a person would.
-- The centreline id does not, and neither does the street name on its own when a
-- street is cut into forty segments.
--
-- Two sources, in this order:
--
-- 1. The centreline's own topology (geo.segment_crossings). A segment sharing an
--    endpoint with a differently-named segment meets it at an intersection, and the
--    endpoint coordinates say which end is north or east. This is the only source
--    that works on a segment with no trees on it, which is a fifth of them.
-- 2. The trees' own cross_street fields, which carry the City's block definition as
--    an unordered pair. Where topology named one end, the other name in the pair is
--    the other end -- so the pair fills a gap without having to order anything.
--
-- The centreline is cut mid-block in places (at former municipal boundaries, address
-- range changes), and at such a cut the only neighbour shares the street name, so
-- topology alone leaves that end unnamed. That is the gap step 2 closes: 30,601
-- segments get both ends from topology, and the pair adds about 4,500 more.
-- What is left keeps whichever end is known.

with crossings as (
    select centreline_id, north_south, high_cross, low_cross
    from {{ source('geo', 'segment_crossings') }}
),

-- The modal cross-street pair among the trees snapped to this segment. Modal rather
-- than any single tree's, because a tree sitting near a corner is sometimes attributed
-- to the next block along.
pair as (
    select centreline_id, c1, c2
    from (
        select ts.centreline_id,
               {{ title_case('st.cross_street_1') }} as c1,
               {{ title_case('st.cross_street_2') }} as c2,
               row_number() over (
                   partition by ts.centreline_id order by count(*) desc, 1
               ) as rn
        from {{ source('geo', 'tree_segment') }} ts
        join {{ ref('street_trees') }} st using (object_id)
        where st.cross_street_1 is not null
          and st.cross_street_2 is not null
        group by ts.centreline_id, 2, 3
    )
    where rn = 1
),

filled as (
    select
        c.centreline_id,
        c.north_south,
        coalesce(c.high_cross,
                 case when c.low_cross is not null then
                     case when lower(c.low_cross) = lower(p.c1) then p.c2
                          when lower(c.low_cross) = lower(p.c2) then p.c1 end
                 end) as high_cross,
        coalesce(c.low_cross,
                 case when c.high_cross is not null then
                     case when lower(c.high_cross) = lower(p.c1) then p.c2
                          when lower(c.high_cross) = lower(p.c2) then p.c1 end
                 end) as low_cross,
        p.c1,
        p.c2,
        c.high_cross is null and c.low_cross is null as no_topology
    from crossings c
    left join pair p using (centreline_id)
)

select
    centreline_id,
    north_south,
    high_cross,
    low_cross,
    -- With neither end placed by topology, the pair still names the block but cannot
    -- say which name sits at which end, so the label has to read "between A and B".
    case when no_topology then c1 end as cross_a,
    case when no_topology then c2 end as cross_b
from filled
