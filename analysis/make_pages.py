"""Generate the three analysis pages from one shell.

They are the same document with a different title, lede, legend heading, caveats and
one configuration block, so maintaining three copies by hand would guarantee they
drift apart. Run this when the shared shell changes; the output is committed.

Not a build step -- the site is served exactly as committed, and nothing in the
deploy runs this. It is a generator you invoke yourself, like
analysis/make_da_boundaries.py.
"""
import json
import pathlib

CREDIT = ('Trees: <a href="https://open.toronto.ca/dataset/street-tree-data/">'
          'City of Toronto</a>')
NAV = [
    ("age.html", "Estimated age"),
    ("streets.html", "Trees per 100 m"),
    ("people.html", "Trees per resident"),
    ("density.html", "Density vs planting"),
    ("../", "← All 688,335 trees"),
]

SHELL = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <meta name="description" content="{description}">
  <link rel="canonical" href="https://malcolmkennedy.com/to-tree-map/analysis/{slug}.html">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Malcolm Kennedy">
  <meta property="og:url" content="https://malcolmkennedy.com/to-tree-map/analysis/{slug}.html">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{description}">
  <meta name="twitter:card" content="summary">

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
          <p class="an-subtitle">{lede}</p>
          <div class="stats" id="stats"></div>
        </header>

        <div class="an-section">
          <h2 id="legend-unit"></h2>
          <div class="ramp-legend" id="legend"></div>
          <p class="an-note">
            Five classes, cut at quintiles, so each holds about the same number of
            {features}. The breaks are printed because that makes the class widths
            uneven &mdash; the alternative, equal widths, would put most of the city in
            one colour to leave room for a handful of extremes.
          </p>
        </div>

        <div class="an-section">
          <h2>Distribution</h2>
          <div id="panel-chart"></div>
        </div>

{sections}
        <p class="an-note" id="as-of"></p>
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

METHOD = """        <div class="an-section">
          <h2>How the age is estimated</h2>
          <p class="an-note">
            There is no planting date in the inventory, so age is estimated from trunk
            diameter by the arborist's standard field method: <strong>diameter in inches
            &times; a growth factor for the species</strong>, where the factor is the
            average number of years that species takes to add an inch of trunk.
          </p>
          <p class="an-note">
            Where each factor came from, by tree:
          </p>
          <div class="an-provenance" id="provenance"></div>
          <p class="an-note">
            The published factors describe open-grown landscape trees. A street tree in
            a four-foot pit with compacted soil and road salt thickens more slowly than
            that, so these figures run young on the most stressed sites.
          </p>
        </div>

        <div class="an-section">
          <h2>What this cannot tell you</h2>
          <p class="an-note">
            <strong>It is an estimate shaped like a measurement.</strong> Treat a single
            block as an indication and the city-wide pattern as the finding.
          </p>
          <p class="an-note">
            The input is no better than the method. Recorded diameters heap on round
            numbers, and <strong><span data-fact="dbhHeap"></span> trees &mdash;
            <span data-fact="dbhHeapShare"></span> of the inventory &mdash; sit on
            exactly 4 cm or 8 cm</strong>, which is a field convention rather than that
            many identical trunks. That flattens the young end of every distribution on
            this page.
          </p>
          <p class="an-note">
            Arithmetic on a bad diameter produces a bad age, and a slow-growing species
            multiplies the error. <span data-fact="implausible"></span> trees came out
            older than 250 years &mdash; a 203 cm yew, a 250 cm hawthorn, neither of
            which exists &mdash; and are excluded from every figure here.
          </p>
        </div>
"""

STREET_METHOD = """        <div class="an-section">
          <h2>How this is measured</h2>
          <p class="an-note">
            Each line is one <strong>centreline segment</strong> &mdash; one block of
            one street, between intersections. Every tree in the inventory is snapped to
            the nearest segment carrying its street name, and the count is divided by
            the block's own length.
          </p>
          <p class="an-note">
            Two kinds of street are left out, both because they are not street-tree
            frontage. <strong>Expressways and their ramps</strong> are grade-separated
            through-routes, and leaving them in would stripe the map with false zeroes
            along the 401, the DVP and the Gardiner. <strong>Laneways</strong> are
            almost never planted &mdash; 3,918 of the city's 4,146 laneway segments hold
            no inventoried tree at all &mdash; and left in they were two fifths of every
            block coloured "no street trees", which says more about what a laneway is
            than about Toronto's canopy. The few trees genuinely on one are still
            counted, against whichever real street runs within 60 m.
          </p>
          <p class="an-note">
            Blocks shorter than 20 m are left out too &mdash; a 6 m connector with two
            trees is not 33 trees per 100 m of streetscape.
          </p>
        </div>

        <div class="an-section">
          <h2>What this cannot tell you</h2>
          <p class="an-note">
            <strong>A zero is not proof of a bare street.</strong> This is the City's
            inventory of <em>street</em> trees: trees on private front lawns, in parks
            and on institutional land are not in it, so a leafy street of deep private
            gardens can read as empty here.
          </p>
          <p class="an-note">
            <span data-fact="unsnapped"></span> trees &mdash;
            <span data-fact="unsnappedPct"></span> &mdash; could not be matched to any
            segment within 60 m of a street of their recorded name, and are missing
            from the counts.
          </p>
          <p class="an-note">
            Trees are counted per block, not per side, so a one-sided planting and a
            two-sided one of the same density are indistinguishable.
          </p>
        </div>
"""

