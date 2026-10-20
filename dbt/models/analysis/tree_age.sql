-- Estimated age for every tree with a recorded diameter.
--
-- ISA growth-factor method: age = diameter in inches x a species factor, where the
-- factor is the average years that species takes to add an inch of trunk. It is the
-- standard field estimate and it is only an estimate -- the factors describe
-- open-grown landscape trees, and a street tree in a four-foot pit with compacted
-- soil and road salt grows slower than that, so these ages run young for the most
-- stressed sites.
--
-- The input is no better than the method. Diameters heap on round numbers above
-- 20 cm and nearly a quarter of the city sits on exactly 4 or 8 cm, so an individual age is
-- soft even where the factor is right. Aggregated over a dissemination area it is
-- worth something; for a single tree it is an indication, not a reading.
--
-- basis records where each factor came from, so a reader can tell a published
-- species value from a genus median from a rule of thumb.

with base as (
    select
        t.object_id,
        t.dbh_cm,
        x.taxon_id,
        x.genus,
        x.species,
        x.common_name,
        case when x.species is not null then x.genus || ' ' || x.species end as species_key
    from {{ ref('street_trees') }} t
    join {{ ref('dim_taxa') }} x using (taxon_id)
    where t.dbh_cm is not null
),

matched as (
    select
        b.*,
        coalesce(sp.growth_factor, gn.growth_factor) as growth_factor,
        case
            when sp.taxon is not null then sp.basis
            when gn.taxon is not null then gn.basis
        end as basis
    from base b
    left join {{ ref('growth_factors') }} sp
        on sp.rank = 'species' and sp.taxon = b.species_key
    left join {{ ref('growth_factors') }} gn
        on gn.rank = 'genus' and gn.taxon = b.genus
)

select
    object_id,
    taxon_id,
    genus,
    common_name,
    dbh_cm,
    growth_factor,
    coalesce(basis, 'unmatched') as basis,
    -- 2.54 cm to the inch; the factors are published per inch.
    round(dbh_cm / 2.54 * growth_factor, 1) as age_years,
    -- Toronto's genuinely oldest trees run to roughly two and a half centuries.
    -- Past that the arithmetic is faithfully reporting a bad diameter: the top of
    -- this list is a 203 cm yew and a 250 cm hawthorn, neither of which exists.
    -- A slow-growing species multiplies the error, since a high growth factor turns
    -- an impossible trunk into an impossible age. Flagged rather than deleted so the
    -- count stays visible; every aggregate below filters on it.
    round(dbh_cm / 2.54 * growth_factor, 1) <= 250 as plausible
from matched
where growth_factor is not null
