-- The City's inventory with approved reader corrections laid over it. Everything
-- downstream reads this rather than stg_street_trees, so a correction reaches the map,
-- the stats and the taxon counts alike.
--
-- Only corrections int_tree_corrections marks 'applied' take effect; the rest are kept
-- for the record. A species fix may only name a taxon already in the inventory, so it
-- borrows that taxon's parsed fields wholesale instead of re-running the name parser,
-- and every downstream test (native status, taxon joins) keeps holding.

with trees as (
    select * from {{ ref('stg_street_trees') }}
),

live as (
    select * from {{ ref('int_tree_corrections') }} where status = 'applied'
),

taxa as (
    select botanical_display,
           any_value(canonical_name) as canonical_name,
           any_value(cultivar) as cultivar,
           any_value(genus) as genus,
           any_value(species) as species,
           any_value(taxon_key) as taxon_key,
           any_value(taxon_rank) as taxon_rank,
           mode(common_name_raw) as common_name_raw
    from trees
    group by 1
),

sp as (
    select l.city_struct_id as struct_id, x.*
    from live l join taxa x on x.botanical_display = l.new_botanical
    where l.kind = 'species'
),
dbh as (select city_struct_id as struct_id, new_dbh_cm from live where kind = 'dbh'),
adr as (
    select city_struct_id as struct_id, new_address, new_street, new_lon, new_lat, new_ward,
           new_street is distinct from city_street as street_changed
    from live where kind = 'address'
),
gone as (select city_struct_id as struct_id from live where kind = 'remove')

select
    t.* replace (
        coalesce(adr.new_address, t.address) as address,
        coalesce(adr.new_street, t.street_name) as street_name,
        -- A corrected address moves the dot too, since the City places trees by address.
        -- On a different street the cross streets no longer describe the block, so they go.
        coalesce(adr.new_lon, t.lon) as lon,
        coalesce(adr.new_lat, t.lat) as lat,
        coalesce(lpad(adr.new_ward, 2, '0'), t.ward) as ward,
        case when adr.street_changed then null else t.cross_street_1 end as cross_street_1,
        case when adr.street_changed then null else t.cross_street_2 end as cross_street_2,
        coalesce(dbh.new_dbh_cm, t.dbh_cm) as dbh_cm,
        case when dbh.struct_id is not null then false else t.dbh_suspect end as dbh_suspect,
        coalesce(sp.canonical_name, t.canonical_name) as canonical_name,
        case when sp.struct_id is not null then sp.cultivar else t.cultivar end as cultivar,
        coalesce(sp.genus, t.genus) as genus,
        case when sp.struct_id is not null then sp.species else t.species end as species,
        coalesce(sp.common_name_raw, t.common_name_raw) as common_name_raw,
        coalesce(sp.taxon_key, t.taxon_key) as taxon_key,
        coalesce(sp.taxon_rank, t.taxon_rank) as taxon_rank,
        coalesce(sp.botanical_display, t.botanical_display) as botanical_display
    )
from trees t
left join sp using (struct_id)
left join dbh using (struct_id)
left join adr using (struct_id)
where t.struct_id not in (select struct_id from gone)
