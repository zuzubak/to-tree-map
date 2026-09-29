/* Toronto Street Tree Map.
 *
 * Leaflet + raster basemap tiles + a Canvas2D overlay -- deliberately no WebGL, for the
 * same reason as the sibling to-multiplex-map project: MapLibre GL JS failed outright on a
 * real Chrome install with GPU disabled. Drawing ~690k points without WebGL is still
 * comfortable, because the hot path never touches the DOM or a path API: at city zoom the
 * trees are plotted straight into an ImageData pixel buffer (one 32-bit write per tree), and
 * only once you're zoomed in far enough for the count to drop do they become real circles
 * sized by trunk diameter.
 *
 * Data arrives as one gzipped typed array per attribute (see export/export_map_data.py).
 * Nothing is parsed -- the bytes are the arrays.
 */

/* ------------------------------------------------------------------ config ------------ */

const DATA = "data/";
/* Basemap: CARTO's grey canvas, matching the other maps on the site. Deliberately
 * desaturated -- the right backdrop for a map whose whole payload is coloured dots.
 *
 * CARTO answers unauthenticated requests with an "API KEY REQUIRED" watermark tile (HTTP
 * 200, normal-looking PNG, so it fails silently), and the keyed endpoint is a different
 * shape: under rastertiles/, takes ?key=, and has no {s} subdomain. site/config.js sets
 * the key and is written at deploy time from a repo secret.
 *
 * With no key we fall back to Esri's keyless grey canvas rather than to a watermarked
 * CARTO, so `python -m http.server` in site/ gives a working map with no setup. Esri only
 * serves real tiles to zoom 16, hence the per-source native zoom; the trees stay crisp
 * either way, since they're drawn on a canvas rather than baked into the tiles. */
const ESRI = {
  light: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  dark: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
};
const CARTO_ATTRIBUTION =
  'Basemap &copy; <a href="https://carto.com/attributions">CARTO</a>, ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; ' +
  'Trees: <a href="https://open.toronto.ca/dataset/street-tree-data/">City of Toronto</a>';
const ESRI_ATTRIBUTION =
  'Basemap &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; ' +
  'Trees: <a href="https://open.toronto.ca/dataset/street-tree-data/">City of Toronto</a>';

function basemapSource(dark) {
  const key = (window.CARTO_API_KEY || "").trim();
  if (key) {
    return {
      url: "https://basemaps.cartocdn.com/rastertiles/" + (dark ? "dark_all" : "light_all") +
           "/{z}/{x}/{y}{r}.png?key=" + encodeURIComponent(key),
      attribution: CARTO_ATTRIBUTION,
      maxNativeZoom: 19,
    };
  }
  return { url: dark ? ESRI.dark : ESRI.light, attribution: ESRI_ATTRIBUTION, maxNativeZoom: 16 };
}

const TORONTO_CENTER = [43.7, -79.38];
const DEFAULT_ZOOM = 11;

/* Above this zoom, trees are drawn as circles scaled by trunk diameter; below it, as
 * 1-2 px dots in a pixel buffer. The crossover is where a viewport holds few enough
 * trees that per-circle path work is cheaper than it is noticeable. */
const CIRCLE_ZOOM = 15;

/* Colour slots, read from CSS so light/dark and the palette live in one place. */
const SLOT_VARS = {
  native: "--series-native",
  introduced: "--series-introduced",
  invasive: "--series-invasive",
  unknown: "--series-unknown",
  other: "--series-other",
  seq: ["--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5"],
  gen: ["--gen-1", "--gen-2", "--gen-3", "--gen-4", "--gen-5", "--gen-6", "--gen-7", "--gen-8"],
};

/* Trunk-diameter classes for the sequential ramp, in cm. */
const DBH_BREAKS = [10, 25, 45, 70];
const COMPARE_LIMIT = 3;
const GRID = 512;

/* ------------------------------------------------------------------ utilities --------- */

const fmt = new Intl.NumberFormat("en-CA");
const fmtCompact = new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 1 });
const num = (n) => (n === null || n === undefined ? "–" : fmt.format(n));

let errorShown = false;
function showLoadError(message) {
  if (errorShown) return;
  errorShown = true;
  const el = document.createElement("div");
  el.className = "load-error";
  el.textContent = message;
  document.getElementById("map-pane").appendChild(el);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* Pack a CSS colour into the little-endian ABGR word an ImageData buffer wants. */
function packColour(css) {
  const probe = document.createElement("canvas").getContext("2d");
  probe.fillStyle = "#000";
  probe.fillStyle = css;
  const resolved = probe.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
  let r, g, b, a = 255;
  if (resolved.startsWith("#")) {
    r = parseInt(resolved.slice(1, 3), 16);
    g = parseInt(resolved.slice(3, 5), 16);
    b = parseInt(resolved.slice(5, 7), 16);
  } else {
    const parts = resolved.match(/[\d.]+/g).map(Number);
    [r, g, b] = parts;
    if (parts.length > 3) a = Math.round(parts[3] * 255);
  }
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/* ------------------------------------------------------------------ data loading ------- */

/* GitHub Pages won't negotiate gzip for application/octet-stream, so the columns are
 * gzipped in the file and inflated here. DecompressionStream covers every current browser;
 * fflate is fetched only as a fallback for older ones. */
let fflateReady = null;
function loadFflate() {
  if (!fflateReady) {
    fflateReady = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/fflate@0.8.2/umd/index.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("could not load the gzip fallback"));
      document.head.appendChild(s);
    });
  }
  return fflateReady;
}

async function loadColumn(file, Ctor) {
  const resp = await fetch(DATA + file);
  if (!resp.ok) throw new Error(`${file}: ${resp.status}`);

  let buffer;
  if (typeof DecompressionStream === "function") {
    const stream = resp.body.pipeThrough(new DecompressionStream("gzip"));
    buffer = await new Response(stream).arrayBuffer();
  } else {
    await loadFflate();
    const gz = new Uint8Array(await resp.arrayBuffer());
    buffer = window.fflate.gunzipSync(gz).buffer;
  }
  return new Ctor(buffer);
}

async function loadJSON(path) {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`${path}: ${resp.status}`);
  return resp.json();
}

/* ------------------------------------------------------------------ the dataset -------- */

/* Everything the map knows about the trees, in parallel arrays indexed by tree. */
const trees = {
  n: 0,
  nx: null,        // normalized Web Mercator x, [0,1]  (Float64: Float32 loses pixels at z19)
  ny: null,
  lon: null,
  lat: null,
  taxon: null,     // Uint16 -> meta.taxa index
  dbh: null,       // Uint16, cm, 0 = not recorded
  addr: null,
  street: null,
  cross1: null,
  cross2: null,
  ward: null,
  details: false,  // have the address columns arrived yet?
};

