"""Generate the two analysis map pages from one shell.

They are the same document with a different title, legend heading and configuration
block, so maintaining copies by hand would guarantee they drift apart. Run this when
the shell changes; the output is committed.

Not a build step -- the site is served exactly as committed, and nothing in the deploy
runs this. It is a generator you invoke yourself, like analysis/make_da_boundaries.py.
"""
import json
import pathlib

CREDIT = ('Trees: <a href="https://open.toronto.ca/dataset/street-tree-data/">'
          'City of Toronto</a>')
CANOPY_CREDIT = ('Canopy: <a href="https://open.toronto.ca/dataset/forest-and-land-cover/">'
                 'City of Toronto, 2018 Tree Canopy Study</a>')
NAV = [
    ("../", "All 688,335 trees"),
    ("age.html", "Estimated age"),
    ("canopy.html", "Canopy cover"),
    ("density.html", "Population density scatter"),
    ("parking.html", "Front-yard parking"),
]

SHELL = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <meta name="description" content="{description}">
  <link rel="canonical" href="https://malcolmkennedy.com/to-tree-map/analysis/{slug}.html">
  <!-- Unlisted while these are still being worked on: reachable by URL, but kept
       out of search results and not linked from the tree map. -->
  <meta name="robots" content="noindex, nofollow">

  <meta name="theme-color" content="#ffffff">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <link rel="stylesheet" href="../style.css">
  <link rel="stylesheet" href="analysis.css">
</head>
<body data-ramp="{ramp}">
<script src="/header.js"></script>
  <div class="app">
    <main id="map-pane">
      <div id="map"></div>
      <div id="search" class="map-search"></div>
      <div class="tree-tip" id="tip" hidden></div>
      <div class="map-badge" id="loading-badge">
        <span class="spinner" aria-hidden="true"></span>
        <span>{loading}</span>
      </div>
    </main>

    <aside class="panel" id="panel">
      <div class="panel-handle-row">
        <button class="panel-drag-handle" id="panel-toggle" aria-label="Toggle panel" aria-expanded="false">
          <span class="handle-bar"></span>
          <span class="handle-label">Stats &amp; legend</span>
        </button>
        <button class="panel-hide-btn" id="panel-hide" aria-label="Hide panel and show map">
          Hide &#9660;
        </button>
      </div>

      <div class="panel-scroll">
        <header class="panel-header">
          <h1>{heading}</h1>
          <nav class="an-nav" aria-label="Analyses">{nav}</nav>
          <div class="stats" id="stats"></div>
        </header>

        <div class="an-section">
          <h2 id="legend-unit"></h2>
          <div class="ramp-legend" id="legend"></div>
        </div>

        <div class="an-section">
          <h2>Distribution</h2>
          <div id="panel-chart"></div>
        </div>

        <div class="an-section">
          <h2>Sources</h2>
          <ul class="an-sources">{sources}</ul>
{asof}
        </div>
      </div>
    </aside>
  </div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="../basemap.js"></script>
  <script src="../panel.js"></script>
  <script src="/map-search.js"></script>
  <!-- Written at deploy time from the CARTO_API_KEY secret; absent locally, which is fine. -->
  <script src="../config.js"></script>
  <script>
{config}
  </script>
  <script src="analysis.js"></script>

  <!-- Pageview counts only (GoatCounter): no cookies, so no consent banner needed. -->
  <script data-goatcounter="https://zuzubak.goatcounter.com/count"
          async src="//gc.zgo.at/count.js"></script>
