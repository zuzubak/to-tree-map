# Toronto Street Tree Map

An interactive map of all ~688,000 trees in the City of Toronto's street tree inventory,
coloured by whether each one is native to Ontario, by trunk size, or by species — and
filterable by all of those. Built from Toronto Open Data, rebuilt weekly.

Inspired by the [NYC Parks tree map](https://www.nycgovparks.org/tree-map/) and
[nyctreegenusmap.com](https://nyctreegenusmap.com/).

Sibling project to [`to-multiplex-map`](../to-multiplex-map), and it reuses that project's
shape: Python ingest → DuckDB → dbt → static export → a Leaflet map on GitHub Pages.

## What you can do with it

- **Colour by origin** (the default) — native to Ontario, introduced, introduced *and*
  invasive, or not identified past genus. Norway maple alone is 69,474 trees, a tenth of
  every street tree in the city, and it lights up the map.
- **Colour by trunk size** — a sequential ramp over diameter at breast height, which reads
  as a map of tree age and shows where the old canopy actually is.
- **Compare species or genera** — pick up to three and everything else drops to grey.
- **Colour by genus** — the eight most common genera get a hue, the rest fall into "other".
- **Filter** by origin, genus, species, trunk diameter (dual-range slider over a histogram)
  and ward, in any combination. The stats, the legend counts and the "most common trees"
  table all re-count against whatever is on screen.
- **Click any tree** for its species, trunk diameter, address, cross streets, ward, where it
  came from, and how it compares to the largest of its species in the city.
- Links are shareable: the URL hash carries the view, and a selected tree is addressed by
  coordinate rather than row number so the link survives a data refresh.

## How it works

```
ingest/    -> pulls the Street Tree Data inventory and ward boundaries from Toronto Open
              Data into DuckDB
dbt/       -> parses the City's free-text botanical names into genus/species/cultivar,
              joins the curated native-status list, and rolls up per-taxon and per-ward stats
              (dbt/seeds/ holds the three hand-curated reference tables)
export/    -> writes the marts out as gzipped binary columns + one metadata JSON
site/      -> a Leaflet map with a Canvas2D overlay that draws all 688k points
```

A GitHub Actions workflow (`.github/workflows/refresh.yml`) runs the whole chain weekly and
deploys `site/` straight to Pages as an artifact.

## Data source

[Street Tree Data](https://open.toronto.ca/dataset/street-tree-data/) from `open.toronto.ca`,
plus [City Wards](https://open.toronto.ca/dataset/city-wards/) for the boundary overlay. No
API key needed.

The dataset covers **City-owned trees on the road allowance** — so it is not a map of
Toronto's whole canopy. Park interiors, ravines and private back yards are all absent, which
is why the map thins out over the Don Valley and High Park.

The City also warns that positions are geocoded to the parcel address rather than surveyed at
the trunk, so a dot sits on the property, not on the tree. The map says so in its methodology
note rather than implying a precision the data doesn't have.

### Ingest takes the fast path, but doesn't depend on it

The inventory is ~690k rows. Paginating the CKAN datastore API at 20k rows a page takes about
35 minutes; the dataset's bulk CSV resource downloads in about 20 seconds. `fetch_trees.py`
uses the CSV — but **resolves its URL from `package_show` on every run** instead of hardcoding
it, and falls back to the API if the resource is renamed or withdrawn. That's a direct
response to how the older `to-housing` project died: it was built on a one-off static export
URL that eventually stopped existing.

The two routes disagree about geometry (the CSV emits `MultiPoint` with a nested coordinate
pair, the API emits a flat `Point`), so both shapes are unpacked.

## Native vs non-native

"Native" here means **indigenous to Ontario before European settlement**. The judgements live
in [`dbt/seeds/native_status.csv`](dbt/seeds/native_status.csv) — 218 hand-curated rows, one
per taxon, each with an origin region and a note. Corrections are welcome as PRs; it is a
plain CSV on purpose.

Three things worth knowing about how it's applied:

- **Status is resolved per species, and falls back to genus only when the genus is
  unambiguous.** For a genus with both native and introduced species — `Acer` could be a
  sugar maple or a Norway maple — a genus-only record stays "not identified to species"
  rather than being guessed. That's 47,466 trees (7%), reported as their own category
  instead of being quietly folded into either side.
- **Invasive is tracked separately from introduced**, because most introduced street trees
  are harmless and a few are not. 15 taxa are flagged, covering 136,410 trees.
- **Contested cases are labelled, not hidden.** Honey locust (59,904 trees, the third most
  common) is the significant one: sometimes reported as native to extreme southwestern
  Ontario, treated here as introduced, with the reasoning in its `notes` column. It moves the
  citywide native share by about nine points on its own.

Citywide the result is **38.9% native** among trees identified to species.

Some of the most-planted trees are species that are *at risk* in Canada — Kentucky
coffeetree (21,482 trees, threatened), butternut, cucumber tree, Shumard oak, flowering
dogwood. Urban forestry is propagating rarities at a scale the wild populations never see.

## The name parsing is most of the work

`BOTANICAL_NAME` is typed by inspectors and reads like it: mixed case (`ginkgo biloba`),
misspellings (`Allianthus altissima` for *Ailanthus*, `Abies balsamaea`), parenthetical
hybrid formulas, unbalanced quotes (`Ulmus davidiana 'japonica Morton`), botanical rank
markers (`f. inermis`, `subsp. ginnala`), unquoted trade names (`Betula nigra Heritage`),
and one non-breaking space inside `Ulmus x hollandica` that silently broke the parse until
whitespace was normalised first.

`stg_street_trees.sql` resolves all 304 distinct strings into 190 species-level taxa plus 28
genus-only ones, and `dbt/seeds/name_corrections.csv` documents every typo fix. Two dbt
tests assert the result stays clean: every taxon gets a native-status rule, and every tree
joins to a taxon.

Two other data-quality calls:

- **Trunk diameter over 300 cm is treated as a data-entry error** and dropped to null (39
  trees). The largest value in the file claims a 93.8 m trunk.
- **Common names are un-inverted** — the City stores `Oak, swamp white` for sorting, which
  becomes `Swamp white oak`. Where several spellings share one botanical name, the most
  frequent wins rather than the alphabetically last, which is what stopped *Acer platanoides*
  from being labelled "Norway Harlequin maple".

## Rendering 688k points without WebGL

`to-multiplex-map` deliberately avoids WebGL: MapLibre GL JS failed outright on a real Chrome
install with the GPU disabled. This map keeps that constraint, which rules out the usual
answer (deck.gl or vector tiles).

It works out fine, because the hot path never touches the DOM or a path API:

- Coordinates ship as **planar `uint32` scaled by 1e7** (~1 cm exact) and are projected once
  at load into normalized Web Mercator `Float64Array`s. `Float32` would have been the same
  size on the wire but drifts several pixels at zoom 19.
- At city zoom, trees are plotted **straight into an `ImageData` pixel buffer** — one 32-bit
  write per tree, no `arc()`, no `fill()`.
- Past zoom 15 they become real circles with radius from trunk diameter, batched into one
  path per colour so the number of `fill()` calls equals the number of legend entries.
- A **uniform grid in CSR form** (`start[]` offsets into a sorted `order[]`) culls to the
  viewport and answers click hit-tests.
- Panning and zoom animation are free: the layer extends `L.Renderer`, so Leaflet's own
  transform handling moves the canvas and a redraw only happens on `moveend`/`zoomend`.

Filters are plain typed-array scans over all 688k trees — a couple of milliseconds, which is
cheaper than maintaining per-category bitsets.

## The payload is 6.1 MB for every tree and every attribute

The whole inventory as GeoJSON is ~150 MB. As one gzipped typed array per attribute it's
6.1 MB, and nothing needs parsing — the bytes *are* the arrays.

| column | contents | gzipped |
|---|---|---|
| `coords.u32.gz` | lon/lat, planar, scaled 1e7 | 2.94 MB |
| `taxon.u16.gz` | index into `meta.taxa` | 0.66 MB |
| `dbh.u16.gz` | trunk diameter, cm | 0.61 MB |
| `addr.u16.gz` | street number | 0.66 MB |
| `street/cross1/cross2.u16.gz` | dictionary ids into `meta.streets` | 0.88 MB |
| `ward.u8.gz` | ward number | 0.01 MB |
| `trees.meta.json` | taxa, genera, species, streets, ward stats, histogram | 0.36 MB |

Two decisions did most of that work:

- **Genus, species, native status and colour all derive from `taxon_id`**, so they cost no
  bytes at all — a 2-byte index instead of five separate columns.
- **Rows are sorted by a coarse spatial grid** in `street_trees.sql`. Trees on the same block
  share a street name and often a species, so the dictionary-encoded columns compress ~5×.
  The ordering is load-bearing; don't re-sort in the export.

Columns load in two waves: coordinates, species, diameter and ward first (4.2 MB) so the map
paints, then the address columns in the background. Everything works before they land.

GitHub Pages won't negotiate gzip for `application/octet-stream`, so the files are gzipped on
disk and inflated with `DecompressionStream`, with `fflate` fetched only as a fallback.

`site/data/` is **not committed** — it's rebuilt in CI and deployed as a Pages artifact, so
the repo doesn't gain 6 MB of binaries every refresh.

## Colour, and why genus colouring is capped

The palette is the validated data-viz palette, and the constraint that shaped the UI is
this: **a dot map puts every pair of colours side by side**, so all pairs have to stay
distinguishable, not just neighbouring ones in a legend. Checking every subset of the
palette's eight hues against simulated protanopia and deuteranopia, **three is the largest
set that passes in both light and dark mode** — no four-hue subset does.

So the three-hue modes (origin, compare) are the accessible defaults, and the honest version
of "colour by genus" is *compare up to three*, not 73 hues. Two findings from actually
running the numbers rather than eyeballing them:

- Green-for-native and orange-for-introduced — the obvious semantic choice — collapses to
  ΔE 3.2 under protanopia. It's the classic red-green confusion, and it looks fine until
  someone can't use it.
- The full eight-hue palette fails even the *normal-vision* floor on all pairs (red vs
  orange, ΔE 7.1). The "Genus" mode ships anyway because it's genuinely useful and was asked
  for, but it's fourth in the list, and identity never rests on colour alone: hover names
  every tree, the legend is always labelled with counts, and the "most common trees" table is
  the same data without colour.

Trunk size uses a single-hue sequential ramp whose lightest step still clears 2:1 against
the basemap.

## Running locally

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python ingest/fetch_trees.py       # ~20 s, downloads a 145 MB CSV
python ingest/fetch_reference.py

cd dbt && dbt build --profiles-dir . && cd ..

python export/export_map_data.py
python export/check_payload.py

cd site && python -m http.server 8000
# open http://localhost:8000
```

`/header.js` 404s locally — it's the shared site header served from the root of
malcolmkennedy.com. The map is built to work without it.

## Deploying

The workflow builds and deploys on its own; set **Settings → Pages → Source → GitHub
Actions** and either wait for the weekly run or trigger it from the Actions tab. With the
user Pages site on a custom domain, this repo is served at
`malcolmkennedy.com/to-tree-map`, which is also what makes the root-relative `/header.js`
resolve.