/* Per-taxon lookups, built once from the metadata. */
const taxonInfo = {
  originClass: null,   // Uint8 per taxon: 0 unknown, 1 native, 2 introduced, 3 invasive
  genusIdx: null,      // Uint16 per taxon -> meta.genera index
  speciesIdx: null,    // Uint16 per taxon -> meta.species index, 0xffff if genus-only
};

let meta = null;

/* Derived per-tree arrays, recomputed when the relevant control changes. */
let visible = null;     // Uint8: passes every active filter
let colourIdx = null;   // Uint8: index into the active palette; 0 is always "other/muted"

const state = {
  colourMode: "origin",
  taxonLevel: "genus",
  origin: new Set(["native", "non_native", "invasive", "unknown"]),
  selectedTaxa: new Set(),   // genus names or species keys, per taxonLevel
  compare: [],               // ordered, max COMPARE_LIMIT
  dbhMin: 0,
  dbhMax: 200,
  dbhIncludeUnknown: true,
  ward: "",
  selectedTree: -1,
};

/* ------------------------------------------------------------------ projection --------- */

function buildProjection() {
  const { origin_lon, origin_lat, scale } = meta.coords;
  const raw = trees._coords;
  const n = trees.n;
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const RAD = Math.PI / 180;

  for (let i = 0; i < n; i++) {
    const lo = origin_lon + raw[i] / scale;
    const la = origin_lat + raw[n + i] / scale;
    lon[i] = lo;
    lat[i] = la;
    nx[i] = (lo + 180) / 360;
    const s = Math.sin(la * RAD);
    ny[i] = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }
  trees.lon = lon;
  trees.lat = lat;
  trees.nx = nx;
  trees.ny = ny;
  delete trees._coords;
}

/* ------------------------------------------------------------------ spatial index ------ */

/* A plain uniform grid in CSR form: `start[c]..start[c+1]` indexes into `order`, giving the
 * trees in cell c. Used to cull to the viewport when zoomed in, and to hit-test clicks.
 * Built in one pass over the coordinates -- no tree structure needed for points this dense. */
const index = { x0: 0, y0: 0, dx: 1, dy: 1, start: null, order: null };

function buildIndex() {
  const n = trees.n;
  const { nx, ny } = trees;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (nx[i] < minX) minX = nx[i];
    if (nx[i] > maxX) maxX = nx[i];
    if (ny[i] < minY) minY = ny[i];
    if (ny[i] > maxY) maxY = ny[i];
  }
  // Nudge the extent so the maximum coordinate can't land in cell GRID.
  index.x0 = minX;
  index.y0 = minY;
  index.dx = (maxX - minX) * 1.0000001 / GRID;
  index.dy = (maxY - minY) * 1.0000001 / GRID;

  const cells = GRID * GRID;
  const start = new Uint32Array(cells + 1);
  const cellOf = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const gx = ((nx[i] - index.x0) / index.dx) | 0;
    const gy = ((ny[i] - index.y0) / index.dy) | 0;
    const c = gy * GRID + gx;
    cellOf[i] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const order = new Uint32Array(n);
  const cursor = start.slice(0, cells);
  for (let i = 0; i < n; i++) order[cursor[cellOf[i]]++] = i;

  index.start = start;
  index.order = order;
}

/* ------------------------------------------------------------------ taxon lookups ------ */

function buildTaxonLookups() {
  const taxa = meta.taxa;
  const originClass = new Uint8Array(taxa.length);
  const genusIdx = new Uint16Array(taxa.length);
  const speciesIdx = new Uint16Array(taxa.length);

  const genusPos = new Map(meta.genera.map((g, i) => [g.genus, i]));
  const speciesPos = new Map(meta.species.map((s, i) => [s.key, i]));

  taxa.forEach((t, i) => {
    originClass[i] = t.native === "native" ? 1 : t.invasive ? 3 : t.native === "non_native" ? 2 : 0;
    genusIdx[i] = genusPos.has(t.genus) ? genusPos.get(t.genus) : 0xffff;
    const key = t.species ? `${t.genus} ${t.species}` : null;
    speciesIdx[i] = key && speciesPos.has(key) ? speciesPos.get(key) : 0xffff;
  });

  taxonInfo.originClass = originClass;
  taxonInfo.genusIdx = genusIdx;
  taxonInfo.speciesIdx = speciesIdx;
}

/* ------------------------------------------------------------------ filters ------------ */

/* One pass over every tree per filter change. At ~690k trees this is a couple of
 * milliseconds, which is why the filters can be plain typed-array scans instead of
 * precomputed bitsets per category. */
function recomputeVisible() {
  const n = trees.n;
  const { taxon, dbh, ward } = trees;
  const { originClass, genusIdx, speciesIdx } = taxonInfo;
  const originMask = [
    state.origin.has("unknown"),
    state.origin.has("native"),
    state.origin.has("non_native"),
    state.origin.has("invasive"),
  ];
  const { dbhMin, dbhMax, dbhIncludeUnknown } = state;
  const wardFilter = state.ward ? parseInt(state.ward, 10) : 0;

  // Turn the selected genus/species names into a fast per-taxon lookup.
  let taxonAllowed = null;
  if (state.selectedTaxa.size) {
    taxonAllowed = new Uint8Array(meta.taxa.length);
    const byGenus = state.taxonLevel === "genus";
    for (let t = 0; t < meta.taxa.length; t++) {
      const idx = byGenus ? genusIdx[t] : speciesIdx[t];
      if (idx === 0xffff) continue;
      const name = byGenus ? meta.genera[idx].genus : meta.species[idx].key;
      if (state.selectedTaxa.has(name)) taxonAllowed[t] = 1;
    }
  }

  let count = 0;
  for (let i = 0; i < n; i++) {
    const t = taxon[i];
    if (!originMask[originClass[t]]) continue;
    if (taxonAllowed && !taxonAllowed[t]) continue;
    const d = dbh[i];
    if (d === 0) {
      if (!dbhIncludeUnknown) continue;
    } else if (d < dbhMin || d > dbhMax) continue;
    if (wardFilter && ward[i] !== wardFilter) continue;
    visible[i] = 1;
    count++;
  }
  return count;
}

function clearVisible() {
  visible.fill(0);
}

/* ------------------------------------------------------------------ colour -------------- */

/* The active palette: CSS colour strings for circles, packed words for the pixel path.
 * Slot 0 is always the muted "everything else" colour. */
const palette = { css: [], packed: null, labels: [] };

