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

  /* Density spans four and a half decades, so the x axis is logarithmic -- on a linear
   * one the median area sits at 0.6% of the width and the whole city is a smear against
   * the left edge. The domain stops at three clean decades: one area is sparser than 1
   * person per hectare and four are denser than 1,000, and those five are pinned to the
   * edges rather than given two more decades of empty chart. */
  const X_MIN = 1, X_MAX = 1000;
  const Y_MAX = 45;            // 99.8th percentile; a handful of denser blocks pin to the top
  const PAD = { t: 18, r: 18, b: 44, l: 54 };

  let points = [];
  let munis = [];
  let isolated = -1;           // municipality index, or -1 for all
  let hoverX = null;           // pointer position in canvas CSS px
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
  const LX0 = Math.log10(X_MIN), LX1 = Math.log10(X_MAX);

  function plot() {
    return { w: W - PAD.l - PAD.r, h: H - PAD.t - PAD.b };
  }
  function sx(x) {
    const p = plot();
    return PAD.l + ((Math.log10(clampX(x)) - LX0) / (LX1 - LX0)) * p.w;
  }
  function sy(y) {
    const p = plot();
    return PAD.t + p.h - (Math.min(Y_MAX, Math.max(0, y)) / Y_MAX) * p.h;
  }
  function xAt(px) {
    const p = plot();
    return Math.pow(10, LX0 + ((px - PAD.l) / p.w) * (LX1 - LX0));
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
  const BINS = 21;
  const MIN_BIN = 12;          // below this a bin's average is noise, so the line breaks

  function binIndex(x) {
    return Math.min(BINS - 1, Math.max(0,
      Math.floor(((Math.log10(clampX(x)) - LX0) / (LX1 - LX0)) * BINS)));
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
      const w = (LX1 - LX0) / BINS;
      bins.push({
        b,
        x0: Math.pow(10, LX0 + b * w),
        x1: Math.pow(10, LX0 + (b + 1) * w),
        mid: Math.pow(10, LX0 + (b + 0.5) * w),
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
    const lx = Math.log10(clampX(x));
    if (lx <= Math.log10(usable[0].mid)) return usable[0].mean;
    const last = usable[usable.length - 1];
    if (lx >= Math.log10(last.mid)) return last.mean;
    for (let i = 0; i < usable.length - 1; i++) {
      const a = usable[i], c = usable[i + 1];
      // Adjacent in the list but not on the chart: the line is broken across the gap.
      if (c.b !== a.b + 1) continue;
      const la = Math.log10(a.mid), lc = Math.log10(c.mid);
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
    for (const t of [1, 3, 10, 30, 100, 300, 1000]) {
      const px = Math.round(sx(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, PAD.t);
      ctx.lineTo(px, PAD.t + p.h);
      ctx.stroke();
      ctx.fillText(String(t), px, PAD.t + p.h + 8);
    }

    ctx.fillStyle = cssVar("--text-secondary");
    ctx.fillText("Residents per hectare (log scale)", PAD.l + p.w / 2, H - 16);
    ctx.save();
    ctx.translate(13, PAD.t + p.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("Street trees per 100 m", 0, 0);
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
    const hoverY = hoverX == null ? null : curveAt(bins, xAt(hoverX));
    if (hoverX != null && hoverY != null) {
      const x = xAt(hoverX);
      const px = Math.round(sx(x)) + 0.5;
      const py = Math.round(sy(hoverY)) + 0.5;
      ctx.strokeStyle = cssVar("--text-secondary");
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, PAD.t); ctx.lineTo(px, PAD.t + p.h);
      ctx.moveTo(PAD.l, py); ctx.lineTo(PAD.l + p.w, py);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar("--surface-1");
      ctx.strokeStyle = cssVar("--text-primary");
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    renderReadout(bins, hoverY);
  }

  /* ---------------------------------------------------------------- readout ------- */

  function renderReadout(bins, hoverY) {
    if (hoverX == null || hoverY == null) { tip.hidden = true; return; }
    const x = xAt(hoverX);
    const bin = bins[binIndex(x)];
    const scope = isolated < 0 ? "across the city" : `in ${pretty(munis[isolated])}`;
    const range = `${num(bin.x0, bin.x0 < 10 ? 1 : 0)}\u2013${num(bin.x1, bin.x1 < 10 ? 1 : 0)}`;
    tip.innerHTML =
      `<div class="tip-head">${num(x, x < 10 ? 1 : 0)} residents per hectare</div>`
      + `<div class="popup-row"><span class="k">Average here</span>`
      + `<span class="v">${num(hoverY, 1)} per 100 m</span></div>`
      + `<div class="popup-row"><span class="k">Areas in this bin</span>`
      + `<span class="v">${num(bin.n)}</span></div>`
      + `<div class="tip-note">bin covers ${range} residents per hectare, ${scope}</div>`;
    tip.hidden = false;
    const left = Math.min(W - tip.offsetWidth - 8, Math.max(8, sx(x) + 14));
    tip.style.left = `${left}px`;
    tip.style.top = `${PAD.t + 8}px`;
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
        <td>${num(r.n)}</td><td>${num(r.d, 0)}</td><td>${num(r.t, 1)}</td>
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
    const peak = bins.length ? bins.reduce((a, b) => (b.mean > a.mean ? b : a)) : null;
    const densest = bins.length ? bins[bins.length - 1] : null;
    const stats = [
      [num(rows.length), "Census areas"],
      [num(median(rows.map((r) => r.y)), 1), "Median trees per 100 m"],
      [peak ? num(peak.mean, 1) : "–",
       peak ? `Peak average, near ${num(peak.mid, peak.mid < 10 ? 1 : 0)}/ha` : "Peak average"],
      [densest ? num(densest.mean, 1) : "–",
       densest ? `Densest bin, ${num(densest.x0)}+/ha` : "Densest bin"],
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
    points = payload.points;
    munis = payload.municipalities;

    canvas = el("chart");
    ctx = canvas.getContext("2d");
    tip = el("tip");

    canvas.addEventListener("mousemove", (e) => {
      const b = canvas.getBoundingClientRect();
      const x = e.clientX - b.left;
      hoverX = x >= PAD.l && x <= W - PAD.r ? x : null;
      draw();
    });
    canvas.addEventListener("mouseleave", () => { hoverX = null; draw(); });
    // Touch: a tap parks the crosshair where it landed rather than needing a hover.
    canvas.addEventListener("touchmove", (e) => {
      const b = canvas.getBoundingClientRect();
      const x = e.touches[0].clientX - b.left;
      hoverX = x >= PAD.l && x <= W - PAD.r ? x : null;
      draw();
    }, { passive: true });

    window.addEventListener("resize", resize);
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    if (dark.addEventListener) dark.addEventListener("change", () => { renderLegend(); renderTable(); draw(); });

    if (window.SheetPanel) SheetPanel.setup({ onResize: resize });
    const facts = {
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
