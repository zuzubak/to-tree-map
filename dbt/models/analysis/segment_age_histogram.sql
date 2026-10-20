-- Age distribution along each street segment, in the same ten-year bins as the
-- area histogram. This is what the age map shows when a block is clicked.
--
-- Precomputed rather than derived in the browser: sparse bins for 43,000 segments
-- come to a few hundred kilobytes, where shipping an age and a segment id for
-- 650,000 trees would be several megabytes for the same answer.

with binned as (
    select
        ts.centreline_id,
        least(floor(a.age_years / 10) * 10, 140)::int as bin_start,
        count(*) as n
    from {{ source('geo', 'tree_segment') }} ts
    join {{ ref('tree_age') }} a using (object_id)
    where a.plausible
    group by 1, 2
)

select centreline_id, bin_start, n
from binned
order by centreline_id, bin_start