function rebuildPalette() {
  let css;
  if (state.colourMode === "origin") {
    css = [SLOT_VARS.unknown, SLOT_VARS.native, SLOT_VARS.introduced, SLOT_VARS.invasive].map(cssVar);
    palette.labels = ["Not identified to species", "Native to Ontario", "Introduced", "Introduced & invasive"];
  } else if (state.colourMode === "dbh") {
    css = [cssVar(SLOT_VARS.unknown), ...SLOT_VARS.seq.map(cssVar)];
    palette.labels = ["No diameter recorded", ...DBH_BREAKS.map((b, i) => (i === 0 ? `< ${b} cm` : `${DBH_BREAKS[i - 1]}–${b} cm`)), `≥ ${DBH_BREAKS[DBH_BREAKS.length - 1]} cm`];
  } else if (state.colourMode === "compare") {
    css = [cssVar(SLOT_VARS.other), cssVar(SLOT_VARS.introduced), cssVar(SLOT_VARS.invasive), cssVar(SLOT_VARS.native)];
    palette.labels = ["Everything else", "", "", ""];
  } else {
    css = [cssVar(SLOT_VARS.other), ...SLOT_VARS.gen.map(cssVar)];
    palette.labels = ["Other genus"];
  }
  palette.css = css;
  palette.packed = Uint32Array.from(css, packColour);
}

/* Per-tree palette index. Recomputed on colour-mode change and whenever the thing the mode
 * depends on changes (the compare slots, say) -- never per frame. */
function recomputeColours() {
  const n = trees.n;
  const { taxon, dbh } = trees;
  const { originClass, genusIdx, speciesIdx } = taxonInfo;

  if (state.colourMode === "origin") {
    for (let i = 0; i < n; i++) colourIdx[i] = originClass[taxon[i]];
    return;
  }

  if (state.colourMode === "dbh") {
    const [b0, b1, b2, b3] = DBH_BREAKS;
    for (let i = 0; i < n; i++) {
      const d = dbh[i];
      colourIdx[i] = d === 0 ? 0 : d < b0 ? 1 : d < b1 ? 2 : d < b2 ? 3 : d < b3 ? 4 : 5;
    }
    return;
  }

  if (state.colourMode === "compare") {
    // Slot i+1 for the i-th compared taxon; everything else muted.
    const slotOf = new Uint8Array(meta.taxa.length);
    state.compare.forEach((entry, slot) => {
      for (let t = 0; t < meta.taxa.length; t++) {
        const idx = entry.level === "genus" ? genusIdx[t] : speciesIdx[t];
        if (idx === 0xffff) continue;
        const name = entry.level === "genus" ? meta.genera[idx].genus : meta.species[idx].key;
        if (name === entry.key) slotOf[t] = slot + 1;
      }
    });
    for (let i = 0; i < n; i++) colourIdx[i] = slotOf[taxon[i]];
    return;
  }

  // Full genus palette: the eight most common genera get a hue, the rest are muted.
  const slotOf = new Uint8Array(meta.taxa.length);
  const colouredGenera = meta.genera.filter((g) => g.coloured).slice(0, SLOT_VARS.gen.length);
  const genusSlot = new Map(colouredGenera.map((g, i) => [g.genus, i + 1]));
  for (let t = 0; t < meta.taxa.length; t++) {
    const gi = genusIdx[t];
    if (gi === 0xffff) continue;
    slotOf[t] = genusSlot.get(meta.genera[gi].genus) || 0;
  }
  for (let i = 0; i < n; i++) colourIdx[i] = slotOf[taxon[i]];
  palette.labels = ["Other genus", ...colouredGenera.map((g) => g.label)];
}

/* ------------------------------------------------------------------ the tree layer ----- */

/* Extends L.Renderer rather than L.Layer: L.Renderer already owns the padded container, the
 * pan/zoom transform bookkeeping and the zoom-animation handoff, and calls _update() exactly
 * when a redraw is needed. This is the same base L.Canvas builds on.
 *
 * After the translate in _update(), drawing happens in Leaflet *layer point* coordinates.
 * The pixel-buffer path can't use the context translate, so it converts to device pixels
 * itself via _toDevice.
 */
