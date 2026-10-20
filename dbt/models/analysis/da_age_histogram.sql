-- Age distribution inside each dissemination area, in ten-year bins.
--
-- This is what the map shows when a block is clicked. Precomputed rather than
-- derived in the browser from per-tree ages: the whole distribution for all 3,727
-- areas is about 120 KB, where shipping an age and an area id for 650,000 trees
-- would be more than a megabyte for the same answer.
--
-- 140+ is a single top bin. Above that the estimates come from diameters in the
-- range we know is guessed rather than measured, and splitting them finer would
-- imply a precision the input cannot support.

with binned as (
    select
        ta.dauid,
        least(floor(a.age_years / 10) * 10, 140)::int as bin_start,
        count(*) as n
    from {{ source('geo', 'tree_area') }} ta
    join {{ ref('tree_age') }} a using (object_id)
    where a.plausible
    group by 1, 2
)

select dauid, bin_start, n
from binned
order by dauid, bin_start