</body>
</html>
"""

TREE_SOURCE = ('<li><a href="https://open.toronto.ca/dataset/street-tree-data/">'
               'Street Tree Data</a>, City of Toronto</li>')
CANOPY_SOURCE = ('<li><a href="https://open.toronto.ca/dataset/forest-and-land-cover/">'
                 'Forest and Land Cover</a>, 2018 Tree Canopy Study, City of Toronto</li>')
CENSUS_SOURCE = ('<li><a href="https://www150.statcan.gc.ca/n1/en/catalogue/98100015">'
                 'Census of Population, 2021</a>, Statistics Canada</li>')
CENTRELINE_SOURCE = ('<li><a href="https://open.toronto.ca/dataset/toronto-centreline-tcl/">'
                     'Toronto Centreline</a>, City of Toronto</li>')
METHOD_SOURCE = ('<li>Age: diameter in inches &times; an ISA growth factor for the '
                 'species. See the <a href="https://github.com/zuzubak/to-tree-map">'
                 'repository</a> for the factor table and how each tree was matched.</li>')

PAGES = [
    dict(
        slug="age", ramp="heat",
        title="Toronto Street Tree Ages",
        heading="Estimated age of street trees",
        description="Estimated age of Toronto's street trees by block, from trunk diameter.",
        loading="Loading 39,000 blocks&hellip;",
        sources=TREE_SOURCE + CENTRELINE_SOURCE + METHOD_SOURCE,
        asof='          <p class="an-note" id="as-of"></p>',
        config="""    window.ANALYSIS = {
      source: "streets",
      metric: "med",
      decimals: 0,
      unit: "Median estimated age, years",
      unitShort: "years",
      tipLabel: "Median estimated age",
      nullLabel: "No trees with an age",
      chart: "age",
      credit: %CREDIT%,
      stats: ({ meta, summary, compact, num }) => [
        [num(meta.city_median_age, 0), "Median age, years"],
        [num(meta.city_mean_age, 0), "Mean age, years"],
        [compact(meta.trees_aged), "Trees with an estimate"],
        [compact(summary.segments), "Blocks mapped"],
      ],
    };""",
    ),
    dict(
        slug="canopy", ramp="canopy",
        title="Toronto Tree Canopy Cover",
        heading="Tree canopy cover by block",
        description="Share of each Toronto census block covered by tree canopy, from the City's 2018 Tree Canopy Study.",
        loading="Loading 3,727 census blocks&hellip;",
        # No as-of line: nothing on this page moves with the weekly tree refresh.
        sources=CANOPY_SOURCE + CENSUS_SOURCE,
        asof="",
        config="""    window.ANALYSIS = {
      source: "blocks",
      metric: "cpct",
      decimals: 0,
      unit: "Tree canopy, % of block area",
      unitShort: "%",
      tipLabel: "Canopy cover",
      nullLabel: "Not measured",
      chart: "metric",
      credit: %CANOPY_CREDIT%,
      dist: ({ summary }) => ({
        bin: 5,
        cap: 70,
        median: summary.med_canopy,
        axis: ["0", "35", "70%+"],
        note: "",
      }),
      stats: ({ summary, compact, num }) => [
        [num(summary.city_canopy, 1) + "%", "City canopy cover"],
        [num(summary.med_canopy, 1) + "%", "Median block"],
        [compact(summary.canopy_ha) + " ha", "Canopy mapped"],
        [compact(summary.areas), "Blocks mapped"],
      ],
    };""",
    ),
]

SCATTER_SHELL = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <meta name="description" content="{description}">
  <link rel="canonical" href="https://malcolmkennedy.com/to-tree-map/analysis/{slug}.html">
  <!-- Unlisted while these are still being worked on: reachable by URL, but kept
       out of search results and not linked from the tree map. -->
  <meta name="robots" content="noindex, nofollow">

  <meta name="theme-color" content="#ffffff">
  <link rel="stylesheet" href="../style.css">
  <link rel="stylesheet" href="analysis.css">
</head>
<body data-ramp="muni">
<script src="/header.js"></script>
  <div class="app">
    <main id="chart-pane">
      <div class="chart-box">
        <canvas id="chart"></canvas>
        <div class="chart-tip" id="tip" hidden></div>
      </div>
      <div class="map-badge" id="loading-badge">
        <span class="spinner" aria-hidden="true"></span>
        <span>{loading}</span>
      </div>
    </main>

    <aside class="panel" id="panel">
      <div class="panel-handle-row">
        <button class="panel-drag-handle" id="panel-toggle" aria-label="Toggle panel" aria-expanded="false">
          <span class="handle-bar"></span>
          <span class="handle-label">Stats &amp; legend</span>
        </button>
        <button class="panel-hide-btn" id="panel-hide" aria-label="Hide panel and show chart">
          Hide &#9660;
        </button>
      </div>

      <div class="panel-scroll">
        <header class="panel-header">
          <h1>{heading}</h1>
          <nav class="an-nav" aria-label="Analyses">{nav}</nav>
          <div class="stats" id="stats"></div>
        </header>

        <div class="an-section">
          <h2>The line</h2>
          <div class="line-key">
            <span><i class="solid"></i>Average of each {xbin} bin</span>
          </div>
        </div>

        <div class="an-section">
          <h2>Former municipality</h2>
          <div class="muni-legend" id="legend"></div>
        </div>

        <div class="an-section">
          <h2>By municipality</h2>
          <div class="table-scroll">
            <table id="muni-table">
              <thead>
                <tr>
                  <th scope="col">Municipality</th>
                  <th scope="col">Blocks</th>
                  <th scope="col">{xcol}</th>
                  <th scope="col">{ycol}</th>
                  <th scope="col">Top tenth</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>

        <div class="an-section">
          <h2>Sources</h2>
          <ul class="an-sources">{sources}</ul>
        </div>
      </div>
    </aside>
  </div>

  <script src="../panel.js"></script>
  <script>
{config}
  </script>
  <script src="scatter.js"></script>

  <!-- Pageview counts only (GoatCounter): no cookies, so no consent banner needed. -->
  <script data-goatcounter="https://zuzubak.goatcounter.com/count"
          async src="//gc.zgo.at/count.js"></script>
</body>
</html>
"""