const TreeLayer = L.Renderer.extend({
  /* Padding lets Leaflet translate the canvas during a drag without exposing blank edges.
     Kept modest: the pixel path clears and uploads the whole canvas on every redraw, so
     area is the cost driver at city zoom. */
  options: { padding: 0.15 },

  _initContainer() {
    const container = (this._container = document.createElement("canvas"));
    container.id = "tree-canvas";
    this._ctx = container.getContext("2d");
  },

  _destroyContainer() {
    L.DomUtil.remove(this._container);
    this._container = this._ctx = null;
  },

  _update() {
    if (this._map._animatingZoom && this._bounds) return;
    L.Renderer.prototype._update.call(this);

    const b = this._bounds;
    const size = b.getSize();
    const m = (this._dpr = Math.min(window.devicePixelRatio || 1, 2));
    const c = this._container;

    L.DomUtil.setPosition(c, b.min);
    c.width = Math.round(m * size.x);
    c.height = Math.round(m * size.y);
    c.style.width = size.x + "px";
    c.style.height = size.y + "px";

    this._imageData = null; // viewport changed; the pixel buffer must be reallocated
    this.draw();
  },

  /* Layer point -> device pixel inside the canvas. */
  _toDevice() {
    const b = this._bounds;
    const m = this._dpr;
    return { ox: b.min.x, oy: b.min.y, m };
  },

  /* Which grid cells the padded viewport covers, in index space. */
  _visibleCells() {
    const map = this._map;
    const S = map.options.crs.scale(map.getZoom());
    const origin = map.getPixelOrigin();
    const b = this._bounds;
    const nx0 = (b.min.x + origin.x) / S;
    const nx1 = (b.max.x + origin.x) / S;
    const ny0 = (b.min.y + origin.y) / S;
    const ny1 = (b.max.y + origin.y) / S;
    const gx0 = Math.max(0, Math.floor((nx0 - index.x0) / index.dx));
    const gx1 = Math.min(GRID - 1, Math.ceil((nx1 - index.x0) / index.dx));
    const gy0 = Math.max(0, Math.floor((ny0 - index.y0) / index.dy));
    const gy1 = Math.min(GRID - 1, Math.ceil((ny1 - index.y0) / index.dy));
    return { gx0, gx1, gy0, gy1, S, origin };
  },

  draw() {
    if (!this._map || !trees.n || !this._ctx) return;
    const ctx = this._ctx;
    const c = this._container;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);

    const zoom = this._map.getZoom();
    if (zoom >= CIRCLE_ZOOM) this._drawCircles();
    else this._drawPixels();
    this._drawSelection();
  },

  /* City-scale path: one 32-bit write per tree into an ImageData buffer. No path API, no
   * per-point function calls, so all 690k points stay well inside a frame. */
  _drawPixels() {
    const ctx = this._ctx;
    const c = this._container;
    if (!this._imageData || this._imageData.width !== c.width || this._imageData.height !== c.height) {
      this._imageData = ctx.createImageData(c.width, c.height);
      this._pixels = new Uint32Array(this._imageData.data.buffer);
    }
    const px = this._pixels;
    px.fill(0);

    const { gx0, gx1, gy0, gy1, S, origin } = this._visibleCells();
    const { ox, oy, m } = this._toDevice();
    const { nx, ny } = trees;
    const { start, order } = index;
    const packed = palette.packed;
    const W = c.width;
    const H = c.height;
    const zoom = this._map.getZoom();

    /* Dot radius in device pixels. One pixel is too faint to read as a dot map on a
     * retina display, so the block grows a little with zoom. */
    const block = zoom <= 11 ? Math.round(m) : zoom <= 13 ? Math.round(1.5 * m) : Math.round(2 * m);

    for (let gy = gy0; gy <= gy1; gy++) {
      const rowBase = gy * GRID;
      const from = start[rowBase + gx0];
      const to = start[rowBase + gx1 + 1];
      for (let k = from; k < to; k++) {
        const i = order[k];
        if (!visible[i]) continue;
        const x = (((nx[i] * S - origin.x) - ox) * m) | 0;
        if (x < 0 || x >= W) continue;
        const y = (((ny[i] * S - origin.y) - oy) * m) | 0;
        if (y < 0 || y >= H) continue;
        const col = packed[colourIdx[i]];

        if (block === 1) {
          px[y * W + x] = col;
        } else {
          const xEnd = Math.min(W, x + block);
          const yEnd = Math.min(H, y + block);
          for (let yy = y; yy < yEnd; yy++) {
            const rowOff = yy * W;
            for (let xx = x; xx < xEnd; xx++) px[rowOff + xx] = col;
          }
        }
      }
    }
    ctx.putImageData(this._imageData, 0, 0);
  },

  /* Street-scale path: real circles, radius from trunk diameter, batched one path per
   * colour so the fill count stays at the number of palette slots. */
  _drawCircles() {
    const ctx = this._ctx;
    const m = this._dpr;
    ctx.setTransform(m, 0, 0, m, 0, 0);
    const { ox, oy } = this._toDevice();
    ctx.translate(-ox, -oy);

    const { gx0, gx1, gy0, gy1, S, origin } = this._visibleCells();
    const { nx, ny, dbh } = trees;
    const { start, order } = index;
    const zoom = this._map.getZoom();

    /* Radius: trunks are 1-300 cm, so scale the *diameter* by the map's metres-per-pixel
     * and floor it so a sapling is still clickable. A 100 cm trunk at z19 is ~9 px wide,
     * which is roughly life-size. */
    const metresPerPixel = 156543.03392 * Math.cos((TORONTO_CENTER[0] * Math.PI) / 180) / Math.pow(2, zoom);
    const scaleFactor = 0.01 / metresPerPixel; // cm -> px
    const minR = zoom >= 17 ? 3 : 2.2;

    const buckets = [];
    for (let s = 0; s < palette.css.length; s++) buckets.push([]);

    for (let gy = gy0; gy <= gy1; gy++) {
      const rowBase = gy * GRID;
      const from = start[rowBase + gx0];
      const to = start[rowBase + gx1 + 1];
      for (let k = from; k < to; k++) {
        const i = order[k];
        if (!visible[i]) continue;
        buckets[colourIdx[i]].push(i);
      }
    }

    const TAU = Math.PI * 2;
    // Muted slot first so highlighted trees land on top of it.
    for (let s = 0; s < buckets.length; s++) {
      const bucket = buckets[s];
      if (!bucket.length) continue;
      ctx.beginPath();
      for (const i of bucket) {
        const x = nx[i] * S - origin.x;
        const y = ny[i] * S - origin.y;
        const d = dbh[i];
        const r = Math.max(minR, (d ? d : 12) * 0.5 * scaleFactor);
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
      }
      ctx.fillStyle = palette.css[s];
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    this._circleScale = { scaleFactor, minR };
  },

  _drawSelection() {
    const i = state.selectedTree;
    if (i < 0 || !this._map) return;
    const ctx = this._ctx;
    const m = this._dpr;
    const { ox, oy } = this._toDevice();
    const S = this._map.options.crs.scale(this._map.getZoom());
    const origin = this._map.getPixelOrigin();
    ctx.setTransform(m, 0, 0, m, 0, 0);
    ctx.translate(-ox, -oy);

    const x = trees.nx[i] * S - origin.x;
    const y = trees.ny[i] * S - origin.y;
    const r = Math.max(7, (trees.dbh[i] || 12) * 0.5 * (this._circleScale ? this._circleScale.scaleFactor : 0) + 4);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = cssVar("--surface-1");
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = cssVar("--text-primary");
    ctx.stroke();
  },

  /* Nearest visible tree to a layer point, within `tolerance` CSS px. Searches outward one
   * ring of grid cells at a time so a click in empty space stays cheap. */
  hitTest(layerPoint, tolerance) {
    if (!trees.n) return -1;
    const map = this._map;
    const S = map.options.crs.scale(map.getZoom());
    const origin = map.getPixelOrigin();
    const nxTarget = (layerPoint.x + origin.x) / S;
    const nyTarget = (layerPoint.y + origin.y) / S;
    const gx = Math.round((nxTarget - index.x0) / index.dx);
    const gy = Math.round((nyTarget - index.y0) / index.dy);

    const { start, order } = index;
    const { nx, ny } = trees;
    let best = -1;
    let bestDist = Infinity;
    const tolSq = tolerance * tolerance;

    for (let ring = 0; ring <= 2; ring++) {
      for (let cy = gy - ring; cy <= gy + ring; cy++) {
        if (cy < 0 || cy >= GRID) continue;
        for (let cx = gx - ring; cx <= gx + ring; cx++) {
          if (cx < 0 || cx >= GRID) continue;
          // Only the newly added ring, except on the first pass.
          if (ring > 0 && Math.abs(cy - gy) !== ring && Math.abs(cx - gx) !== ring) continue;
          const c = cy * GRID + cx;
          for (let k = start[c]; k < start[c + 1]; k++) {
            const i = order[k];
            if (!visible[i]) continue;
            const dx = (nx[i] - nxTarget) * S;
            const dy = (ny[i] - nyTarget) * S;
            const dist = dx * dx + dy * dy;
            if (dist < bestDist) {
              bestDist = dist;
              best = i;
            }
          }
        }
      }
      if (best >= 0 && bestDist <= tolSq) return best;
    }
    return bestDist <= tolSq ? best : -1;
  },
});

