/* The three analysis maps -- estimated age, trees per 100 m of street, trees per
 * resident -- as one engine with three configurations.
 *
 * They differ in which payload they read, which number they colour by and what the
 * caveats are; everything else (classification, legend, hover, popup, the panel
 * histogram) is identical, so it lives here once. Each page sets window.ANALYSIS
 * before loading this file. See age.html for the shape.
 *
 * Classification is by quantile, not equal interval. All three measures have long
 * right tails -- a near-empty ravine area scores thousands of trees per resident --
 * and equal intervals would put the whole city in the bottom class to make room for
 * one outlier. Quantiles spend the ramp where the data is, at the cost of class
 * widths that differ, which is why the legend prints the actual break values.
 *
 * Unlike the tree map there is no custom canvas layer here: 3,727 areas and 42,947
 * segments are small enough for Leaflet's own canvas renderer, and polygons would
 * need hit-testing written by hand.
 */
(function () {
  "use strict";

  const CONF = window.ANALYSIS;
  const DATA = "../data/analysis/";
  const CENTER = [43.72, -79.37];
  const ZOOM = 11;
  const RAMP_STEPS = 5;

  const el = (id) => document.getElementById(id);
  const cssVar = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const nf = (d) => new Intl.NumberFormat("en-CA",
    { minimumFractionDigits: d, maximumFractionDigits: d });
  const num = (v, d = 0) => (v == null ? "–" : nf(d).format(v));
  const compact = (v) => (v == null ? "–" : new Intl.NumberFormat("en-CA",
    { notation: "compact", maximumFractionDigits: 1 }).format(v));

  let map = null;
  let baseLayer = null;
  let layer = null;
  let features = [];
  let meta = null;
  let summary = null;
  let classes = null;      // { breaks, colours, labels, counts, nullCount }
  let selected = null;     // the feature layer with a click highlight

  /* ------------------------------------------------------------ classification ---- */

  function quantileBreaks(sorted, count) {
    const out = [];
    for (let i = 1; i < count; i++) {
      out.push(sorted[Math.floor((sorted.length * i) / count)]);
    }
    // Duplicate breaks would make a legend class that cannot contain anything
    // ("18 to 18"), which happens as soon as one value holds more than its share of
    // the distribution. Collapsing them gives fewer but honest classes.
    return out.filter((v, i) => i === 0 || v > out[i - 1]);
  }

  function rampColours(n) {
    const all = [];
    for (let i = 1; i <= RAMP_STEPS; i++) all.push(cssVar(`--an-${i}`));
    if (n >= RAMP_STEPS) return all;
    // Fewer classes than ramp steps: keep both ends, space the rest, so the extremes
    // still read as extremes rather than as the middle of a ramp.
    const out = [];
    for (let i = 0; i < n; i++) out.push(all[Math.round((i * (RAMP_STEPS - 1)) / (n - 1))]);
    return out;
  }

  function buildClasses() {
    const vals = [];
    for (const f of features) {
      const v = f.properties[CONF.metric];
      if (v != null) vals.push(v);
    }
    const ranked = (CONF.zeroClass ? vals.filter((v) => v > 0) : vals).sort((a, b) => a - b);
    const breaks = quantileBreaks(ranked, CONF.zeroClass ? RAMP_STEPS - 1 : RAMP_STEPS);
    const total = breaks.length + 1 + (CONF.zeroClass ? 1 : 0);
    const colours = rampColours(total);

    const d = CONF.decimals || 0;
    const lo = ranked[0];
    const hi = ranked[ranked.length - 1];
    const labels = [];
    if (CONF.zeroClass) labels.push(CONF.zeroLabel);
    for (let k = 0; k <= breaks.length; k++) {
      const from = k === 0 ? lo : breaks[k - 1];
      const to = k === breaks.length ? hi : breaks[k];
      labels.push(k === breaks.length
        ? `${num(from, d)} and up`
        : `${num(from, d)}–${num(to, d)}`);
    }

    classes = { breaks, colours, labels, counts: new Array(total).fill(0), nullCount: 0, lo, hi };
    for (const f of features) {
      const c = classOf(f.properties[CONF.metric]);
      if (c < 0) classes.nullCount += 1;
      else classes.counts[c] += 1;
    }
  }

  function classOf(v) {
    if (v == null) return -1;
    // Zero is its own class on the street map, not the pale bottom of a ramp: "no
    // street trees at all" is a different statement from "fewer than most", and a
    // fifth of the city's segments are in it.
    if (CONF.zeroClass && v === 0) return 0;
    let i = 0;
    while (i < classes.breaks.length && v >= classes.breaks[i]) i += 1;
    return i + (CONF.zeroClass ? 1 : 0);
  }

  function colourOf(v) {
    const c = classOf(v);
    return c < 0 ? cssVar("--an-null") : classes.colours[c];
  }

  /* ------------------------------------------------------------ histogram -------- */

  /* bars: counts, evenly spaced. ghost: a reference shape scaled to the same height,
   * so a block's distribution can be read against the city's. marker/breaks: x
   * positions as fractions of the width. */
  function histogram({ bars, ghost = null, marker = null, breaks = [], axis = [], height = 48, key = "" }) {
    const max = Math.max(1, ...bars);
    const gmax = ghost ? Math.max(1, ...ghost) : 1;
    const cols = bars.map((v, i) => {
      const parts = [];
      if (ghost) {
        const gh = (ghost[i] / gmax) * 100;
        if (gh > 0) parts.push(`<i class="ghost" style="height:${gh.toFixed(1)}%"></i>`);
      }
      const bh = (v / max) * 100;
      if (bh > 0) parts.push(`<i class="bar" style="height:${bh.toFixed(1)}%"></i>`);
      return `<div class="hist-col">${parts.join("")}</div>`;
    }).join("");

    const rules = breaks.map((frac) =>
      `<span class="hist-break" style="left:${(frac * 100).toFixed(2)}%;height:${height}px"></span>`).join("")
      + (marker == null ? ""
        : `<span class="hist-rule" style="left:${(marker * 100).toFixed(2)}%;height:${height}px"></span>`);

    const ticks = axis.map((t) => `<span>${esc(t)}</span>`).join("");
    return `<div class="hist">`
      + `<div class="hist-bars" style="height:${height}px">${cols}</div>`
      + rules
      + (ticks ? `<div class="hist-axis">${ticks}</div>` : "")
      + (key ? `<div class="hist-key">${key}</div>` : "")
      + `</div>`;
  }

  /* Age histograms use the same fixed ten-year bins the warehouse aggregates into,
   * with everything past 140 in the top bin. The payload ships positional counts with
   * trailing zeros trimmed, so they get padded back here. */
  const AGE_BIN = 10;
  const AGE_BINS = 15;      // 0-9 ... 130-139, 140+
  const AGE_SPAN = AGE_BIN * AGE_BINS;

  function ageBars(counts) {
    const out = new Array(AGE_BINS).fill(0);
    if (counts) {
      for (let i = 0; i < counts.length && i < AGE_BINS; i++) out[i] = counts[i];
    }
    return out;
  }

  /* A distribution of the mapped metric across the mapped features, for the panel.
   * Everything at or above the cap lands in the top bin, which is labelled as open
   * ended -- the alternative is sixty empty bins and one spike. */
  function metricBars(bin, cap) {
    const n = Math.ceil(cap / bin) + 1;
    const out = new Array(n).fill(0);
    for (const f of features) {
      const v = f.properties[CONF.metric];
      if (v == null) continue;
      out[Math.min(n - 1, Math.floor(v / bin))] += 1;
    }
    return { bars: out, span: n * bin };
  }

  /* ------------------------------------------------------------ naming ---------- */

  /* A street segment is one block of one street, and what makes it findable is the
   * pair of cross streets at its ends. hc is the north or east end, lc the south or
   * west one; ns says which axis those are. Where the pipeline could not place the
   * ends, ca/cb still name the block without ordering it. */
  function crossLabel(p) {
    const dirs = p.ns ? ["N", "S"] : ["E", "W"];
    if (p.hc && p.lc) {
      // Crescents and loops leave and rejoin the same street, so both ends can carry
      // one name. "N: X, S: X" reads like a mistake; say what is actually true.
      if (p.hc === p.lc) return `both ends at ${esc(p.hc)}`;
      return `${dirs[0]}: ${esc(p.hc)} &middot; ${dirs[1]}: ${esc(p.lc)}`;
    }
    if (p.hc) return `${dirs[0]}: ${esc(p.hc)}`;
    if (p.lc) return `${dirs[1]}: ${esc(p.lc)}`;
    if (p.ca && p.cb) return `between ${esc(p.ca)} and ${esc(p.cb)}`;
    return "";
  }

  function featureName(p) {
    if (CONF.source === "streets") return p.name || "Unnamed street";
    return p.ward || `Dissemination area ${p.id}`;
  }

  /* ------------------------------------------------------------ rendering -------- */

  function renderStats() {
    const host = el("stats");
    host.textContent = "";
    for (const [value, label] of CONF.stats({ meta, summary, compact, num })) {
      const tile = document.createElement("div");
      tile.className = "stat-tile";
      const v = document.createElement("div");
      v.className = "stat-value";
      v.textContent = value;
      const l = document.createElement("div");
      l.className = "stat-label";
      l.textContent = label;
      tile.append(v, l);
      host.appendChild(tile);
    }
  }

  function renderLegend() {
    const rows = classes.colours.map((colour, i) => `
      <div class="ramp-row">
        <span class="swatch" style="background:${colour}"></span>
        <span class="range">${esc(classes.labels[i])}</span>
        <span class="count">${num(classes.counts[i])}</span>
      </div>`).join("");
    const nullRow = classes.nullCount === 0 ? "" : `
      <div class="ramp-row">
        <span class="swatch" style="background:${cssVar("--an-null")}"></span>
        <span class="range">${esc(CONF.nullLabel)}</span>
        <span class="count">${num(classes.nullCount)}</span>
      </div>`;
    el("legend").innerHTML = rows + nullRow;
    const unit = el("legend-unit");
    if (unit) unit.textContent = CONF.unit;
  }

  function renderPanelChart() {
    const host = el("panel-chart");
    if (CONF.chart === "age") {
      const bars = ageBars(meta.city_hist);
      const median = meta.city_median_age;
      host.innerHTML = histogram({
        bars,
        marker: Math.min(1, median / AGE_SPAN),
        axis: ["0", "70", "140+ years"],
        key: `<span><i class="rule"></i>City median, ${num(median, 0)} years</span>`,
      }) + `<p class="an-chart-note">Every one of the ${compact(meta.trees_aged)} `
         + `trees with an estimated age, in ten-year bins. The long tail past a `
         + `century is where the method is least trustworthy.</p>`;
      return;
    }
    // dist is a function because the median it marks comes from the payload's own
    // summary, which is not loaded when the page declares its configuration.
    const dist = CONF.dist({ meta, summary });
    const { bars, span } = metricBars(dist.bin, dist.cap);
    host.innerHTML = histogram({
      bars,
      marker: Math.min(1, dist.median / span),
      breaks: classes.breaks.map((b) => Math.min(1, b / span)),
      axis: dist.axis,
      key: `<span><i class="rule"></i>City median, ${num(dist.median, CONF.decimals)}</span>`
         + `<span><i class="dash"></i>Class breaks</span>`,
    }) + `<p class="an-chart-note">${dist.note}</p>`;
  }

  function renderProvenance() {
    const host = el("provenance");
    if (!host) return;
    const total = Object.values(meta.basis).reduce((a, b) => a + b, 0);
    const pretty = { isa: "Species growth factor", genus_median: "Genus median, species not listed",
                     rule_of_thumb: "Rule of thumb for the genus" };
    host.innerHTML = Object.entries(meta.basis)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `<div class="popup-row"><span class="k">${esc(pretty[k] || k)}</span>`
        + `<span class="v">${num((n / total) * 100, 1)}%</span></div>`)
      .join("");
  }

  /* ------------------------------------------------------------ popup & tip ------ */

  function row(k, v) {
    return `<div class="popup-row"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
  }

  function blockPopup(p) {
    let html = `<div class="popup-title">${esc(p.ward || "Dissemination area")}</div>`;
    html += `<div class="popup-cross">Area ${esc(p.id)}`
          + `${p.ha ? ` &middot; ${num(p.ha, 1)} ha` : ""}</div>`;
    html += row("Street trees", num(p.n));
    html += row("Residents (2021)", p.pop ? num(p.pop) : "none recorded");
    html += row("Per 1,000 residents", p.per1k == null ? "–" : num(p.per1k, 0));
    html += row("Per hectare", num(p.perha, 1));
    if (p.aged) {
      html += `<div class="popup-sep">`
            + row("Median estimated age", `${num(p.med, 1)} yrs`)
            + row("Mean estimated age", `${num(p.mean, 1)} yrs`)
            + `</div>`;
      const bars = ageBars(p.hist);
      html += `<div class="popup-hist">` + histogram({
        bars,
        ghost: ageBars(meta.city_hist),
        marker: Math.min(1, p.med / AGE_SPAN),
        axis: ["0", "70", "140+ years"],
        height: 40,
        key: `<span><i class="bar"></i>This area</span>`
           + `<span><i class="ghost"></i>City, rescaled</span>`
           + `<span><i class="rule"></i>Median</span>`,
      }) + `</div>`;
      html += `<p class="an-chart-note">${num(p.aged)} of ${num(p.n)} trees have an `
            + `estimated age.</p>`;
    } else {
      html += `<p class="an-chart-note popup-sep">No trees here have an estimated `
            + `age, so there is no distribution to draw.</p>`;
    }
    return html;
  }

  function streetPopup(p) {
    const cross = crossLabel(p);
    let html = `<div class="popup-title">${esc(p.name || "Unnamed street")}</div>`;
    if (cross) html += `<div class="popup-cross">${cross}</div>`;
    html += row("Street trees", num(p.n));
    html += row("Trees per 100 m", num(p.per100, 2));
    html += row("Block length", `${num(p.len)} m`);
    if (p.aged) {
      html += `<div class="popup-sep">`
            + row("Median estimated age", `${num(p.med, 1)} yrs`)
            + row("Mean estimated age", `${num(p.mean, 1)} yrs`)
            + `</div>`;
      html += `<div class="popup-hist">` + histogram({
        bars: ageBars(p.hist),
        ghost: ageBars(meta.city_hist),
        marker: Math.min(1, p.med / AGE_SPAN),
        axis: ["0", "70", "140+ years"],
        height: 40,
        key: `<span><i class="bar"></i>This block</span>`
           + `<span><i class="ghost"></i>City, rescaled</span>`
           + `<span><i class="rule"></i>Median</span>`,
      }) + `</div>`;
      if (p.aged !== p.n) {
        html += `<p class="an-chart-note">${num(p.aged)} of ${num(p.n)} trees here have `
              + `an estimated age.</p>`;
      }
    } else if (p.n === 0) {
      html += `<p class="an-chart-note popup-sep">No inventoried street trees on this `
            + `block. That can mean a street without them, or one whose trees stand on `
            + `private land and so never enter the City's inventory.</p>`;
    } else {
      html += `<p class="an-chart-note popup-sep">None of these trees has a recorded `
            + `diameter, so there is no age to estimate.</p>`;
    }
    return html;
  }

  function tipText(p) {
    const v = p[CONF.metric];
    const cross = CONF.source === "streets" ? crossLabel(p) : "";
    return `<strong>${esc(featureName(p))}</strong>`
         + (cross ? `<br><span class="tip-cross">${cross}</span>` : "")
         + `<br>${esc(CONF.tipLabel)}: `
         + (v == null ? "no figure" : `${num(v, CONF.decimals)} ${esc(CONF.unitShort)}`);
  }

  /* ------------------------------------------------------------ map -------------- */

  function segWeight() {
    const z = map.getZoom();
    if (z <= 11) return 1.5;
    if (z <= 13) return 2.2;
    if (z <= 15) return 3.2;
    return 4.5;
  }

  function styleFor(feature) {
    const v = feature.properties[CONF.metric];
    const colour = colourOf(v);
    if (CONF.source === "streets") {
      return { color: colour, weight: segWeight(), opacity: v == null ? 0.4 : 0.92,
               fill: false, lineCap: "round" };
    }
    return { color: cssVar("--gridline"), weight: 0.4, opacity: 0.45,
             fillColor: colour, fillOpacity: v == null ? 0.3 : 0.72 };
  }

  function highlight(target) {
    if (CONF.source === "streets") {
      target.setStyle({ weight: segWeight() + 2.5, opacity: 1 });
    } else {
      target.setStyle({ color: cssVar("--text-primary"), weight: 1.6, opacity: 0.9 });
    }
    target.bringToFront();
  }

  function buildLayer() {
    const tip = el("tip");
    layer = L.geoJSON({ type: "FeatureCollection", features }, {
      renderer: L.canvas({ padding: 0.3 }),
      style: styleFor,
      onEachFeature: (feature, target) => {
        target.on("mouseover", () => {
          if (target !== selected) highlight(target);
          tip.innerHTML = tipText(feature.properties);
          tip.hidden = false;
        });
        target.on("mousemove", (e) => {
          const pt = e.containerPoint;
          // Offset so the cursor never sits under its own readout, and flipped near
          // the right edge so the tip stays inside the pane.
          const flip = pt.x > el("map").clientWidth - 260;
          tip.style.left = `${pt.x + (flip ? -14 - tip.offsetWidth : 14)}px`;
          tip.style.top = `${pt.y + 14}px`;
        });
        target.on("mouseout", () => {
          if (target !== selected) layer.resetStyle(target);
          tip.hidden = true;
        });
        target.on("click", () => {
          if (selected && selected !== target) layer.resetStyle(selected);
          selected = target;
          highlight(target);
          target.bindPopup(
            CONF.source === "streets" ? streetPopup(feature.properties)
                                      : blockPopup(feature.properties),
            { maxWidth: 300, autoPanPadding: [20, 20] }
          ).openPopup();
        });
      },
    }).addTo(map);

    if (CONF.source === "streets") {
      map.on("zoomend", () => {
        layer.setStyle(styleFor);
        if (selected) highlight(selected);
      });
    }
  }

  /* ------------------------------------------------------------ hash ------------- */

  function writeHash() {
    const c = map.getCenter();
    const hash = `#${map.getZoom()}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`;
    history.replaceState(null, "", location.pathname + hash);
  }

  function readHash() {
    const m = /^#(\d+)\/(-?\d+\.?\d*)\/(-?\d+\.?\d*)$/.exec(location.hash);
    if (!m) return null;
    return { zoom: +m[1], center: [+m[2], +m[3]] };
  }

  /* ------------------------------------------------------------ boot ------------- */

  function showError(message) {
    const box = document.createElement("div");
    box.className = "load-error";
    box.textContent = message;
    el("map-pane").appendChild(box);
  }

  async function loadJSON(path) {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }

  async function main() {
    const badge = el("loading-badge");
    const view = readHash();

    baseLayer = Basemap.layer({
      dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      credit: CONF.credit,
    });
    map = L.map("map", {
      center: (view && view.center) || CENTER,
      zoom: (view && view.zoom) || ZOOM,
      minZoom: 10,
      maxZoom: Basemap.MAX_ZOOM,
      layers: [baseLayer],
      preferCanvas: true,
      worldCopyJump: false,
    });
    L.control.scale({ imperial: false }).addTo(map);

    SheetPanel.setup({ onResize: () => map.invalidateSize() });

    if (window.MapSearch) {
      let pin = null;
      MapSearch.mount({
        container: "#search",
        placeholder: "Search an address",
        onSelect: (r) => {
          if (pin) map.removeLayer(pin);
          pin = L.circleMarker([r.lat, r.lon], {
            radius: 8, color: "#d1495b", weight: 3, fillColor: "#d1495b", fillOpacity: 0.25,
          }).addTo(map);
          map.setView([r.lat, r.lon], Math.max(map.getZoom(), 15));
        },
        onClear: () => { if (pin) { map.removeLayer(pin); pin = null; } },
      });
    }

    try {
      const [payload, metaJSON] = await Promise.all([
        loadJSON(DATA + CONF.source + ".geojson"),
        loadJSON(DATA + "analysis.meta.json"),
      ]);
      features = payload.features;
      summary = payload.summary;
      meta = metaJSON;
    } catch (err) {
      badge.hidden = true;
      showError("Couldn't load the analysis data. If you're running this locally, the "
        + "site needs the pipeline to have been run first (see the README).");
      return;
    }

    buildClasses();
    renderStats();
    renderLegend();
    renderPanelChart();
    renderProvenance();
    buildLayer();
    badge.hidden = true;

    const asOf = el("as-of");
    if (asOf) asOf.textContent = `Tree inventory as of ${meta.as_of}`;

    map.on("moveend zoomend", writeHash);

    // Follow the OS theme: the ramp lives in CSS, so re-read it and restyle.
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    if (dark.addEventListener) {
      dark.addEventListener("change", () => {
        map.removeLayer(baseLayer);
        baseLayer = Basemap.layer({ dark: dark.matches, credit: CONF.credit });
        baseLayer.addTo(map);
        baseLayer.bringToBack();
        buildClasses();
        renderLegend();
        renderPanelChart();
        layer.setStyle(styleFor);
        if (selected) highlight(selected);
      });
    }
  }

  main();
})();
