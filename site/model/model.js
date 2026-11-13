/* Toronto trees from the air: 1.4M predicted trees over the City's 2025 orthophoto.
 *
 * Payload (ml/export_map.py): coords.u32 (planar lon/lat offsets), attrs.u8 (planar
 * columns named in meta.cols), inv.u16 (index+1 into meta.inv_taxa, 0 = no inventory
 * tree matched within 3 m).
 *
 * One canvas over the map, redrawn on moveend. Below z16 points go straight into an
 * ImageData buffer (1-2 device px squares); from z16 they are circles with a white ring so
 * the hues hold up over green canopy. A uniform grid over the points does both viewport
 * culling and click/hover hit-testing.
 */
(function () {
  "use strict";

  const DATA = "data/";
  const ORTHO = "https://gis.toronto.ca/arcgis/rest/services/basemap/cot_ortho_2025_color_8cm/MapServer/tile/{z}/{y}/{x}";
  const GEN_VARS = ["--gen-1", "--gen-2", "--gen-3", "--gen-4", "--gen-5", "--gen-6", "--gen-7", "--gen-8"];
  const GRID = 512;
  const CIRCLE_ZOOM = 16;
  const LEAF_OFF = (lat, lon) => lat > 43.72 && lon < -79.45;

  let map, canvas, ctx, meta, n;
  let nx, ny, col, inv, invGenus;
  let cellStart, cellOrder, gx0, gy0, gdx, gdy;
  const colourIdx = { arr: null };   // 0 = other/dim, 1..8 = hue slots
  const state = { focus: "", minConf: 0 };
  let genusSlot = [];                // genus index -> slot 0..8
  let css = [], packed = null, dimSlot = 0;

  /* ------------------------------------------------------------- loading ----------- */

  async function loadColumn(file, Ctor) {
    const resp = await fetch(DATA + file);
    if (!resp.ok) throw new Error(file + ": " + resp.status);
    const stream = resp.body.pipeThrough(new DecompressionStream("gzip"));
    return new Ctor(await new Response(stream).arrayBuffer());
  }

  async function load() {
    meta = await (await fetch(DATA + "meta.json")).json();
    const [coords, attrs, invRaw] = await Promise.all([
      loadColumn("coords.u32.gz", Uint32Array),
      loadColumn("attrs.u8.gz", Uint8Array),
      loadColumn("inv.u16.gz", Uint16Array),
    ]);
    n = meta.n;
    col = {};
    meta.cols.forEach((c, k) => { col[c] = attrs.subarray(k * n, (k + 1) * n); });
    inv = invRaw;

    const { origin_lon, origin_lat, scale } = meta.coords;
    nx = new Float64Array(n); ny = new Float64Array(n);
    const RAD = Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const lo = origin_lon + coords[i] / scale, la = origin_lat + coords[n + i] / scale;
      nx[i] = (lo + 180) / 360;
      const s = Math.sin(la * RAD);
      ny[i] = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    }

    // inventory taxon -> model genus index, for the agreement stat and the popup
    const gIndex = new Map(meta.genera.map((g, i) => [g.name, i]));
    const other = gIndex.get("other");
    invGenus = meta.inv_taxa.map((t) => {
      const g = t.b.split(" ")[0];
      return gIndex.has(g) ? gIndex.get(g) : other;
    });

    buildGrid();
    // the eight most-predicted named genera get a hue; the rest share "other"
    const ranked = meta.genera.map((g, i) => [g.count, i]).filter(([, i]) => meta.genera[i].name !== "other")
      .sort((a, b) => b[0] - a[0]).slice(0, GEN_VARS.length).map(([, i]) => i);
    genusSlot = new Uint8Array(meta.genera.length);
    ranked.forEach((gi, k) => { genusSlot[gi] = k + 1; });
    colourIdx.arr = new Uint8Array(n);
  }

  function buildGrid() {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (let i = 0; i < n; i++) {
      if (nx[i] < a) a = nx[i]; if (nx[i] > b) b = nx[i];
      if (ny[i] < c) c = ny[i]; if (ny[i] > d) d = ny[i];
    }
    gx0 = a; gy0 = c; gdx = (b - a) / GRID * 1.000001; gdy = (d - c) / GRID * 1.000001;
    const cell = new Uint32Array(n), count = new Uint32Array(GRID * GRID + 1);
    for (let i = 0; i < n; i++) {
      const k = Math.floor((ny[i] - gy0) / gdy) * GRID + Math.floor((nx[i] - gx0) / gdx);
      cell[i] = k; count[k + 1]++;
    }
    for (let k = 1; k <= GRID * GRID; k++) count[k] += count[k - 1];
    cellStart = count.slice();
    cellOrder = new Uint32Array(n);
    const fill = count.slice(0, GRID * GRID);
    for (let i = 0; i < n; i++) cellOrder[fill[cell[i]]++] = i;
  }

  /* ------------------------------------------------------------- colour + filter --- */

  function cssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  function packColour(c) {
    const t = document.createElement("canvas").getContext("2d");
    t.fillStyle = c; t.fillRect(0, 0, 1, 1);
    const [r, g, b] = t.getImageData(0, 0, 1, 1).data;
    return (255 << 24) | (b << 16) | (g << 8) | r;   // little-endian RGBA
  }

  // Focus: "" = all genera; "g:<i>" = one genus; "s:<i>" = one species.
  function parseFocus() {
    if (!state.focus) return null;
    const [lvl, i] = state.focus.split(":");
    return { lvl, i: +i };
  }

  function recolour() {
    const f = parseFocus();
    const out = colourIdx.arr, g1 = col.g1, s1 = col.s1, g1p = col.g1p, s1p = col.s1p;
    const min = Math.round(state.minConf * 255);
    if (!f) {
      css = [cssVar("--gen-other"), ...GEN_VARS.map(cssVar)];
      for (let i = 0; i < n; i++) out[i] = g1p[i] < min ? 255 : genusSlot[g1[i]];
    } else {
      // matching trees in the focus colour, everything else a small dim dot
      css = [cssVar("--gen-other"), cssVar("--focus")];
      const isSp = f.lvl === "s";
      const sGenus = isSp ? genusOfSpecies(f.i) : -1;
      for (let i = 0; i < n; i++) {
        const hit = isSp ? (s1[i] === f.i && g1[i] === sGenus) : g1[i] === f.i;
        const p = isSp ? Math.min(s1p[i], g1p[i]) : g1p[i];
        out[i] = hit && p >= min ? 1 : (state.minConf > 0 && !hit ? 255 : 0);
      }
    }
    packed = Uint32Array.from(css, packColour);
    dimSlot = f ? 0 : -1;
  }

  function genusOfSpecies(si) {
    const g = meta.species[si].name.split(" ")[0];
    return meta.genera.findIndex((x) => x.name === g);
  }

  /* ------------------------------------------------------------- drawing ----------- */

  function cellRange(px0, py0, px1, py1, scale) {
    const cx0 = Math.max(0, Math.floor((px0 / scale - gx0) / gdx));
    const cx1 = Math.min(GRID - 1, Math.floor((px1 / scale - gx0) / gdx));
    const cy0 = Math.max(0, Math.floor((py0 / scale - gy0) / gdy));
    const cy1 = Math.min(GRID - 1, Math.floor((py1 / scale - gy0) / gdy));
    return [cx0, cx1, cy0, cy1];
  }

  function forEachIn(px0, py0, px1, py1, scale, fn) {
    const [cx0, cx1, cy0, cy1] = cellRange(px0, py0, px1, py1, scale);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cy * GRID + cx;
        for (let j = cellStart[k]; j < cellStart[k + 1]; j++) fn(cellOrder[j]);
      }
    }
  }

  function draw() {
    if (!colourIdx.arr) return;
    const size = map.getSize(), dpr = window.devicePixelRatio || 1;
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(canvas, topLeft);
    canvas.width = size.x * dpr; canvas.height = size.y * dpr;
    canvas.style.width = size.x + "px"; canvas.style.height = size.y + "px";
    canvas.style.opacity = 1;

    const z = map.getZoom(), scale = 256 * Math.pow(2, z);
    const o = map.getPixelBounds().min;
    const pad = 12;
    const ci = colourIdx.arr;

    if (z < CIRCLE_ZOOM) {
      const img = ctx.createImageData(canvas.width, canvas.height);
      const buf = new Uint32Array(img.data.buffer);
      const W = canvas.width, H = canvas.height;
      const s = Math.max(1, Math.round((z >= 14 ? 2 : 1) * dpr));
      // two passes so coloured dots sit on top of the grey ones
      for (const pass of [0, 1]) {
        forEachIn(o.x, o.y, o.x + size.x, o.y + size.y, scale, (i) => {
          const c = ci[i];
          if (c === 255 || (c === 0) !== (pass === 0)) return;
          const x = Math.round((nx[i] * scale - o.x) * dpr), y = Math.round((ny[i] * scale - o.y) * dpr);
          for (let dy = 0; dy < s; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= H) continue;
            for (let dx = 0; dx < s; dx++) {
              const xx = x + dx; if (xx >= 0 && xx < W) buf[yy * W + xx] = packed[c];
            }
          }
        });
      }
      ctx.putImageData(img, 0, 0);
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = z >= 19 ? 7 : z >= 18 ? 5.5 : z >= 17 ? 4.5 : 3.5;
    const paths = css.map(() => new Path2D());
    const dim = new Path2D();
    forEachIn(o.x - pad, o.y - pad, o.x + size.x + pad, o.y + size.y + pad, scale, (i) => {
      const c = ci[i];
      if (c === 255) return;
      const x = nx[i] * scale - o.x, y = ny[i] * scale - o.y;
      if (c === dimSlot) { dim.moveTo(x + r * 0.5, y); dim.arc(x, y, r * 0.5, 0, 2 * Math.PI); return; }
      paths[c].moveTo(x + r, y); paths[c].arc(x, y, r, 0, 2 * Math.PI);
    });
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.globalAlpha = 0.8; ctx.fillStyle = css[0]; ctx.fill(dim); ctx.globalAlpha = 1;
    paths.forEach((p, c) => { ctx.fillStyle = css[c]; ctx.stroke(p); ctx.fill(p); });
  }

  /* ------------------------------------------------------------- hit test ---------- */

  function nearest(latlng, maxPx) {
    const z = map.getZoom(), scale = 256 * Math.pow(2, z);
    const p = map.project(latlng, z);
    let best = -1, bd = maxPx * maxPx;
    forEachIn(p.x - maxPx, p.y - maxPx, p.x + maxPx, p.y + maxPx, scale, (i) => {
      if (colourIdx.arr[i] === 255) return;
      const dx = nx[i] * scale - p.x, dy = ny[i] * scale - p.y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  const pct = (b) => Math.round(b / 255 * 100) + "%";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function genusLabel(gi) {
    const g = meta.genera[gi];
    return g.name === "other" ? "Another genus" : g.common;
  }

  function confBar(b) {
    return `<span class="conf-bar" aria-hidden="true"><i style="width:${Math.round(b / 255 * 100)}%"></i></span>`;
  }

  function popupHtml(i) {
    const g1 = col.g1[i], g2 = col.g2[i], s1 = col.s1[i];
    const gName = meta.genera[g1].name;
    const sp = meta.species[s1];
    const spOk = sp.name.split(" ")[0] === gName;
    const latlng = map.unproject([nx[i] * 256, ny[i] * 256], 0);
    let h = `<div class="popup-title">${esc(genusLabel(g1))}</div>`;
    if (gName !== "other") h += `<div class="popup-sub">${esc(gName)}</div>`;
    h += `<div class="popup-row"><span class="k">Confidence</span><span class="v">${pct(col.g1p[i])}${confBar(col.g1p[i])}</span></div>`;
    if (spOk) h += `<div class="popup-row"><span class="k">Species guess</span><span class="v">${esc(sp.common || sp.name)} ${pct(col.s1p[i])}</span></div>`;
    h += `<div class="popup-row"><span class="k">Runner-up</span><span class="v">${esc(genusLabel(g2))} ${pct(col.g2p[i])}</span></div>`;
    if (col.dbh[i]) h += `<div class="popup-row"><span class="k">Trunk, estimated</span><span class="v">~${col.dbh[i]} cm</span></div>`;

    h += `<div class="popup-section"><div class="popup-label">City street tree inventory</div>`;
    if (inv[i]) {
      const t = meta.inv_taxa[inv[i] - 1];
      const agree = invGenus[inv[i] - 1] === g1;
      h += `<div class="popup-row"><span class="k">Recorded as</span><span class="v">${esc(t.c || t.b)}</span></div>`;
      if (col.invdbh[i]) h += `<div class="popup-row"><span class="k">Trunk, measured</span><span class="v">${col.invdbh[i]} cm</span></div>`;
      h += `<div class="popup-note">${agree ? "The model agrees on the genus." : "The model disagrees on the genus."}</div>`;
    } else {
      h += `<div class="popup-note">No street tree recorded here. Most trees without one are on private land or in parks.</div>`;
    }
    h += `</div>`;
    const notes = [];
    if (col.src[i]) notes.push("Location from the street tree inventory (no topographic tree point nearby).");
    if (LEAF_OFF(latlng.lat, latlng.lng)) notes.push("This part of the city was photographed before leaf-out, so guesses here are less reliable.");
    if (notes.length) h += `<div class="popup-section popup-note">${notes.map(esc).join("<br>")}</div>`;
    return h;
  }

  /* ------------------------------------------------------------- panel ------------- */

  function renderPanel() {
    const ci = colourIdx.arr, f = parseFocus();
    let shown = 0, matched = 0, agree = 0, sure = 0;
    const counts = new Uint32Array(meta.genera.length);
    for (let i = 0; i < n; i++) {
      if (ci[i] === 255) continue;
      shown++; counts[col.g1[i]]++;
      if (col.g1p[i] >= 153) sure++;
      if (inv[i]) { matched++; if (invGenus[inv[i] - 1] === col.g1[i]) agree++; }
    }
    const fmt = (x) => x.toLocaleString("en-CA");
    document.getElementById("stats").innerHTML =
      tile(fmt(shown), "trees shown") +
      tile(Math.round(sure / Math.max(1, shown) * 100) + "%", "guessed with ≥60% confidence") +
      tile(Math.round(agree / Math.max(1, matched) * 100) + "%", `agree with the City inventory (${fmt(matched)} trees)`);

    const legend = document.getElementById("legend");
    document.getElementById("legend-title").textContent = f ? "Showing" : "Predicted genus";
    let rows;
    if (f) {
      const label = f.lvl === "g" ? genusLabel(f.i) : (meta.species[f.i].common || meta.species[f.i].name);
      let hits = 0;
      for (let i = 0; i < n; i++) if (ci[i] === 1) hits++;
      rows = [row(cssVar("--focus"), label, f.lvl === "g" ? meta.genera[f.i].name : meta.species[f.i].name, hits, ""),
              row(cssVar("--gen-other"), "Everything else", "", shown - hits, "")];
    } else {
      const order = meta.genera.map((g, gi) => gi).filter((gi) => genusSlot[gi]).sort((a, b) => genusSlot[a] - genusSlot[b]);
      let rest = 0;
      for (let gi = 0; gi < meta.genera.length; gi++) if (!genusSlot[gi]) rest += counts[gi];
      rows = order.map((gi) => row(css[genusSlot[gi]], genusLabel(gi), meta.genera[gi].name, counts[gi], "g:" + gi));
      rows.push(row(css[0], "Other genera", "", rest, ""));
    }
    legend.innerHTML = rows.join("");
    legend.querySelectorAll("button[data-focus]").forEach((b) => {
      b.addEventListener("click", () => setFocus(b.dataset.focus === state.focus ? "" : b.dataset.focus));
    });

    function tile(v, l) { return `<div class="stat-tile"><div class="stat-value">${v}</div><div class="stat-label">${esc(l)}</div></div>`; }
    function row(colour, label, sci, count, key) {
      const attr = key ? ` data-focus="${key}" aria-pressed="${state.focus === key}"` : " disabled";
      return `<button class="md-row"${attr}><span class="dot" style="background:${colour}"></span>` +
        `<span>${esc(label)}${sci ? ` <span class="sci">${esc(sci)}</span>` : ""}</span><span class="n">${fmt(count)}</span></button>`;
    }
  }

  function buildFocusSelect() {
    const sel = document.getElementById("focus");
    const opt = (v, t) => `<option value="${v}">${esc(t)}</option>`;
    const gens = meta.genera.map((g, i) => [g, i]).filter(([g]) => g.name !== "other")
      .sort((a, b) => a[0].common.localeCompare(b[0].common));
    const sps = meta.species.map((s, i) => [s, i]).sort((a, b) => (a[0].common || a[0].name).localeCompare(b[0].common || b[0].name));
    sel.innerHTML = opt("", "All trees, coloured by genus") +
      `<optgroup label="One genus">${gens.map(([g, i]) => opt("g:" + i, `${g.common} (${g.name})`)).join("")}</optgroup>` +
      `<optgroup label="One species">${sps.map(([s, i]) => opt("s:" + i, `${s.common || s.name} (${s.name})`)).join("")}</optgroup>`;
    sel.addEventListener("change", () => setFocus(sel.value));
    const conf = document.getElementById("conf");
    conf.addEventListener("input", () => {
      state.minConf = conf.value / 100;
      document.getElementById("conf-val").textContent = conf.value + "%";
      refresh();
    });
  }

  function setFocus(v) {
    state.focus = v;
    document.getElementById("focus").value = v;
    refresh();
  }

  function refresh() {
    recolour(); draw(); renderPanel(); writeHash();
  }

  /* ------------------------------------------------------------- view hash --------- */

  function readHash() {
    const m = location.hash.match(/^#(\d+(?:\.\d+)?)\/(-?\d+\.\d+)\/(-?\d+\.\d+)(?:\/([gs]:\d+))?/);
    return m ? { zoom: +m[1], center: [+m[2], +m[3]], focus: m[4] || "" } : null;
  }
  function writeHash() {
    if (!map) return;
    const c = map.getCenter();
    history.replaceState(null, "", `#${map.getZoom()}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}${state.focus ? "/" + state.focus : ""}`);
  }

  /* ------------------------------------------------------------- init -------------- */

  async function init() {
    const view = readHash();
    map = L.map("map", {
      center: view ? view.center : [43.6745, -79.4045],
      zoom: view ? view.zoom : 17,
      minZoom: 11, maxZoom: 22,
      zoomControl: true,
    });
    L.tileLayer(ORTHO, {
      maxNativeZoom: 21, maxZoom: 22,
      attribution: 'Imagery &copy; <a href="https://www.toronto.ca/">City of Toronto</a> 2025',
    }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    SheetPanel.setup({ onResize: () => { map.invalidateSize(); draw(); } });

    canvas = L.DomUtil.create("canvas", "leaflet-zoom-hide");
    canvas.id = "tree-canvas";
    map.getPanes().overlayPane.appendChild(canvas);
    ctx = canvas.getContext("2d");
    map.on("zoomstart", () => { canvas.style.opacity = 0; });
    map.on("moveend", () => { draw(); writeHash(); });
    map.on("resize", draw);

    if (window.MapSearch) {
      let pin = null;
      MapSearch.mount({
        container: "#search",
        placeholder: "Search an address",
        onSelect: (r) => {
          if (pin) map.removeLayer(pin);
          pin = L.circleMarker([r.lat, r.lon], { radius: 10, color: "#ffffff", weight: 3, fill: false }).addTo(map);
          map.setView([r.lat, r.lon], Math.max(map.getZoom(), 19));
        },
        onClear: () => { if (pin) { map.removeLayer(pin); pin = null; } },
      });
    }

    try {
      await load();
    } catch (err) {
      document.getElementById("loading-text").textContent = "Couldn't load the trees: " + err.message;
      return;
    }
    document.getElementById("loading-badge").hidden = true;
    buildFocusSelect();
    if (view && view.focus) { state.focus = view.focus; document.getElementById("focus").value = view.focus; }
    refresh();

    map.on("click", (e) => {
      const i = nearest(e.latlng, map.getZoom() >= CIRCLE_ZOOM ? 14 : 6);
      if (i < 0) return;
      const ll = map.unproject([nx[i] * 256, ny[i] * 256], 0);
      L.popup({ maxWidth: 280 }).setLatLng(ll).setContent(popupHtml(i)).openOn(map);
    });

    const tip = document.getElementById("tip");
    let raf = 0;
    map.on("mousemove", (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const i = map.getZoom() >= CIRCLE_ZOOM ? nearest(e.latlng, 10) : -1;
        map.getContainer().style.cursor = i >= 0 ? "pointer" : "";
        if (i < 0) { tip.hidden = true; return; }
        tip.innerHTML = `${esc(genusLabel(col.g1[i]))} <span class="tree-tip-sci">${pct(col.g1p[i])}</span>`;
        tip.style.left = e.containerPoint.x + 14 + "px";
        tip.style.top = e.containerPoint.y + 14 + "px";
        tip.hidden = false;
      });
    });
    map.on("mouseout", () => { tip.hidden = true; });
  }

  init();
})();