/* ------------------------------------------------------------------ UI: rendering ------ */

const el = (id) => document.getElementById(id);
let map = null;
let treeLayer = null;
let wardLayer = null;
let visibleCount = 0;

function renderStats() {
  const s = meta.summary;
  const scoped = state.ward || state.selectedTaxa.size || visibleCount !== trees.n;
  const tiles = [
    ["Trees shown", fmtCompact.format(visibleCount)],
    ["Native to Ontario", `${s.native_pct}%`],
    ["Species", num(s.species_count)],
    ["Invasive", fmtCompact.format(s.invasive_count)],
  ];
  if (scoped) tiles[1] = ["Of all trees", fmtCompact.format(trees.n)];
  el("stats").innerHTML = tiles
    .map(([label, value]) => `<div class="stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`)
    .join("");
}

function renderLegend() {
  const box = el("legend");
  const mode = state.colourMode;

  if (mode === "dbh") {
    const steps = palette.css.slice(1);
    box.innerHTML =
      `<div class="ramp-legend"><div class="ramp-bar">${steps.map((c) => `<span style="background:${c}"></span>`).join("")}</div>` +
      `<div class="ramp-labels"><span>thin</span><span>trunk diameter</span><span>thick</span></div>` +
      `<div class="legend-row"><span class="swatch" style="background:${palette.css[0]}"></span><span>No diameter recorded</span></div></div>`;
    return;
  }

  if (mode === "compare") {
    const slots = [];
    for (let i = 0; i < COMPARE_LIMIT; i++) {
      const entry = state.compare[i];
      slots.push(
        `<div class="compare-slot" data-filled="${!!entry}">` +
          `<span class="swatch" style="background:${palette.css[i + 1]}"></span>` +
          `<span class="cs-name">${entry ? entry.label : "Pick from the list below"}</span>` +
          (entry ? `<span class="cs-count">${fmtCompact.format(entry.count)}</span><button class="cs-remove" data-remove="${i}" aria-label="Remove ${entry.label}">&times;</button>` : "") +
        `</div>`
      );
    }
    box.innerHTML =
      `<div class="compare-slots">${slots.join("")}</div>` +
      `<p class="compare-hint">Up to three at a time &mdash; three hues is the most a dot map can keep apart for colour-blind readers. Everything else stays grey.</p>`;
    box.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", () => {
        state.compare.splice(Number(b.dataset.remove), 1);
        recomputeColours();
        renderLegend();
        renderTaxonList();
        treeLayer.draw();
      })
    );
    return;
  }

  // origin + genus: a plain labelled swatch list, with counts.
  const counts = mode === "origin"
    ? [meta.summary.unknown_count, meta.summary.native_count, meta.summary.non_native_count - meta.summary.invasive_count, meta.summary.invasive_count]
    : null;
  const rows = palette.labels.map((label, i) => {
    if (!label) return "";
    const count = counts ? counts[i] : (meta.genera.find((g) => g.label === label) || {}).count;
    return `<div class="legend-row"><span class="swatch" style="background:${palette.css[i]}"></span><span>${label}</span>` +
      (count != null ? `<span class="legend-count">${fmtCompact.format(count)}</span>` : "") + `</div>`;
  });
  // Put the muted/unknown slot last -- it reads as a footnote, not a category.
  box.innerHTML = rows.slice(1).join("") + rows[0];
}

/* The species/genus list doubles as the filter and, in compare mode, the colour picker. */
function renderTaxonList() {
  const query = el("taxon-search").value.trim().toLowerCase();
  const level = state.taxonLevel;
  const source = level === "genus" ? meta.genera : meta.species;
  const list = el("taxon-list");

  const rows = source
    .filter((r) => {
      const key = level === "genus" ? r.genus : r.key;
      if (!key) return false; // trees with no identification at all have nothing to filter on
      if (!query) return true;
      return (r.label || "").toLowerCase().includes(query) || key.toLowerCase().includes(query);
    })
    .slice(0, 400);

  if (!rows.length) {
    list.innerHTML = `<div class="taxon-empty">Nothing matches &ldquo;${query}&rdquo;.</div>`;
    return;
  }

  list.innerHTML = rows
    .map((r) => {
      const key = level === "genus" ? r.genus : r.key;
      const selected = state.colourMode === "compare"
        ? state.compare.some((c) => c.key === key && c.level === level)
        : state.selectedTaxa.has(key);
      const sci = level === "genus" ? r.genus : r.key;
      const badge = r.invasive ? " · invasive" : r.native === "native" ? " · native" : "";
      return (
        `<button class="taxon-row" role="option" aria-selected="${selected}" data-key="${encodeURIComponent(key)}">` +
          `<span class="tr-name">${r.label || sci} <span class="tr-sci">${sci}</span>${badge}</span>` +
          `<span class="tr-count">${fmtCompact.format(r.count)}</span>` +
        `</button>`
      );
    })
    .join("");

  list.querySelectorAll(".taxon-row").forEach((btn) => {
    btn.addEventListener("click", () => onTaxonClick(decodeURIComponent(btn.dataset.key)));
  });
  el("taxon-clear").hidden = !(state.selectedTaxa.size || (state.colourMode === "compare" && state.compare.length));
}

function onTaxonClick(key) {
  const level = state.taxonLevel;
  const source = level === "genus" ? meta.genera : meta.species;
  const row = source.find((r) => (level === "genus" ? r.genus : r.key) === key);

  if (state.colourMode === "compare") {
    const at = state.compare.findIndex((c) => c.key === key && c.level === level);
    if (at >= 0) state.compare.splice(at, 1);
    else {
      if (state.compare.length >= COMPARE_LIMIT) state.compare.shift();
      state.compare.push({ key, level, label: row.label || key, count: row.count });
    }
    recomputeColours();
    renderLegend();
    renderTaxonList();
    treeLayer.draw();
    return;
  }

  if (state.selectedTaxa.has(key)) state.selectedTaxa.delete(key);
  else state.selectedTaxa.add(key);
  applyFilters();
  renderTaxonList();
}

