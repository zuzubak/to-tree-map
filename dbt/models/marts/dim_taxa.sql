-- One row per distinct taxon in the inventory, carrying its curated native status and a
-- stable small integer id.
--
-- taxon_id is what the map's binary payload stores per tree (2 bytes instead of a ~40-byte
-- name), so it must be deterministic across refreshes for a given set of taxa -- hence the
-- ordering by name rather than by count.
--
-- Native status is resolved at species level where the inspector recorded a species, and
-- falls back to the genus row otherwise. That fallback is deliberately conservative: for a
-- genus containing both native and introduced species, the genus row says 'unknown' rather
-- than guessing, because "Acer" alone could be a sugar maple or a Norway maple.

with trees as (
    select * from {{ ref('stg_street_trees') }}
),

taxa as (
    select
        botanical_display,
        genus,
        species,
        cultivar,
        taxon_key,
        taxon_rank,
        -- The City writes common names inverted for sorting ("Oak, swamp white"). Flip them
        -- back into something readable ("Swamp white oak") and leave uninverted ones alone.
        -- Most frequent spelling, not the alphabetically last: "Acer platanoides" rows carry
        -- several COMMON_NAME variants, and "Norway Harlequin maple" should not out-vote
        -- "Norway maple" just because H sorts after nothing.
        mode(common_name_raw) as common_name_raw,
        count(*) as tree_count,
        count(dbh_cm) as trees_with_dbh,
        round(avg(dbh_cm), 1) as mean_dbh_cm,
        max(dbh_cm) as max_dbh_cm
    from trees
    group by 1, 2, 3, 4, 5, 6
),

statused as (
    select
        t.*,
        -- Species-level match first, genus-level fallback second.
        coalesce(sp.native_status, gn.native_status, 'unknown') as native_status,
        coalesce(sp.invasive, gn.invasive, false) as invasive,
        coalesce(sp.origin, gn.origin) as origin,
        coalesce(sp.notes, gn.notes) as native_notes,
        case when sp.taxon is not null then 'species' else
             case when gn.taxon is not null then 'genus' else 'unmatched' end
        end as status_basis,
        gl.genus_common
    from taxa t
    left join {{ ref('native_status') }} sp
        on sp.rank = 'species' and sp.taxon = t.taxon_key
    left join {{ ref('native_status') }} gn
        on gn.rank = 'genus' and gn.taxon = t.genus
    left join {{ ref('genus_labels') }} gl on gl.genus = t.genus
),

labelled as (
    select
        *,
        case
            when common_name_raw is null then botanical_display
            when position(', ' in common_name_raw) > 0 then
                upper(substr(split_part(common_name_raw, ', ', 2), 1, 1))
                || substr(split_part(common_name_raw, ', ', 2), 2)
                || ' ' || lower(split_part(common_name_raw, ', ', 1))
            else common_name_raw
        end as common_name
    from statused
)

select
    row_number() over (order by botanical_display) - 1 as taxon_id,
    botanical_display,
    common_name,
    genus,
    coalesce(genus_common, genus) as genus_common,
    species,
    cultivar,
    taxon_key,
    taxon_rank,
    native_status,
    invasive,
    origin,
    native_notes,
    status_basis,
    tree_count,
    trees_with_dbh,
    mean_dbh_cm,
    max_dbh_cm
from labelled
order by botanical_display
