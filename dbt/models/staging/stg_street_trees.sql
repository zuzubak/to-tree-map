-- One row per inventoried tree, with the City's free-text botanical name resolved into
-- genus / species / cultivar so the rest of the pipeline can join on a stable key.
--
-- The BOTANICAL_NAME column is hand-typed by inspectors and shows it: mixed case
-- ("ginkgo biloba"), outright misspellings ("Allianthus altissima"), parenthetical hybrid
-- formulas, unbalanced quotes ("Ulmus davidiana 'japonica Morton"), botanical rank markers
-- ("f. inermis", "subsp. ginnala") and unquoted trade names ("Betula nigra Heritage").
-- Order of operations matters: strip parentheses first, then the cultivar -- otherwise a
-- cultivar quoted *inside* a hybrid formula gets mistaken for the tree's own cultivar.

with corrections as (
    select * from {{ ref('name_corrections') }}
),

base as (
    select
        t.object_id,
        t.struct_id,
        t.address,
        t.street_name,
        t.cross_street_1,
        t.cross_street_2,
        t.ward,
        t.common_name as common_name_raw,
        t.botanical_name as botanical_name_raw,
        t.lon,
        t.lat,
        -- DBH is recorded in centimetres. A handful of rows carry impossible values (the
        -- largest claims a 93 m trunk), so anything over 3 m is treated as a data-entry
        -- error rather than silently drawn as the biggest tree in the city.
        case when t.dbh_trunk_cm between 1 and 300 then t.dbh_trunk_cm end as dbh_cm,
        t.dbh_trunk_cm is not null and t.dbh_trunk_cm not between 1 and 300 as dbh_suspect,
        -- Normalise whitespace before anything tries to split on it. One record contains a
        -- non-breaking space ("Ulmus x\u00a0hollandica"), which neither RE2's \s nor
        -- str_split(' ') counts as a separator -- left alone it parses as a bare genus.
        regexp_replace(
            replace(replace(replace(
                coalesce(c.canonical_name, t.botanical_name),
                chr(160), ' '), chr(8239), ' '), chr(12288), ' '),
            '\s+', ' ', 'g'
        ) as canonical_name
    from {{ source('raw', 'street_trees') }} t
    left join corrections c on lower(trim(t.botanical_name)) = c.raw_lower
    where t.lon is not null and t.lat is not null
),

stripped as (
    select
        *,
        -- Drop parenthetical hybrid formulas, then everything from the first quote on.
        trim(regexp_replace(
            regexp_replace(
                regexp_replace(canonical_name, '\([^)]*\)?', ' ', 'g'),
                '[''‘’"].*$', ''
            ),
            '\s+', ' ', 'g'
        )) as name_no_cultivar,
        -- The cultivar itself: first quoted run, after parentheses are gone.
        nullif(trim(regexp_extract(
            regexp_replace(canonical_name, '\([^)]*\)?', ' ', 'g'),
            '[''‘]([^''’"]+)', 1
        )), '') as cultivar
    from base
),

parsed as (
    select
        *,
        str_split(name_no_cultivar, ' ') as words
    from stripped
),

named as (
    select
        *,
        -- Genus: always the first word, normalised to sentence case.
        nullif(upper(substr(words[1], 1, 1)) || lower(substr(words[1], 2)), '') as genus,
        lower(coalesce(words[2], '')) in ('x', '×') as is_hybrid,
        -- Species epithet: the first remaining word that actually looks like one. Rank
        -- markers ('f.', 'subsp.') and abbreviations ('spp.') all carry a dot and so fail
        -- the pattern; single letters (the dangling 'x' in "Juglans cinerea x") are too
        -- short to match.
        list_filter(
            list_transform(words[2:], w -> lower(w)),
            w -> regexp_full_match(w, '[a-z][a-z-]+')
        ) as epithets
    from parsed
),

resolved as (
    select
        object_id,
        struct_id,
        address,
        street_name,
        cross_street_1,
        cross_street_2,
        ward,
        lon,
        lat,
        dbh_cm,
        dbh_suspect,
        botanical_name_raw,
        canonical_name,
        cultivar,
        genus,
        case
            when genus is null or len(epithets) = 0 then null
            when is_hybrid then 'x ' || epithets[1]
            else epithets[1]
        end as species,
        common_name_raw
    from named
)

select
    *,
    -- The join key for the curated native-status table: species level when we have one,
    -- genus level otherwise.
    case when species is null then genus else genus || ' ' || species end as taxon_key,
    case when species is null then 'genus' else 'species' end as taxon_rank,
    -- Display name: "Genus species 'Cultivar'".
    trim(
        coalesce(genus, 'Unidentified')
        || coalesce(' ' || species, '')
        || coalesce(' ''' || cultivar || '''', '')
    ) as botanical_display
from resolved