function renderTaxaTable() {
  // Counts respect the active filters, so the table answers "what's here" for the
  // current view rather than only for the whole city.
  const level = state.taxonLevel;
  const { taxon } = trees;
  const { genusIdx, speciesIdx } = taxonInfo;
  const source = level === "genus" ? meta.genera : meta.species;
  const tally = new Float64Array(source.length);
  let total = 0;
  for (let i = 0; i < trees.n; i++) {
    if (!visible[i]) continue;
    const idx = level === "genus" ? genusIdx[taxon[i]] : speciesIdx[taxon[i]];
    if (idx === 0xffff) continue;
    tally[idx]++;
    total++;
  }
  const ranked = Array.from(tally, (count, i) => ({ count, row: source[i] }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  el("table-scope").textContent = state.ward
    ? `in ${(meta.wards.find((w) => w.ward === state.ward) || {}).ward_name || "this ward"}`
    : "citywide";

  el("taxa-table").innerHTML = ranked
    .map(({ count, row }) => {
      const colour = row.invasive ? cssVar(SLOT_VARS.invasive)
        : row.native === "native" ? cssVar(SLOT_VARS.native)
        : row.native === "non_native" ? cssVar(SLOT_VARS.introduced)
        : cssVar(SLOT_VARS.unknown);
      const share = total ? ((count / total) * 100).toFixed(1) + "%" : "–";
      return `<div class="taxa-row"><span class="swatch" style="background:${colour}"></span>` +
        `<span class="tx-name">${row.label || row.genus || row.key}</span>` +
        `<span class="tx-count">${fmt.format(count)}</span><span class="tx-share">${share}</span></div>`;
    })
    .join("");
}

function renderWardStats() {
  const box = el("ward-stats");
  if (!state.ward) {
    box.innerHTML = "";
    return;
  }
  const w = meta.wards.find((x) => x.ward === state.ward);
  if (!w) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = [
    ["Trees", fmtCompact.format(w.tree_count)],
    ["Native", `${w.native_pct}%`],
    ["Species", num(w.species_count)],
    ["Mean trunk", `${w.mean_dbh_cm} cm`],
  ]
    .map(([label, value]) => `<div class="stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`)
    .join("");
}

/* ------------------------------------------------------------------ UI: tree card ------ */

function streetName(id) {
  return id && meta.streets[id] ? meta.streets[id] : null;
}

function renderTreeCard(i) {
  const card = el("tree-card");
  if (i < 0) {
    card.hidden = true;
    return;
  }
  const t = meta.taxa[trees.taxon[i]];
  const dbh = trees.dbh[i];
  const body = el("tree-card-body");

  const originLabel = t.invasive ? "Introduced &amp; invasive"
    : t.native === "native" ? "Native to Ontario"
    : t.native === "non_native" ? "Introduced"
    : "Not identified to species";
  const originColour = t.invasive ? SLOT_VARS.invasive
    : t.native === "native" ? SLOT_VARS.native
    : t.native === "non_native" ? SLOT_VARS.introduced
    : SLOT_VARS.unknown;

  const addr = trees.details
    ? [trees.addr[i] || null, streetName(trees.street[i])].filter(Boolean).join(" ")
    : "";
  const crosses = trees.details
    ? [streetName(trees.cross1[i]), streetName(trees.cross2[i])].filter(Boolean)
    : [];
  const ward = meta.wards.find((w) => w.ward === String(trees.ward[i]).padStart(2, "0"));

  const rows = [
    ["Address", addr || (trees.details ? "Not recorded" : "Loading…")],
    ["Between", crosses.length ? crosses.join(" and ") : null],
    ["Ward", ward ? `${ward.ward_name} (${ward.ward})` : null],
    ["Trunk diameter", dbh ? `${dbh} cm` : "Not recorded"],
    ["Origin", t.origin || null],
    ["Typical for species", t.mean_dbh ? `${t.mean_dbh} cm mean trunk` : null],
    ["Trees of this kind", `${fmt.format(t.count)} citywide`],
  ];

  // A trunk-size figure reads faster than the number alone: this trunk against the
  // thickest recorded for the same species.
  const figure = dbh && t.max_dbh
    ? `<div class="dbh-figure"><div class="dbh-figure-bar">` +
      `<div class="dbh-figure-fill" style="width:${Math.min(100, (dbh / t.max_dbh) * 100).toFixed(1)}%"></div></div>` +
      `<div class="dbh-figure-label">${dbh} cm &middot; thickest ${(t.common || t.botanical || "tree").toLowerCase()} in the inventory is ${t.max_dbh} cm</div></div>`
    : "";

  body.innerHTML =
    `<div class="tree-title">${t.common || t.botanical}</div>` +
    `<div class="tree-sci">${t.botanical}${t.cultivar ? "" : ""}</div>` +
    `<div class="tree-badges">` +
      `<span class="tree-badge"><span class="swatch" style="background:${cssVar(originColour)}"></span>${originLabel}</span>` +
      (t.basis === "genus" ? `<span class="tree-badge">Genus-level record</span>` : "") +
    `</div>` +
    figure +
    rows
      .filter(([, v]) => v)
      .map(([k, v]) => `<div class="tree-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
      .join("") +
    (t.notes ? `<p class="tree-note">${t.notes}.</p>` : "");

  card.hidden = false;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* ------------------------------------------------------------------ UI: dbh slider ---- */

function renderHistogram() {
  const bins = meta.dbh_histogram.bins;
  const max = Math.max(...bins.map((b) => b[1]));
  el("histogram").innerHTML = bins
    .map(([lo, count]) => {
      const inRange = lo + meta.dbh_histogram.bin_width > state.dbhMin && lo <= state.dbhMax;
      return `<div class="hbar" data-in-range="${inRange}" style="height:${Math.max(1, (count / max) * 100)}%" title="${lo}–${lo + 5} cm: ${fmt.format(count)}"></div>`;
    })
    .join("");
}

function renderDbhControls() {
  const minEl = el("range-min");
  const maxEl = el("range-max");
  el("range-label-min").textContent = `${state.dbhMin} cm`;
  el("range-label-max").textContent = state.dbhMax >= Number(maxEl.max) ? `${maxEl.max}+ cm` : `${state.dbhMax} cm`;
  const span = Number(maxEl.max) - Number(maxEl.min);
  const fill = el("range-fill");
  fill.style.left = `${((state.dbhMin - Number(maxEl.min)) / span) * 100}%`;
  fill.style.right = `${100 - ((state.dbhMax - Number(maxEl.min)) / span) * 100}%`;
  el("dbh-readout").textContent = `${state.dbhMin}–${state.dbhMax >= Number(maxEl.max) ? maxEl.max + "+" : state.dbhMax} cm`;
  renderHistogram();
}

/* ------------------------------------------------------------------ orchestration ------ */

function applyFilters() {
  clearVisible();
  visibleCount = recomputeVisible();
  if (state.selectedTree >= 0 && !visible[state.selectedTree]) {
    state.selectedTree = -1;
    renderTreeCard(-1);
  }
  renderStats();
  renderTaxaTable();
  el("taxon-clear").hidden = !(state.selectedTaxa.size || (state.colourMode === "compare" && state.compare.length));
  if (treeLayer) treeLayer.draw();
}

function setColourMode(mode) {
  state.colourMode = mode;
  document.querySelectorAll("#colour-mode .seg-btn").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.mode === mode))
  );
  if (mode === "compare" && !state.compare.length) {
    // Open on the three most common genera, so the mode is never an empty grey map.
    state.taxonLevel = "genus";
    document.querySelectorAll("#taxon-level .seg-btn").forEach((b) =>
      b.setAttribute("aria-checked", String(b.dataset.level === "genus"))
    );
    state.compare = meta.genera.slice(0, COMPARE_LIMIT).map((g) => ({
      key: g.genus, level: "genus", label: g.label, count: g.count,
    }));
  }
  rebuildPalette();
  recomputeColours();
  renderLegend();
  renderTaxonList();
  if (treeLayer) treeLayer.draw();
}

/* ------------------------------------------------------------------ permalink ----------- */

/* #z/lat/lon, optionally &t=lat,lon for a selected tree. The selected tree is addressed by
 * position rather than by row number: row numbers shift every time the City republishes the
 * inventory, coordinates don't. */
function writeHash() {
  if (!map) return;
  const c = map.getCenter();
  let hash = `#${map.getZoom()}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`;
  if (state.selectedTree >= 0) {
    const i = state.selectedTree;
    hash += `&t=${trees.lat[i].toFixed(6)},${trees.lon[i].toFixed(6)}`;
  }
  history.replaceState(null, "", hash);
}

function readHash() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return null;
  const [view, ...rest] = raw.split("&");
  const parts = view.split("/").map(Number);
  const out = {};
  if (parts.length === 3 && parts.every((p) => !Number.isNaN(p))) {
    out.zoom = parts[0];
    out.center = [parts[1], parts[2]];
  }
  const treeParam = rest.find((p) => p.startsWith("t="));
  if (treeParam) {
    const [lat, lon] = treeParam.slice(2).split(",").map(Number);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) out.tree = [lat, lon];
  }
  return out;
}

/* Find the tree nearest a coordinate, for restoring a shared link. */
function findTreeNear(lat, lon) {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < trees.n; i++) {
    const dx = trees.lon[i] - lon;
    const dy = trees.lat[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  // ~20 m tolerance in degrees squared.
  return bestDist < 4e-8 ? best : -1;
}

/* ------------------------------------------------------------------ interaction --------- */

function selectTree(i) {
  state.selectedTree = i;
  renderTreeCard(i);
  treeLayer.draw();
  writeHash();
}

function setupMapInteraction() {
  const tip = document.createElement("div");
  tip.className = "tree-tip";
  tip.hidden = true;
  el("map-pane").appendChild(tip);

  const tolerance = () => (map.getZoom() >= CIRCLE_ZOOM ? 12 : 7);

  map.on("click", (e) => {
    const i = treeLayer.hitTest(map.latLngToLayerPoint(e.latlng), tolerance());
    if (i >= 0) selectTree(i);
  });

  let rafPending = false;
  map.on("mousemove", (e) => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const i = treeLayer.hitTest(map.latLngToLayerPoint(e.latlng), tolerance());
      if (i < 0) {
        tip.hidden = true;
        L.DomUtil.removeClass(map.getContainer(), "leaflet-clickable");
        map.getContainer().style.cursor = "";
        return;
      }
      const t = meta.taxa[trees.taxon[i]];
      const dbh = trees.dbh[i];
      tip.innerHTML = `<strong>${t.common || t.botanical}</strong><br><span class="tt-sci">${t.botanical}</span>` +
        (dbh ? `<br>${dbh} cm trunk` : "");
      tip.hidden = false;
      const p = e.containerPoint;
      const pane = el("map-pane").getBoundingClientRect();
      tip.style.left = Math.min(p.x + 12, pane.width - tip.offsetWidth - 8) + "px";
      tip.style.top = Math.max(4, p.y - tip.offsetHeight - 10) + "px";
      map.getContainer().style.cursor = "pointer";
    });
  });

  map.on("mouseout", () => {
    tip.hidden = true;
  });
  map.on("moveend zoomend", writeHash);
}