PEOPLE_METHOD = """        <div class="an-section">
          <h2>How this is measured</h2>
          <p class="an-note">
            Population comes from the <strong>2021 Census</strong> at the dissemination
            area level &mdash; 3,727 of them inside Toronto, averaging about 750
            residents each. Every tree is assigned to the area its coordinates fall in.
          </p>
          <p class="an-note">
            Areas rather than individual census blocks, for two reasons: block-level
            population is only published in a file StatCan's firewall will not serve to
            a script, and a block holding four trees produces a ratio that swings wildly
            on one record.
          </p>
        </div>

        <div class="an-section">
          <h2>What this cannot tell you</h2>
          <p class="an-note">
            <strong>A high ratio can mean nobody lives there.</strong> The extreme is
            <span data-fact="extreme"></span>. That is an arithmetically correct way of
            saying it is a ravine. Quintile classes keep one such area from taking over
            the colour scale, but read the top class with that in mind.
          </p>
          <p class="an-note">
            Eight areas have no recorded residents at all and are left grey rather than
            given an infinite ratio.
          </p>
          <p class="an-note">
            Census boundaries are not catchments. A resident on the edge of an area
            walks under the next area's trees, and this measure cannot see that.
          </p>
        </div>
"""

AGE_NOTE = ("Every street tree with an estimated age, in ten-year bins. The long tail "
            "past a century is where the method is least trustworthy.")

PAGES = [
    dict(
        slug="age", ramp="heat",
        title="Toronto Street Tree Ages",
        heading="Estimated age of Toronto's street trees",
        description=("An interactive map of the estimated age of Toronto's street trees, "
                     "block by block. Age is estimated from trunk diameter using "
                     "published species growth factors. Click any block for its full "
                     "age distribution."),
        lede=("Trunk diameter is the only clue the inventory gives about age, so every "
              "figure here is an estimate. Click a block for the spread behind its "
              "median."),
        loading="Loading 39,000 blocks&hellip;",
        features="blocks",
        sections=METHOD,
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
        slug="streets", ramp="heat",
        title="Toronto Street Tree Density",
        heading="Street trees per 100 m of street",
        description=("An interactive map of how densely Toronto's streets are planted: "
                     "street trees per 100 metres of street, for every one of the "
                     "city's 39,000 blocks."),
        lede=('Trees counted against the length of street they stand on, block by '
              'block, across <span data-fact="km"></span> km of Toronto streets.'),
        loading="Loading 39,000 blocks&hellip;",
        features="blocks",
        sections=STREET_METHOD,
        config="""    window.ANALYSIS = {
      source: "streets",
      metric: "per100",
      decimals: 1,
      unit: "Street trees per 100 m",
      unitShort: "per 100 m",
      tipLabel: "Trees per 100 m",
      // A fifth of the city's blocks have no inventoried street tree at all. That is a
      // different statement from "fewer than most", so it gets its own class instead of
      // the pale bottom of a ramp -- and it keeps the quintiles off a break of zero.
      zeroClass: true,
      zeroLabel: "No street trees",
      nullLabel: "Too short to rate",
      chart: "metric",
      credit: %CREDIT%,
      dist: ({ summary }) => ({
        bin: 2.5,
        cap: 40,
        median: summary.median_per_100m,
        axis: ["0", "20", "40+ per 100 m"],
        note: "Every block, by how densely it is planted. The spike at zero is every "
            + "block with no inventoried street tree at all, counted in the legend "
            + "above.",
      }),
      stats: ({ summary, compact, num }) => [
        [num(summary.median_per_100m, 1), "Median per 100 m"],
        [compact(summary.trees), "Trees placed"],
        [compact(summary.km) + " km", "Street measured"],
        [compact(summary.segments), "Blocks mapped"],
      ],
    };""",
    ),
    dict(
        slug="people", ramp="people",
        title="Toronto Street Trees Per Resident",
        heading="Street trees per 1,000 residents",
        description=("An interactive map of how many of Toronto's street trees there "
                     "are per resident, using 2021 Census population at the "
                     "dissemination-area level."),
        lede=("The city's street trees set against the people who live among them, "
              "using 2021 Census population. Click an area for its age distribution."),
        loading="Loading 3,727 census areas&hellip;",
        features="areas",
        sections=PEOPLE_METHOD,
        config="""    window.ANALYSIS = {
      source: "blocks",
      metric: "per1k",
      decimals: 0,
      unit: "Street trees per 1,000 residents",
      unitShort: "per 1,000",
      tipLabel: "Trees per 1,000 residents",
      nullLabel: "No residents recorded",
      chart: "metric",
      credit: %CREDIT% + ' &middot; Population: <a href="https://www150.statcan.gc.ca/n1/en/catalogue/98100015">Statistics Canada, 2021 Census</a>',
      dist: ({ summary }) => ({
        bin: 50,
        cap: 800,
        median: summary.med_per1k,
        axis: ["0", "400", "800+ per 1,000"],
        note: "Every census area, by trees per 1,000 residents. The top bin is open "
            + "ended: a handful of near-empty industrial and ravine areas run into "
            + "the thousands.",
      }),
      stats: ({ summary, compact, num }) => [
        [num(summary.city_per1k, 0), "City-wide per 1,000"],
        [num(summary.med_per1k, 0), "Median area"],
        [compact(summary.people), "Residents (2021)"],
        [compact(summary.areas), "Areas mapped"],
      ],
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
    html = SHELL.format(nav=nav, **{**page,
                                    "config": page["config"].replace("%CREDIT%", json.dumps(CREDIT))})
    (out / f"{page['slug']}.html").write_text(html)
    print(f"  wrote {page['slug']}.html")
