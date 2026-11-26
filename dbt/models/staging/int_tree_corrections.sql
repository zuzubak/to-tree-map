-- Every approved reader correction, reconciled against the City's current inventory.
--
-- Corrections are never written back into the City's data. They are a separate layer,
-- re-applied on every build, so each refresh is a chance for the City to have fixed the
-- record itself. To tell whether it has, every correction carries a snapshot of what the
-- map showed the reader at the time ("snap_*") as well as the fix ("new_*"), and the
-- City's current value decides what happens:
--
--   City value == snapshot  -> applied       the City hasn't touched it; our fix stands
--   City value == fix       -> city_agrees   the City made the same fix; ours is a no-op
--   City value == anything  -> superseded    the City re-inspected since; the City wins
--     else
--   tree not found          -> orphaned      (city_agrees for a removal: it's gone)
--
-- "The City wins" on a disagreement is deliberate. A changed record means an inspector
-- stood at the tree more recently than the reader did -- a re-measured trunk, a
-- replanting in the same pit -- and a stale correction must not paper over that.
--
-- Trees are matched by STRUCTID, the City's asset id for the tree (OBJECTID and _id are
-- row numbers and get reissued). If a refresh ever reissues STRUCTIDs too, a fingerprint
-- of the snapshot -- species, address and position within ~3 m -- is tried instead, and
-- only accepted when it picks out exactly one tree.

with corrections as (
    select * from {{ ref('tree_corrections') }}
),

city as (
    select struct_id, botanical_display, coalesce(dbh_cm, 0) as dbh_cm, address, street_name,
           lon, lat
    from {{ ref('stg_street_trees') }}
),

by_struct as (
    select c.correction_id, t.*, 'struct_id' as matched_by
    from corrections c
    join city t using (struct_id)
),

-- Only for corrections whose STRUCTID has vanished. Trees in a row at one address often
-- share species and the exact parcel point, so an ambiguous match is dropped rather than
-- guessed; trunk diameter breaks the tie where it can.
fingerprint as (
    select c.correction_id, t.*, 'fingerprint' as matched_by,
           count(*) over (partition by c.correction_id) as n_loose,
           count(*) filter (where t.dbh_cm = c.snap_dbh_cm)
               over (partition by c.correction_id) as n_tight,
           t.dbh_cm = c.snap_dbh_cm as tight
    from corrections c
    join city t
      on t.botanical_display = c.snap_botanical
     and t.street_name = c.snap_street
     and t.address is not distinct from c.snap_address
     and abs(t.lon - c.snap_lon) < 0.00004
     and abs(t.lat - c.snap_lat) < 0.00003
    where not exists (select 1 from city x where x.struct_id = c.struct_id)
),

matched as (
    select * exclude (matched_by), matched_by from by_struct
    union all
    select * exclude (matched_by, n_loose, n_tight, tight), matched_by
    from fingerprint
    where n_loose = 1 or (n_tight = 1 and tight)
),

classified as (
    select
        c.*,
        m.struct_id as city_struct_id,
        m.matched_by,
        m.botanical_display as city_botanical,
        m.dbh_cm as city_dbh_cm,
        m.address as city_address,
        m.street_name as city_street,
        m.lon as city_lon,
        m.lat as city_lat,
        case
            when m.struct_id is null then
                case when c.kind = 'remove' then 'city_agrees' else 'orphaned' end
            when c.kind = 'remove' then
                case when m.botanical_display = c.snap_botanical and m.dbh_cm = c.snap_dbh_cm
                     then 'applied' else 'superseded' end
            when c.kind = 'species' then
                case when m.botanical_display = c.new_botanical then 'city_agrees'
                     when m.botanical_display = c.snap_botanical then
                         case when exists (select 1 from city k
                                           where k.botanical_display = c.new_botanical)
                              then 'applied' else 'unknown_species' end
                     else 'superseded' end
            when c.kind = 'dbh' then
                case when m.dbh_cm = c.new_dbh_cm then 'city_agrees'
                     when m.dbh_cm = c.snap_dbh_cm then 'applied'
                     else 'superseded' end
            when c.kind = 'address' then
                case when m.address is not distinct from c.new_address
                          and m.street_name = c.new_street then 'city_agrees'
                     when m.address is not distinct from c.snap_address
                          and m.street_name = c.snap_street then 'applied'
                     else 'superseded' end
            else 'unknown_kind'
        end as status_raw
    from corrections c
    left join matched m using (correction_id)
)

-- Two approved fixes to the same field of the same tree: the later one stands.
select
    * exclude (status_raw),
    case
        when status_raw = 'applied'
         and row_number() over (
                 partition by city_struct_id, kind, status_raw = 'applied'
                 order by approved_at desc) > 1
        then 'replaced'
        else status_raw
    end as status
from classified