function setupControls() {
  // Colour mode
  document.querySelectorAll("#colour-mode .seg-btn").forEach((b) =>
    b.addEventListener("click", () => setColourMode(b.dataset.mode))
  );

  // Origin chips
  document.querySelectorAll('[data-group="origin"]').forEach((chip) =>
    chip.addEventListener("click", () => {
      const on = chip.dataset.active === "true";
      chip.dataset.active = String(!on);
      if (on) state.origin.delete(chip.dataset.value);
      else state.origin.add(chip.dataset.value);
      applyFilters();
    })
  );

  // Genus / species level
  document.querySelectorAll("#taxon-level .seg-btn").forEach((b) =>
    b.addEventListener("click", () => {
      state.taxonLevel = b.dataset.level;
      document.querySelectorAll("#taxon-level .seg-btn").forEach((x) =>
        x.setAttribute("aria-checked", String(x.dataset.level === state.taxonLevel))
      );
      // Selections are keyed per level, so switching level clears them rather than
      // silently filtering by something no longer on screen.
      state.selectedTaxa.clear();
      renderTaxonList();
      applyFilters();
      renderTaxaTable();
    })
  );

  let searchTimer = null;
  el("taxon-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderTaxonList, 120);
  });

  el("taxon-clear").addEventListener("click", () => {
    state.selectedTaxa.clear();
    state.compare = [];
    if (state.colourMode === "compare") {
      recomputeColours();
      renderLegend();
    }
    renderTaxonList();
    applyFilters();
  });

  // Trunk diameter range
  const minEl = el("range-min");
  const maxEl = el("range-max");
  const bins = meta.dbh_histogram.bins;
  const top = bins.length ? bins[bins.length - 1][0] + meta.dbh_histogram.bin_width : 200;
  [minEl, maxEl].forEach((input) => {
    input.min = 0;
    input.max = top;
    input.step = 1;
  });
  minEl.value = 0;
  maxEl.value = top;
  state.dbhMin = 0;
  state.dbhMax = 300; // the stored cap, so "max" really does include the biggest trees

  const onRange = () => {
    let lo = Number(minEl.value);
    let hi = Number(maxEl.value);
    if (lo > hi) [lo, hi] = [hi, lo];
    minEl.value = lo;
    maxEl.value = hi;
    state.dbhMin = lo;
    state.dbhMax = hi >= top ? 300 : hi;
    renderDbhControls();
    applyFilters();
  };
  minEl.addEventListener("input", onRange);
  maxEl.addEventListener("input", onRange);

  el("dbh-include-unknown").addEventListener("change", (e) => {
    state.dbhIncludeUnknown = e.target.checked;
    applyFilters();
  });
  el("dbh-unknown-count").textContent = fmt.format(meta.summary.missing_dbh_count);

  // Ward
  const wardSelect = el("ward-select");
  meta.wards.forEach((w) => {
    const opt = document.createElement("option");
    opt.value = w.ward;
    opt.textContent = `${w.ward_name} (${w.ward})`;
    wardSelect.appendChild(opt);
  });
  wardSelect.addEventListener("change", () => {
    state.ward = wardSelect.value;
    el("ward-clear").hidden = !state.ward;
    renderWardStats();
    applyFilters();
    if (state.ward && wardLayer) {
      const target = wardLayer.getLayers().find((l) => l.feature.properties.ward === state.ward);
      if (target) map.fitBounds(target.getBounds(), { padding: [20, 20] });
    }
  });
  el("ward-clear").addEventListener("click", () => {
    wardSelect.value = "";
    wardSelect.dispatchEvent(new Event("change"));
  });

  // Ward boundaries
  el("layer-wards").addEventListener("change", (e) => {
    if (e.target.checked) loadWardLayer();
    else if (wardLayer) map.removeLayer(wardLayer);
  });

  el("tree-card-close").addEventListener("click", () => selectTree(-1));

  // Mobile bottom sheet
  const panel = el("panel");
  panel.dataset.open = "false";
  el("panel-toggle").addEventListener("click", () => {
    const open = panel.dataset.open === "true";
    panel.dataset.open = String(!open);
    el("panel-toggle").setAttribute("aria-expanded", String(!open));
  });
  el("panel-hide").addEventListener("click", () => {
    panel.dataset.open = "false";
    el("panel-toggle").setAttribute("aria-expanded", "false");
  });

  // Follow the OS theme: the palette lives in CSS, so re-read it and redraw.
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const onTheme = () => {
    if (map) {
      map.removeLayer(baseLayer);
      baseLayer = makeBaseLayer();
      baseLayer.addTo(map);
      baseLayer.bringToBack();
    }
    rebuildPalette();
    recomputeColours();
    renderLegend();
    renderTaxaTable();
    if (treeLayer) treeLayer.draw();
  };
  if (dark.addEventListener) dark.addEventListener("change", onTheme);
}