PARKING_SOURCE = ('<li><a href="https://open.toronto.ca/dataset/residential-front-yard-parking/">'
                  'Residential Front Yard Parking</a>, City of Toronto</li>')
BOUNDARY_SOURCE = ('<li><a href="https://open.toronto.ca/dataset/former-municipality-boundaries/">'
                   'Former Municipality Boundaries</a>, City of Toronto</li>')

Y_CANOPY = """
      yKey: "cpct",
      yMax: 80,
      yLabel: "Tree canopy, % of block area",
      yShort: "canopy",
      ySuffix: "%","""

SCATTERS = [
    dict(
        slug="density",
        title="Population Density vs Canopy",
        heading="Population density scatter",
        description="Population density against tree canopy cover for every census block in Toronto.",
        loading="Loading 3,565 census blocks&hellip;",
        xbin="density", xcol="Median density", ycol="Median canopy",
        sources=CANOPY_SOURCE + CENSUS_SOURCE + BOUNDARY_SOURCE,
        config="""    window.SCATTER = {
      xKey: "x",
      xScale: "log",
      xMin: 1,
      xMax: 1000,
      ticks: [1, 3, 10, 30, 100, 300, 1000],
      xLabel: "Residents per hectare (log scale)",
      xUnit: "residents per hectare",
      xShort: "/ha",
      xDecimals: 0,%Y%
      bins: 21,
      minBin: 12,
    };""",
    ),
    dict(
        slug="parking",
        title="Front-Yard Parking vs Canopy",
        heading="Front-yard parking scatter",
        description="Licensed front-yard parking against tree canopy cover for every census block in Toronto.",
        loading="Loading 3,570 census blocks&hellip;",
        xbin="parking", xcol="Median parking", ycol="Median canopy",
        sources=CANOPY_SOURCE + PARKING_SOURCE + CENTRELINE_SOURCE + BOUNDARY_SOURCE,
        config="""    window.SCATTER = {
      xKey: "park",
      xScale: "linear",
      xMin: 0,
      xMax: 8,
      ticks: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      xLabel: "Licensed front-yard parking spaces per 100 m of street",
      xUnit: "licensed spaces per 100 m",
      xShort: "per 100 m",
      xDecimals: 1,%Y%
      bins: 8,
      minBin: 12,
    };""",
    ),
]

out = pathlib.Path(__file__).resolve().parents[1] / "site" / "analysis"
for page in PAGES:
    nav = "".join(
        f'<a href="{href}"' + (' aria-current="page"' if href == page["slug"] + ".html" else "")
        + f'>{label}</a>'
        for href, label in NAV
    )
    config = (page["config"]
              .replace("%CREDIT%", json.dumps(CREDIT))
              .replace("%CANOPY_CREDIT%", json.dumps(CANOPY_CREDIT + " &middot; " + CREDIT)))
    html = SHELL.format(nav=nav, **{**page, "config": config})
    (out / f"{page['slug']}.html").write_text(html)
    print(f"  wrote {page['slug']}.html")

for page in SCATTERS:
    nav = "".join(
        f'<a href="{href}"' + (' aria-current="page"' if href == page["slug"] + ".html" else "")
        + f'>{label}</a>'
        for href, label in NAV
    )
    html = SCATTER_SHELL.format(nav=nav, **{**page, "config": page["config"].replace("%Y%", Y_CANOPY)})
    (out / f"{page['slug']}.html").write_text(html)
    print(f"  wrote {page['slug']}.html")
