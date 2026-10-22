/* Population density against street-tree planting, one point per census area.
 *
 * The area is the unit because it is the only one that can carry both axes: the census
 * publishes population at this level and nowhere finer that is usable, so asking the
 * question of a street block would mean giving every block in an area the same density
 * and plotting 39,000 points in 3,565 vertical stripes.
 *
 * Canvas rather than SVG, like the tree map: 3,565 points is past the size where a DOM
 * node each is sensible, and hit-testing a scatter is a linear scan either way.
 */
(function () {
  "use strict";

  const DATA = "../data/analysis/scatter.json";

  /* Both scatter pages are this file with a different x axis, declared by the page
   * before it loads. See density.html for the shape. */
  const CONF = window.SCATTER;
  const X_MIN = CONF.xMin, X_MAX = CONF.xMax;
  const LOG = CONF.xScale === "log";
  const Y_MAX = CONF.yMax;
  const PAD = { t: 18, r: 18, b: 44, l: 54 };

  let points = [];
  let munis = [];
  let isolated = -1;           // municipality index, or -1 for all
  let hoverX = null;           // pointer position in canvas CSS px
  let hoverPt = null;          // the block under the cursor, if any
  let canvas, ctx, tip, dpr = 1, W = 0, H = 0;

  const el = (id) => document.getElementById(id);
  const cssVar = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const nf = (d) => new Intl.NumberFormat("en-CA",
    { minimumFractionDigits: d, maximumFractionDigits: d });
  const num = (v, d = 0) => (v == null ? "–" : nf(d).format(v));

  /* Title case for display: the boundary file shouts its names. */
  const pretty = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

  const clampX = (x) => Math.min(X_MAX, Math.max(X_MIN, x));
  const LX0 = LOG ? Math.log10(X_MIN) : X_MIN;
  const LX1 = LOG ? Math.log10(X_MAX) : X_MAX;

  /* Position on the axis as a fraction of its width, and back again. Everything that
   * measures along x -- the scales, the bins, the crosshair -- goes through these, so
   * a log axis and a linear one are the same code with a different pair. */
  const tx = (x) => ((LOG ? Math.log10(clampX(x)) : clampX(x)) - LX0) / (LX1 - LX0);
  const itx = (u) => {
    const v = LX0 + u * (LX1 - LX0);
    return LOG ? Math.pow(10, v) : v;
  };

  function plot() {
    return { w: W - PAD.l - PAD.r, h: H - PAD.t - PAD.b };
  }
  function sx(x) {
    const p = plot();
    return PAD.l + tx(x) * p.w;
  }
  function sy(y) {
    const p = plot();
    return PAD.t + p.h - (Math.min(Y_MAX, Math.max(0, y)) / Y_MAX) * p.h;
  }
  function xAt(px) {
    const p = plot();
    return itx((px - PAD.l) / p.w);
  }

  /* ---------------------------------------------------------------- statistics ---- */

  /* The line on the chart is the average of each x-axis bin, not a straight fit.
   *
   * A least-squares line through this cloud is flat and explains about 1% of the
   * variance, which is true but tells you only that no straight line describes it. The
   * binned average shows what is actually there: a rise to about 15 trees per 100 m
   * around 20 residents a hectare, a long flat middle, then a steady fall above roughly
   * 200. None of that survives being summarised as one slope.
   *
   * Bins are equal width in log space because the axis is logarithmic, so each covers
   * the same distance on screen. */
  const BINS = CONF.bins;
  const MIN_BIN = CONF.minBin;  // below this a bin's average is noise, so the line breaks

  function binIndex(x) {
    return Math.min(BINS - 1, Math.max(0, Math.floor(tx(x) * BINS)));
  }

  function curveOf(rows) {
    const sums = new Array(BINS).fill(0);
    const counts = new Array(BINS).fill(0);
    for (const r of rows) {
      const b = binIndex(r.x);
      sums[b] += r.y;
      counts[b] += 1;
    }
    const bins = [];
    for (let b = 0; b < BINS; b++) {
      bins.push({
        b,
        x0: itx(b / BINS),
        x1: itx((b + 1) / BINS),
        mid: itx((b + 0.5) / BINS),
        n: counts[b],
        mean: counts[b] ? sums[b] / counts[b] : null,
        enough: counts[b] >= MIN_BIN,
      });
    }
    return bins;
  }

  /* The drawn curve's own value at any density: linear between the two bin centres it
   * falls between, so the crosshair always lands exactly on the line rather than near
   * it. Null wherever the line is broken for want of data. */
  function curveAt(bins, x) {
    const usable = bins.filter((b) => b.enough);
    if (!usable.length) return null;
    const lx = tx(x);
    if (lx <= tx(usable[0].mid)) return usable[0].mean;
    const last = usable[usable.length - 1];
    if (lx >= tx(last.mid)) return last.mean;
    for (let i = 0; i < usable.length - 1; i++) {
      const a = usable[i], c = usable[i + 1];
      // Adjacent in the list but not on the chart: the line is broken across the gap.
      if (c.b !== a.b + 1) continue;
      const la = tx(a.mid), lc = tx(c.mid);
      if (lx >= la && lx <= lc) return a.mean + ((lx - la) / (lc - la)) * (c.mean - a.mean);
    }
    return null;
  }

  function median(values) {
    if (!values.length) return null;
    const v = values.slice().sort((a, b) => a - b);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  /* Mean planting among a municipality's densest tenth of areas -- the part of the
   * curve that actually moves. */
  function densestTenth(rows) {
    if (rows.length < 10) return null;
    const sorted = rows.slice().sort((a, b) => a.x - b.x);
    const tail = sorted.slice(Math.floor(sorted.length * 0.9));
    let sum = 0;
    for (const r of tail) sum += r.y;
    return sum / tail.length;
  }

  const active = () => (isolated < 0 ? points : points.filter((p) => p.m === isolated));

  /* Nearest block to the cursor, in screen space so the hit radius is the same
   * everywhere regardless of how the axes are scaled. Linear scan: 3,500 points is
   * nothing next to the work of drawing them. */
  const HIT_RADIUS = 14;
  function nearest(px, py) {
    const rows = active();
    let best = null, bestD = HIT_RADIUS * HIT_RADIUS;
    for (const p of rows) {
      const dx = sx(p.x) - px, dy = sy(p.y) - py;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  function mapsUrl(p) {
    return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
  }

  /* ---------------------------------------------------------------- drawing ------- */

  function colourFor(i) { return cssVar(`--muni-${i + 1}`); }

  function resize() {
    const box = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(320, box.width);
    H = Math.max(260, box.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    draw();
  }

  function draw() {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const p = plot();
    const grid = cssVar("--gridline");
    const muted = cssVar("--text-muted");
    const rows = active();

    // ---- grid and axes
    ctx.strokeStyle = grid;
    ctx.fillStyle = muted;
    ctx.lineWidth = 1;
    ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let y = 0; y <= Y_MAX; y += 10) {
      const py = Math.round(sy(y)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, py);
      ctx.lineTo(PAD.l + p.w, py);
      ctx.stroke();
      ctx.fillText(String(y), PAD.l - 8, py);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const t of CONF.ticks) {
      const px = Math.round(sx(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, PAD.t);
      ctx.lineTo(px, PAD.t + p.h);
      ctx.stroke();
      ctx.fillText(String(t), px, PAD.t + p.h + 8);
    }

    ctx.fillStyle = cssVar("--text-secondary");
    ctx.fillText(CONF.xLabel, PAD.l + p.w / 2, H - 16);
    ctx.save();
    ctx.translate(13, PAD.t + p.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(CONF.yLabel, 0, 0);
    ctx.restore();

    // ---- points. Greyed rather than dropped when a municipality is isolated, so the
    // one in focus is read against the city instead of floating on an empty chart.
    if (isolated >= 0) {
      ctx.fillStyle = cssVar("--series-other");
      for (const pt of points) {
        if (pt.m === isolated) continue;
        ctx.beginPath();
        ctx.arc(sx(pt.x), sy(pt.y), 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = isolated >= 0 ? 1 : 0.72;
    for (let m = 0; m < munis.length; m++) {
      if (isolated >= 0 && m !== isolated) continue;
      ctx.fillStyle = colourFor(m);
      ctx.beginPath();
      for (const pt of points) {
        if (pt.m !== m) continue;
        const cx = sx(pt.x), cy = sy(pt.y);
        ctx.moveTo(cx + 2.2, cy);
        ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* Laid down twice, once in the surface colour and wider. Over three and a half
     * thousand points a 2 px line is just another speck in the cloud; the casing cuts it
     * out of the scatter the way the dot halos do on the tree map. */
    const bins = curveOf(rows);
    const path = () => {
      let open = false;
      for (const b of bins) {
        if (!b.enough) { open = false; continue; }
        const px = sx(b.mid), py = sy(b.mean);
        if (open) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        open = true;
      }
    };
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass ? cssVar("--text-primary") : cssVar("--surface-1");
      ctx.lineWidth = pass ? 2.5 : 5.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      path();
      ctx.stroke();
    }
    // A mark at each bin's own average, so the reader can see where the line is
    // anchored rather than taking the shape on trust.
    for (const b of bins) {
      if (!b.enough) continue;
      ctx.fillStyle = cssVar("--text-primary");
      ctx.strokeStyle = cssVar("--surface-1");
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx(b.mid), sy(b.mean), 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
    }

    // ---- crosshair, locked to the trendline rather than to the pointer's own y
    if (hoverPt) {
      const px = sx(hoverPt.x), py = sy(hoverPt.y);
      ctx.strokeStyle = cssVar("--surface-1");
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = cssVar("--text-primary");
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.stroke();
    }

    renderReadout();
  }

  /* ---------------------------------------------------------------- readout ------- */

  function renderReadout() {
    if (!hoverPt) { tip.hidden = true; return; }
    const p = hoverPt;
    const row = (k, v) => `<div class="popup-row"><span class="k">${esc(k)}</span>`
                        + `<span class="v">${v}</span></div>`;
    tip.innerHTML =
      `<div class="tip-head">${esc(p.ward || "Block " + p.id)}</div>`
      + `<div class="popup-cross">${esc(pretty(munis[p.m]))} &middot; `
      + `${num(p.ha, 1)} ha &middot; ${num(p.pop)} residents</div>`
      + row(CONF.xUnit, num(p.x, CONF.xDecimals))
      + row(`${CONF.yShort}`, `${num(p.y, 1)}${CONF.ySuffix}`)
      + row("Street trees", num(p.n))
      + `<div class="tip-note">click to open in Google Maps</div>`;
    tip.hidden = false;
    const px = sx(p.x), py = sy(p.y);
    tip.style.left = `${Math.min(W - tip.offsetWidth - 8, Math.max(8, px + 16))}px`;
    tip.style.top = `${Math.min(H - tip.offsetHeight - 8, Math.max(8, py - 12))}px`;
  }

  /* ---------------------------------------------------------------- panel --------- */

  function renderLegend() {
    const host = el("legend");
    host.innerHTML = munis.map((m, i) => {
      const n = points.filter((p) => p.m === i).length;
      const on = isolated < 0 || isolated === i;
      return `<button type="button" class="muni-chip" data-m="${i}" data-active="${on}">`
        + `<span class="swatch" style="background:${colourFor(i)}"></span>`
        + `<span class="muni-name">${esc(pretty(m))}</span>`
        + `<span class="muni-count">${num(n)}</span></button>`;
    }).join("");
    for (const b of host.querySelectorAll(".muni-chip")) {
      b.addEventListener("click", () => {
        const i = +b.dataset.m;
        isolated = isolated === i ? -1 : i;
        renderLegend();
        renderTable();
        renderHeadline();
        draw();
      });
    }
  }

  function renderTable() {
    const body = el("muni-table").querySelector("tbody");
    const rows = munis.map((m, i) => {
      const sub = points.filter((p) => p.m === i);
      return { i, m, n: sub.length,
               d: median(sub.map((p) => p.x)),
               t: median(sub.map((p) => p.y)),
               tenth: densestTenth(sub) };
    }).sort((a, b) => b.n - a.n);
    body.innerHTML = rows.map((r) => `
      <tr data-m="${r.i}" data-active="${isolated < 0 || isolated === r.i}">
        <th scope="row"><span class="swatch" style="background:${colourFor(r.i)}"></span>${esc(pretty(r.m))}</th>
        <td>${num(r.n)}</td><td>${num(r.d, CONF.xDecimals)}</td><td>${num(r.t, 1)}</td>
        <td>${r.tenth == null ? "–" : num(r.tenth, 1)}</td>
      </tr>`).join("");
    for (const tr of body.querySelectorAll("tr")) {
      tr.addEventListener("click", () => {
        const i = +tr.dataset.m;
        isolated = isolated === i ? -1 : i;
        renderLegend();
        renderTable();
        renderHeadline();
        draw();
      });
    }
  }

  function renderHeadline() {
    const rows = active();
    const bins = curveOf(rows).filter((b) => b.enough);
    const last = bins.length ? bins[bins.length - 1] : null;
    const highest = bins.length ? bins.reduce((a, b) => (b.mean > a.mean ? b : a)) : null;
    /* The middle tile is the curve's peak, unless the peak is the end of the line and
     * would just restate the tile beside it -- then the opening bin is the useful
     * comparison, since what the reader wants is both ends of the curve. */
    const peak = highest && last && highest.b === last.b ? bins[0] : highest;
    const peakIsStart = peak && bins.length && peak.b === bins[0].b;
    const stats = [
      [num(rows.length), "Census areas"],
      [num(median(rows.map((r) => r.y)), 1) + CONF.ySuffix, `Median ${CONF.yShort}`],
      [peak ? num(peak.mean, 1) + CONF.ySuffix : "–",
       !peak ? "Peak average"
             : peakIsStart
               ? `First bin, under ${num(peak.x1, CONF.xDecimals)} ${CONF.xShort}`
               : `Peak average, near ${num(peak.mid, CONF.xDecimals)} ${CONF.xShort}`],
      [last ? num(last.mean, 1) + CONF.ySuffix : "–",
       last ? `Top bin, ${num(last.x0, CONF.xDecimals)}+ ${CONF.xShort}` : "Top bin"],
    ];
    el("stats").innerHTML = stats.map(([v, l]) =>
      `<div class="stat-tile"><div class="stat-value">${v}</div>`
      + `<div class="stat-label">${esc(l)}</div></div>`).join("");
  }

  /* ---------------------------------------------------------------- boot ---------- */

  async function main() {
    let payload;
    try {
      const r = await fetch(DATA, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      payload = await r.json();
    } catch (err) {
      el("loading-badge").hidden = true;
      const box = document.createElement("div");
      box.className = "load-error";
      box.textContent = "Couldn't load the figures. If you're running this locally, the "
        + "site needs the pipeline to have been run first (see the README).";
      el("chart-pane").appendChild(box);
      return;
    }
    points = payload.points
      .map((p) => Object.assign({}, p, { x: p[CONF.xKey], y: p[CONF.yKey] }))
      .filter((p) => p.x != null && p.y != null);
    munis = payload.municipalities;

    canvas = el("chart");
    ctx = canvas.getContext("2d");
    tip = el("tip");

    const track = (clientX, clientY) => {
      const b = canvas.getBoundingClientRect();
      const px = clientX - b.left, py = clientY - b.top;
      hoverX = px >= PAD.l && px <= W - PAD.r ? px : null;
      hoverPt = hoverX == null ? null : nearest(px, py);
      canvas.style.cursor = hoverPt ? "pointer" : "default";
      draw();
    };
    canvas.addEventListener("mousemove", (e) => track(e.clientX, e.clientY));
    canvas.addEventListener("mouseleave", () => { hoverX = null; hoverPt = null; draw(); });
    canvas.addEventListener("click", () => {
      if (hoverPt) window.open(mapsUrl(hoverPt), "_blank", "noopener");
    });
    // Touch: a tap selects the nearest block and shows its readout.
    canvas.addEventListener("touchmove", (e) => {
      track(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    window.addEventListener("resize", resize);
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    if (dark.addEventListener) dark.addEventListener("change", () => { renderLegend(); renderTable(); draw(); });

    if (window.SheetPanel) SheetPanel.setup({ onResize: resize });
    const park = payload.parking || {};
    const facts = {
      permits: () => num(park.permits),
      spaces: () => num(park.spaces),
      placedPct: () => `${num((park.placed / park.spaces) * 100, 1)}%`,
      frontYard: () => num(park.by_type && park.by_type["Front Yard"]),
      widened: () => num(park.by_type && park.by_type["Widened Driveway"]),
      boulevard: () => num(park.by_type && park.by_type["Boulevard Parking"]),
      noneAreas: () => num(park.areas_with_none),
      // The three former municipalities whose bylaws created the permit in the first
      // place, as a share of every licensed space placed on the map.
      oldCityShare: () => {
        const old = new Set(["TORONTO", "YORK", "EAST YORK"]);
        let a = 0, b = 0;
        for (const q of points) {
          b += q.spaces || 0;
          if (old.has(munis[q.m])) a += q.spaces || 0;
        }
        return b ? `${num((a / b) * 100, 0)}%` : "–";
      },
      nonePct: () => `${num((park.areas_with_none / points.length) * 100, 0)}%`,
      overY: () => num(points.filter((q) => q.y > Y_MAX).length),
      yMax: () => num(Y_MAX),
      overX: () => num(points.filter((q) => q.x > X_MAX).length),
      underX: () => num(points.filter((q) => q.x < X_MIN).length),
      areas: () => num(points.length),
    };
    for (const node of document.querySelectorAll("[data-fact]")) {
      const fn = facts[node.dataset.fact];
      if (fn) node.textContent = fn();
    }

    renderLegend();
    renderTable();
    renderHeadline();
    resize();
    el("loading-badge").hidden = true;
  }

  main();
})();