async function loadWardLayer() {
  if (wardLayer) {
    wardLayer.addTo(map);
    return;
  }
  try {
    const geojson = await loadJSON(DATA + "wards.geojson");
    wardLayer = L.geoJSON(geojson, {
      style: { color: cssVar("--text-primary"), weight: 1, opacity: 0.35, fill: false },
      interactive: false,
    }).addTo(map);
    wardLayer.bringToFront();
  } catch (err) {
    showLoadError(`Couldn't load ward boundaries: ${err.message}`);
    el("layer-wards").checked = false;
  }
}

let baseLayer = null;
function makeBaseLayer() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const source = basemapSource(dark);
  return L.tileLayer(source.url, {
    attribution: source.attribution,
    maxZoom: 19,
    maxNativeZoom: source.maxNativeZoom,
    detectRetina: true,
  });
}

/* ------------------------------------------------------------------ boot ---------------- */

async function main() {
  const badge = el("loading-badge");
  const badgeText = el("loading-text");

  try {
    meta = await loadJSON(DATA + "trees.meta.json");
  } catch (err) {
    badge.hidden = true;
    showLoadError(
      "Couldn't load the tree data. If you're running this locally, the site needs the " +
      "pipeline to have been run first (see the README)."
    );
    return;
  }

  trees.n = meta.tree_count;
  el("last-updated").textContent =
    `${fmt.format(meta.tree_count)} trees · City inventory updated ${String(meta.city_last_refreshed).slice(0, 10)}`;

  // Set the map up before the columns land, so there's something to look at.
  const hash = readHash();
  baseLayer = makeBaseLayer();
  map = L.map("map", {
    center: (hash && hash.center) || TORONTO_CENTER,
    zoom: (hash && hash.zoom) || DEFAULT_ZOOM,
    minZoom: 10,
    maxZoom: 19,
    layers: [baseLayer],
    preferCanvas: true,
    worldCopyJump: false,
  });
  L.control.scale({ imperial: false }).addTo(map);

  try {
    badgeText.textContent = "Loading 690,000 trees…";
    const [coords, taxon, dbh] = await Promise.all([
      loadColumn(meta.columns["coords.u32"].file, Uint32Array),
      loadColumn(meta.columns["taxon.u16"].file, Uint16Array),
      loadColumn(meta.columns["dbh.u16"].file, Uint16Array),
    ]);
    trees._coords = coords;
    trees.taxon = taxon;
    trees.dbh = dbh;
    // The ward column is tiny and the ward filter is a headline control, so it comes
    // with the first wave rather than the detail wave.
    trees.ward = await loadColumn(meta.columns["ward.u8"].file, Uint8Array);
  } catch (err) {
    badge.hidden = true;
    showLoadError(`Couldn't load the tree data: ${err.message}`);
    return;
  }

  badgeText.textContent = "Indexing…";
  // Yield once so the badge actually paints before the synchronous build work.
  await new Promise((r) => setTimeout(r, 0));

  buildProjection();
  buildIndex();
  buildTaxonLookups();
  visible = new Uint8Array(trees.n);
  colourIdx = new Uint8Array(trees.n);

  rebuildPalette();
  recomputeColours();

  treeLayer = new TreeLayer();
  treeLayer.addTo(map);

  setupControls();
  setupMapInteraction();
  renderDbhControls();
  renderLegend();
  renderTaxonList();
  applyFilters();
  renderWardStats();
  badge.hidden = true;

  // The address columns only matter once something is clicked, so they load last and
  // don't hold up the first paint.
  try {
    const [addr, street, cross1, cross2] = await Promise.all([
      loadColumn(meta.columns["addr.u16"].file, Uint16Array),
      loadColumn(meta.columns["street.u16"].file, Uint16Array),
      loadColumn(meta.columns["cross1.u16"].file, Uint16Array),
      loadColumn(meta.columns["cross2.u16"].file, Uint16Array),
    ]);
    trees.addr = addr;
    trees.street = street;
    trees.cross1 = cross1;
    trees.cross2 = cross2;
    trees.details = true;
    if (state.selectedTree >= 0) renderTreeCard(state.selectedTree);
  } catch (err) {
    // Not fatal: the map and every filter work without street names.
    console.warn("Address columns unavailable:", err);
  }

  if (hash && hash.tree) {
    const i = findTreeNear(hash.tree[0], hash.tree[1]);
    if (i >= 0) selectTree(i);
  }
}

main();
