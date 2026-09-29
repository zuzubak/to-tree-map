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
      maxNativeZoom: 20,
    };
  }
  return { url: dark ? ESRI.dark : ESRI.light, attribution: ESRI_ATTRIBUTION, maxNativeZoom: 16 };
}

const TORONTO_CENTER = [43.7, -79.38];
const DEFAULT_ZOOM = 11;
/* CARTO serves real raster tiles to z20, so that's where the map stops -- going further
 * would only upscale, which is what made the old Esri basemap go grainy past z16. */
const MAX_ZOOM = 20;

/* Above this zoom, trees are drawn as circles scaled by trunk diameter; below it, as
 * 1-2 px dots in a pixel buffer. The crossover is where a viewport holds few enough
 * trees that per-circle path work is cheaper than it is noticeable. */
const CIRCLE_ZOOM = 15;

/* Colour slots, read from CSS so light/dark and the palette live in one place. */
const SLOT_VARS = {
  native: "--series-native",
  nativeEasternNa: "--series-native-ena",
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
  origin: new Set(["native", "native_eastern_na", "non_native", "invasive", "unknown"]),
  selectedTaxa: new Set(),   // genus names or species keys, per taxonLevel
  compare: [],               // ordered, max COMPARE_LIMIT
  dbhMin: 0,
  dbhMax: 200,
  dbhIncludeUnknown: true,
  wards: new Set(),   // every ward code, populated once the metadata lands
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
    originClass[i] = t.native === "native" ? 1
      : t.native === "native_eastern_na" ? (t.invasive ? 4 : 2)
      : t.invasive ? 4
      : t.native === "non_native" ? 3
      : 0;
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
    state.origin.has("native_eastern_na"),
    state.origin.has("non_native"),
    state.origin.has("invasive"),
  ];
  const { dbhMin, dbhMax, dbhIncludeUnknown } = state;
  const wards = state.wards;
  // A tree the City left without a ward survives only while every ward is ticked, so
  // "all wards" still means everything and narrowing never silently includes strays.
  const allWards = wards.size === meta.wards.length;

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
    const w = ward[i];
    if (w === 0 ? !allWards : !wards.has(w)) continue;
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
    css = [SLOT_VARS.unknown, SLOT_VARS.native, SLOT_VARS.nativeEasternNa,
           SLOT_VARS.introduced, SLOT_VARS.invasive].map(cssVar);
    palette.labels = ["Not identified to species", "Native to Ontario",
                      "Native to eastern North America", "Introduced", "Introduced & invasive"];
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

/* ------------------------------------------------------------------ UI: the filter bar -- */

/* The whole bar is rendered from this table, the way the permit map renders its own, so
 * adding a filter is a one-line change and there's no second copy of the markup to drift.
 * `on` is the default state a first-time visitor sees. */
const CHIP_GROUPS = [
  {
    key: "colourMode", label: "Colour by", single: true,
    options: [
      { value: "origin", label: "Native or not", on: true },
      { value: "compare", label: "Compare species", on: false },
      { value: "dbh", label: "Trunk size", on: false },
      { value: "genus", label: "Genus", on: false },
    ],
  },
  {
    key: "origin", label: "Origin",
    options: [
      { value: "native", label: "Native to Ontario", on: true, swatch: "var(--series-native)" },
      { value: "native_eastern_na", label: "Native to eastern N. America", on: true, swatch: "var(--series-native-ena)" },
      { value: "non_native", label: "Introduced", on: true, swatch: "var(--series-introduced)" },
      { value: "invasive", label: "Invasive", on: true, swatch: "var(--series-invasive)" },
      { value: "unknown", label: "Not identified to species", on: true, swatch: "var(--series-unknown)" },
    ],
  },
  {
    key: "taxonLevel", label: "Species &amp; genus", single: true,
    options: [
      { value: "genus", label: "By genus", on: true },
      { value: "species", label: "By species", on: false },
    ],
  },
];

const el = (id) => document.getElementById(id);
let map = null;
let treeLayer = null;
let wardLayer = null;
let visibleCount = 0;
let openPopup = null;

function chip(label, active, swatch) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "filter-chip";
  b.dataset.active = String(active);
  if (swatch) {
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = swatch;
    b.appendChild(sw);
  }
  b.appendChild(document.createTextNode(label));
  return b;
}

function renderFilterBar() {
  const bar = el("filter-bar");
  bar.textContent = "";

  for (const group of CHIP_GROUPS) {
    const wrap = document.createElement("div");
    wrap.className = "filter-group";
    const label = document.createElement("span");
    label.className = "filter-group-label";
    label.innerHTML = group.label;
    wrap.appendChild(label);

    for (const opt of group.options) {
      const active = group.single
        ? state[group.key] === opt.value
        : state[group.key].has(opt.value);
      const b = chip(opt.label, active, opt.swatch);
      b.addEventListener("click", () => onChip(group, opt, b));
      wrap.appendChild(b);
    }
    bar.appendChild(wrap);
  }

  renderTaxonPicker(bar);
  renderDbhFilter(bar);
  renderWardFilter(bar);

  const layers = document.createElement("div");
  layers.className = "filter-group";
  const ll = document.createElement("span");
  ll.className = "filter-group-label";
  ll.textContent = "Layers";
  const wardChip = chip("Ward boundaries", false);
  wardChip.addEventListener("click", () => {
    const on = wardChip.dataset.active === "true";
    wardChip.dataset.active = String(!on);
    if (!on) loadWardLayer();
    else if (wardLayer) map.removeLayer(wardLayer);
  });
  layers.append(ll, wardChip);
  bar.appendChild(layers);
}

function onChip(group, opt, button) {
  if (group.single) {
    state[group.key] = opt.value;
    button.parentElement.querySelectorAll(".filter-chip").forEach((b, i) => {
      b.dataset.active = String(group.options[i].value === opt.value);
    });
    if (group.key === "colourMode") {
      setColourMode(opt.value);
      return;
    }
    if (group.key === "taxonLevel") {
      // Selections are keyed per level, so switching clears them rather than
      // silently filtering by something no longer on screen.
      state.selectedTaxa.clear();
      renderTaxonList();
      applyFilters();
      return;
    }
  } else {
    const on = button.dataset.active === "true";
    button.dataset.active = String(!on);
    if (on) state[group.key].delete(opt.value);
    else state[group.key].add(opt.value);
    applyFilters();
  }
}

/* ---- species / genus picker ---- */

function renderTaxonPicker(container) {
  const block = document.createElement("div");
  block.className = "ward-filter";
  block.innerHTML =
    '<div class="ward-filter-head">' +
      '<span class="filter-group-label">Pick species or genus</span>' +
      '<span class="ward-actions"><button type="button" class="link-btn" id="taxon-clear">Clear</button></span>' +
    '</div>' +
    '<input type="search" class="taxon-search" id="taxon-search" autocomplete="off" ' +
      'placeholder="Search maple, oak, Quercus&hellip;" aria-label="Search species or genus">' +
    '<div class="taxon-list" id="taxon-list" role="group" aria-label="Species and genus"></div>';
  container.appendChild(block);

  let timer = null;
  el("taxon-search").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(renderTaxonList, 120);
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
  renderTaxonList();
}

/* The list doubles as the filter and, in compare mode, the colour picker -- so the rows
 * carry a checkbox in filter mode and a swatch in compare mode. */
function renderTaxonList() {
  const query = (el("taxon-search").value || "").trim().toLowerCase();
  const level = state.taxonLevel;
  const source = level === "genus" ? meta.genera : meta.species;
  const list = el("taxon-list");
  const comparing = state.colourMode === "compare";

  const rows = source
    .filter((r) => {
      const key = level === "genus" ? r.genus : r.key;
      if (!key) return false; // trees with no identification have nothing to filter on
      if (!query) return true;
      return (r.label || "").toLowerCase().includes(query) || key.toLowerCase().includes(query);
    })
    .slice(0, 400);

  list.textContent = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "taxon-empty";
    empty.textContent = `Nothing matches “${query}”.`;
    list.appendChild(empty);
    return;
  }

  for (const r of rows) {
    const key = level === "genus" ? r.genus : r.key;
    const slot = comparing ? state.compare.findIndex((c) => c.key === key && c.level === level) : -1;
    const selected = comparing ? slot >= 0 : state.selectedTaxa.has(key);

    const row = document.createElement("button");
    row.type = "button";
    row.className = "taxon-row";
    row.setAttribute("aria-selected", String(selected));

    if (comparing) {
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = slot >= 0 ? palette.css[slot + 1] : "transparent";
      sw.style.boxShadow = "0 0 0 1px var(--border)";
      row.appendChild(sw);
    } else {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = selected;
      box.tabIndex = -1;
      row.appendChild(box);
    }

    const name = document.createElement("span");
    name.className = "taxon-name";
    name.textContent = r.label || key;
    const sci = document.createElement("span");
    sci.className = "taxon-sci";
    sci.textContent = " " + key;
    name.appendChild(sci);
    if (r.invasive) name.appendChild(document.createTextNode(" · invasive"));
    else if (r.native === "native") name.appendChild(document.createTextNode(" · native"));

    const count = document.createElement("span");
    count.className = "taxon-count";
    count.textContent = fmtCompact.format(r.count);

    row.append(name, count);
    row.addEventListener("click", () => onTaxonClick(key, r));
    list.appendChild(row);
  }
}

function onTaxonClick(key, row) {
  const level = state.taxonLevel;
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

/* ---- trunk diameter ---- */

function renderDbhFilter(container) {
  const bins = meta.dbh_histogram.bins;
  const top = bins.length ? bins[bins.length - 1][0] + meta.dbh_histogram.bin_width : 200;

  const block = document.createElement("div");
  block.className = "date-filter";
  block.innerHTML =
    '<div class="filter-group-label">Trunk diameter</div>' +
    '<div class="histogram" id="histogram"></div>' +
    '<div class="range-slider"><div class="range-track"></div>' +
      '<div class="range-fill" id="range-fill"></div>' +
      `<input type="range" id="range-min" class="range-input" min="0" max="${top}" step="1" value="0" aria-label="Minimum trunk diameter">` +
      `<input type="range" id="range-max" class="range-input" min="0" max="${top}" step="1" value="${top}" aria-label="Maximum trunk diameter">` +
    '</div>' +
    '<div class="range-labels"><span id="range-label-min"></span><span id="range-label-max"></span></div>' +
    '<label class="check-row"><input type="checkbox" id="dbh-include-unknown" checked>' +
      `<span>Include the ${fmt.format(meta.summary.missing_dbh_count)} trees with no diameter recorded</span></label>`;
  container.appendChild(block);

  const minEl = el("range-min");
  const maxEl = el("range-max");
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

  // The histogram is static; only the in/out-of-range shading changes.
  const max = Math.max(...bins.map((b) => b[1]));
  el("histogram").innerHTML = bins
    .map(([lo, count]) =>
      `<div class="histogram-bar" data-lo="${lo}" style="height:${Math.max(2, (count / max) * 100)}%" ` +
      `title="${lo}–${lo + meta.dbh_histogram.bin_width} cm: ${fmt.format(count)} trees"></div>`)
    .join("");
  renderDbhControls();
}

function renderDbhControls() {
  const maxEl = el("range-max");
  const top = Number(maxEl.max);
  const atTop = state.dbhMax >= top;
  el("range-label-min").textContent = `${state.dbhMin} cm`;
  el("range-label-max").textContent = atTop ? `${top}+ cm` : `${state.dbhMax} cm`;
  const fill = el("range-fill");
  fill.style.left = `${(state.dbhMin / top) * 100}%`;
  fill.style.right = `${100 - (Math.min(state.dbhMax, top) / top) * 100}%`;

  const width = meta.dbh_histogram.bin_width;
  el("histogram").querySelectorAll(".histogram-bar").forEach((bar) => {
    const lo = Number(bar.dataset.lo);
    const inRange = lo + width > state.dbhMin && lo <= state.dbhMax;
    bar.classList.toggle("out-of-range", !inRange);
  });
}

/* ---- wards ---- */

function renderWardFilter(container) {
  const block = document.createElement("div");
  block.className = "ward-filter";
  const head = document.createElement("div");
  head.className = "ward-filter-head";
  head.innerHTML = '<span class="filter-group-label">Wards</span><span class="ward-actions"></span>';
  const list = document.createElement("div");
  list.className = "ward-list";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "Wards");

  const wards = meta.wards.slice().sort((a, b) => b.tree_count - a.tree_count);
  for (const w of wards) {
    const code = parseInt(w.ward, 10);
    const row = document.createElement("label");
    row.className = "ward-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = state.wards.has(code);
    const name = document.createElement("span");
    name.className = "ward-name";
    name.textContent = w.ward_name;
    const count = document.createElement("span");
    count.className = "ward-count";
    count.textContent = fmt.format(w.tree_count);
    box.addEventListener("change", () => {
      if (box.checked) state.wards.add(code);
      else state.wards.delete(code);
      applyFilters();
    });
    row.append(box, name, count);
    list.appendChild(row);
  }

  const actions = head.querySelector(".ward-actions");
  for (const [text, on] of [["All", true], ["None", false]]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-btn";
    btn.textContent = text;
    btn.addEventListener("click", () => {
      state.wards.clear();
      if (on) wards.forEach((w) => state.wards.add(parseInt(w.ward, 10)));
      list.querySelectorAll("input").forEach((b) => { b.checked = on; });
      applyFilters();
    });
    actions.appendChild(btn);
  }

  block.append(head, list);
  container.appendChild(block);
}

/* ------------------------------------------------------------------ UI: popups --------- */

function streetName(id) {
  return id && meta.streets[id] ? meta.streets[id] : null;
}

/* Built the same way as the permit map's popup: a title, then label/value rows, then an
 * italic note. Same classes, so both maps get their popup styling from one stylesheet. */
function popupContent(i) {
  const t = meta.taxa[trees.taxon[i]];
  const dbh = trees.dbh[i];
  const wrap = document.createElement("div");

  const title = document.createElement("div");
  title.className = "popup-title";
  title.textContent = t.common || t.botanical;
  wrap.appendChild(title);

  const sci = document.createElement("div");
  sci.className = "popup-description";
  sci.style.marginTop = "0";
  sci.style.paddingTop = "0";
  sci.style.borderTop = "0";
  sci.textContent = t.botanical;
  wrap.appendChild(sci);

  const originLabel = t.invasive ? "Introduced & invasive"
    : t.native === "native" ? "Native to Ontario"
    : t.native === "native_eastern_na" ? "Native to eastern North America"
    : t.native === "non_native" ? "Introduced"
    : "Not identified to species";
  const originVar = t.invasive ? "--series-invasive"
    : t.native === "native" ? "--series-native"
    : t.native === "native_eastern_na" ? "--series-native-ena"
    : t.native === "non_native" ? "--series-introduced"
    : "--series-unknown";

  const badge = document.createElement("div");
  badge.className = "popup-badge";
  const sw = document.createElement("span");
  sw.className = "swatch";
  sw.style.background = cssVar(originVar);
  badge.append(sw, document.createTextNode(originLabel));
  wrap.appendChild(badge);

  // A trunk-size figure reads faster than the number alone: this trunk against the
  // thickest recorded for the same species.
  if (dbh && t.max_dbh) {
    const fig = document.createElement("div");
    fig.className = "popup-figure";
    fig.innerHTML =
      '<div class="popup-figure-bar"><div class="popup-figure-fill" style="width:' +
      Math.min(100, (dbh / t.max_dbh) * 100).toFixed(1) + '%"></div></div>' +
      '<div class="popup-figure-label">' + dbh + ' cm &middot; thickest in the inventory is ' +
      t.max_dbh + ' cm</div>';
    wrap.appendChild(fig);
  }

  const addr = trees.details
    ? [trees.addr[i] || null, streetName(trees.street[i])].filter(Boolean).join(" ")
    : "";
  const crosses = trees.details
    ? [streetName(trees.cross1[i]), streetName(trees.cross2[i])].filter(Boolean)
    : [];
  const ward = meta.wards.find((w) => parseInt(w.ward, 10) === trees.ward[i]);

  const rows = [
    ["Address", addr || (trees.details ? "Not recorded" : "Loading…")],
    ["Between", crosses.length ? crosses.join(" and ") : null],
    ["Ward", ward ? `${ward.ward_name} (${ward.ward})` : null],
    ["Trunk diameter", dbh ? `${dbh} cm` : "Not recorded"],
    ["Origin", t.origin || null],
    ["Typical for species", t.mean_dbh ? `${t.mean_dbh} cm mean trunk` : null],
    ["Trees of this kind", `${fmt.format(t.count)} citywide`],
    ["Record", t.basis === "genus" ? "Identified to genus only" : null],
  ];

  for (const [k, v] of rows) {
    if (v === null || v === undefined || v === "") continue;
    const row = document.createElement("div");
    row.className = "popup-row";
    const kEl = document.createElement("span");
    kEl.className = "k";
    kEl.textContent = k;
    const vEl = document.createElement("span");
    vEl.className = "v";
    vEl.textContent = v;
    row.append(kEl, vEl);
    wrap.appendChild(row);
  }

  if (t.notes) {
    const note = document.createElement("div");
    note.className = "popup-description";
    note.textContent = t.notes + ".";
    wrap.appendChild(note);
  }
  return wrap;
}

/* ------------------------------------------------------------------ UI: panel ---------- */

function renderStats() {
  const s = meta.summary;
  const tiles = [
    ["Trees shown", fmtCompact.format(visibleCount)],
    ["Native to Ontario", `${s.native_pct}%`],
    ["Species", num(s.species_count)],
    ["Invasive", fmtCompact.format(s.invasive_count)],
  ];
  el("stats").innerHTML = tiles
    .map(([label, value]) =>
      `<div class="stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`)
    .join("");
}

function renderLegend() {
  const box = el("map-legend");
  const mode = state.colourMode;

  if (mode === "dbh") {
    const steps = palette.css.slice(1);
    box.innerHTML =
      '<h2>Trunk diameter</h2>' +
      `<div class="ramp-bar">${steps.map((c) => `<span style="background:${c}"></span>`).join("")}</div>` +
      '<div class="ramp-labels"><span>thin</span><span>thick</span></div>' +
      `<div class="legend-row"><span class="swatch" style="background:${palette.css[0]}"></span>` +
      '<span>No diameter recorded</span></div>';
    return;
  }

  if (mode === "compare") {
    let html = '<h2>Comparing</h2>';
    for (let i = 0; i < COMPARE_LIMIT; i++) {
      const entry = state.compare[i];
      html += `<div class="compare-slot" data-filled="${!!entry}">` +
        `<span class="swatch" style="background:${palette.css[i + 1]}"></span>` +
        `<span class="compare-name">${entry ? entry.label : "Pick one from the list above"}</span>` +
        (entry ? `<span class="compare-count">${fmtCompact.format(entry.count)}</span>` +
                 `<button type="button" class="compare-remove" data-remove="${i}" aria-label="Remove ${entry.label}">&times;</button>` : "") +
        '</div>';
    }
    html += '<p class="legend-note">Up to three at a time &mdash; three hues is the most a dot ' +
            'map can keep apart for colour-blind readers. Everything else stays grey.</p>';
    box.innerHTML = html;
    box.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", () => {
        state.compare.splice(Number(b.dataset.remove), 1);
        recomputeColours();
        renderLegend();
        renderTaxonList();
        treeLayer.draw();
      }));
    return;
  }

  // Class counts, not status counts: invasive wins the colour, so these are what the
  // chips actually filter. Order matches the palette's slots.
  const counts = mode === "origin"
    ? [meta.summary.class_unknown, meta.summary.class_native,
       meta.summary.class_native_eastern_na, meta.summary.class_introduced,
       meta.summary.class_invasive]
    : null;
  const rows = palette.labels.map((label, i) => {
    if (!label) return "";
    const count = counts ? counts[i] : (meta.genera.find((g) => g.label === label) || {}).count;
    return `<div class="legend-row"><span class="swatch" style="background:${palette.css[i]}"></span>` +
      `<span>${label}</span>` +
      (count != null ? `<span style="margin-left:auto;font-variant-numeric:tabular-nums;color:var(--text-muted);font-size:11px">${fmtCompact.format(count)}</span>` : "") +
      '</div>';
  });
  // The muted/unknown slot reads as a footnote, so it goes last.
  box.innerHTML = '<h2>Tree points</h2>' + rows.slice(1).join("") + rows[0] +
    '<div class="legend-row"><span style="color: var(--text-muted)">Point size &asymp; trunk diameter</span></div>';
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

  const selectedWards = state.wards.size && state.wards.size < meta.wards.length
    ? meta.wards.filter((w) => state.wards.has(parseInt(w.ward, 10)))
    : null;
  el("table-scope").textContent = selectedWards
    ? (selectedWards.length === 1 ? `in ${selectedWards[0].ward_name}` : `in ${selectedWards.length} wards`)
    : "citywide";

  el("taxa-table").innerHTML = ranked
    .map(({ count, row }) => {
      const colour = row.invasive ? cssVar("--series-invasive")
        : row.native === "native" ? cssVar("--series-native")
        : row.native === "native_eastern_na" ? cssVar("--series-native-ena")
        : row.native === "non_native" ? cssVar("--series-introduced")
        : cssVar("--series-unknown");
      const share = total ? ((count / total) * 100).toFixed(1) + "%" : "–";
      return '<div class="taxa-row">' +
        `<span class="swatch" style="background:${colour}"></span>` +
        `<span class="taxa-name">${row.label || row.genus || row.key}</span>` +
        `<span class="taxa-count">${fmt.format(count)}</span>` +
        `<span class="taxa-share">${share}</span></div>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ orchestration ------ */

function applyFilters() {
  clearVisible();
  visibleCount = recomputeVisible();
  // A popup pinned to a tree that no longer passes the filters would be lying.
  if (state.selectedTree >= 0 && !visible[state.selectedTree]) closePopup();
  renderStats();
  renderTaxaTable();
  if (treeLayer) treeLayer.draw();
  writeHash();
}

function setColourMode(mode) {
  state.colourMode = mode;
  rebuildPalette();
  recomputeColours();
  renderLegend();
  if (mode === "compare" && !state.compare.length) {
    // Open on the three most common genera, so the mode is never an empty grey map.
    state.compare = meta.genera.slice(0, COMPARE_LIMIT).map((g) => ({
      key: g.genus, level: "genus", label: g.label, count: g.count,
    }));
    if (state.taxonLevel !== "genus") {
      state.taxonLevel = "genus";
      renderFilterBar();
    }
    recomputeColours();
    renderLegend();
  }
  renderTaxonList();
  if (treeLayer) treeLayer.draw();
  writeHash();
}

/* ------------------------------------------------------------------ permalink ----------- */

/* #z/lat/lon, optionally &t=lat,lon for a selected tree and &c=<mode> for the colouring.
 * The selected tree is addressed by position rather than row number: row numbers shift
 * every time the City republishes the inventory, coordinates don't. */
function writeHash() {
  if (!map) return;
  const c = map.getCenter();
  let hash = `#${map.getZoom()}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`;
  if (state.colourMode !== "origin") hash += `&c=${state.colourMode}`;
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
  const mode = rest.find((p) => p.startsWith("c="));
  if (mode) out.mode = mode.slice(2);
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
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return bestDist < 4e-8 ? best : -1; // ~20 m tolerance, in degrees squared
}

/* ------------------------------------------------------------------ interaction --------- */

function closePopup() {
  state.selectedTree = -1;
  if (openPopup) { map.closePopup(openPopup); openPopup = null; }
  if (treeLayer) treeLayer.draw();
}

function selectTree(i) {
  state.selectedTree = i;
  const tip = document.querySelector(".tree-tip");
  if (tip) tip.hidden = true;
  openPopup = L.popup({ autoPan: true, maxWidth: 280, closeButton: true })
    .setLatLng([trees.lat[i], trees.lon[i]])
    .setContent(popupContent(i))
    .openOn(map);
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
    else closePopup();
  });

  map.on("popupclose", (e) => {
    if (e.popup === openPopup) {
      openPopup = null;
      state.selectedTree = -1;
      treeLayer.draw();
      writeHash();
    }
  });

  let rafPending = false;
  map.on("mousemove", (e) => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      // An open popup already names the tree, so the hover readout would just be a
      // second copy of its heading sitting on top of it.
      const i = openPopup ? -1 : treeLayer.hitTest(map.latLngToLayerPoint(e.latlng), tolerance());
      if (i < 0) {
        tip.hidden = true;
        map.getContainer().style.cursor = openPopup ? "pointer" : "";
        return;
      }
      const t = meta.taxa[trees.taxon[i]];
      const dbh = trees.dbh[i];
      tip.innerHTML = `<strong>${t.common || t.botanical}</strong><br>` +
        `<span class="tree-tip-sci">${t.botanical}</span>` + (dbh ? `<br>${dbh} cm trunk` : "");
      tip.hidden = false;
      const p = e.containerPoint;
      const pane = el("map-pane").getBoundingClientRect();
      tip.style.left = Math.min(p.x + 12, pane.width - tip.offsetWidth - 8) + "px";
      tip.style.top = Math.max(4, p.y - tip.offsetHeight - 10) + "px";
      map.getContainer().style.cursor = "pointer";
    });
  });

  map.on("mouseout", () => { tip.hidden = true; });
  map.on("moveend zoomend", writeHash);
}

/* Mobile bottom sheet, ported from to-multiplex-map.
 *
 * Draggable via pointer events (mouse + touch in one API). Three snap states --
 * minimized (just the handle), collapsed (the default peek), expanded (full filter
 * access) -- so dragging down from the default has somewhere smaller to land instead of
 * springing back. No-op on desktop, where the panel is a plain sidebar.
 *
 * Taps use a native "click" listener rather than measuring pointer movement: browsers
 * already suppress click after a real drag, which is a far more reliable tap/drag
 * distinction on touch hardware than a hand-rolled pixel threshold.
 *
 * The heights come from window.innerHeight, not CSS vh: on mobile browsers vh is pinned
 * to the LARGEST viewport (as if the address bar were hidden), so a vh-sized sheet
 * overflows the real viewport whenever the address bar is showing.
 */
const PANEL_MINIMIZED_PX = 56;
const PANEL_COLLAPSED_VH = 0.42;
const PANEL_EXPANDED_VH = 0.82;
const DRAG_MOVE_THRESHOLD = 6;

function setupPanel() {
  const panel = el("panel");
  const toggle = el("panel-toggle");
  const hideBtn = el("panel-hide");
  const isMobile = () => window.matchMedia("(max-width: 860px)").matches;

  function targetHeight(state) {
    const vh = window.innerHeight;
    if (state === "minimized") return PANEL_MINIMIZED_PX;
    if (state === "expanded") return vh * PANEL_EXPANDED_VH;
    return vh * PANEL_COLLAPSED_VH;
  }

  function setState(state) {
    panel.dataset.state = state;
    toggle.setAttribute("aria-expanded", String(state === "expanded"));
    // Desktop's sidebar is full-height CSS, not state-driven -- an inline max-height
    // would clamp it regardless of viewport width (inline styles aren't scoped by media
    // query), so only touch it on mobile.
    if (isMobile() && !panel.classList.contains("dragging")) {
      panel.style.maxHeight = `${targetHeight(state)}px`;
    } else if (!isMobile()) {
      panel.style.maxHeight = "";
    }
    if (map) {
      map.invalidateSize();
      if (treeLayer) treeLayer.draw();
    }
  }

  setState("collapsed");
  window.addEventListener("resize", () => {
    if (!panel.classList.contains("dragging")) setState(panel.dataset.state);
  });
  hideBtn.addEventListener("click", () => setState("minimized"));

  let dragging = false;
  let startY = 0;
  let startHeight = 0;
  let moved = false;
  let lastHeight = 0;
  // Touch input suppresses the click that would otherwise follow a drag; a mouse does
  // not, so a drag with one (a narrow desktop window) would snap the sheet and then
  // immediately toggle it back. Swallow exactly one click after a real drag.
  let swallowClick = false;

  toggle.addEventListener("pointerdown", (e) => {
    if (!isMobile()) return;
    dragging = true;
    moved = false;
    startY = e.clientY;
    startHeight = panel.getBoundingClientRect().height;
    lastHeight = startHeight;
    panel.classList.add("dragging");
    panel.style.maxHeight = "none";
    try {
      toggle.setPointerCapture(e.pointerId);
    } catch (err) {
      // Non-fatal: pointer capture keeps tracking if the finger slides off the handle,
      // but the drag math below works without it.
    }
  });

  toggle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const deltaY = startY - e.clientY;
    if (Math.abs(deltaY) > DRAG_MOVE_THRESHOLD) moved = true;
    const vh = window.innerHeight;
    // Capped just above the expanded target so an enthusiastic drag can't overshoot into
    // something that reads as "fullscreen with no escape".
    const maxHeight = vh * PANEL_EXPANDED_VH + 24;
    lastHeight = Math.min(maxHeight, Math.max(PANEL_MINIMIZED_PX, startHeight + deltaY));
    panel.style.height = `${lastHeight}px`;
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("dragging");
    panel.style.height = "";
    panel.style.maxHeight = "";
    if (!moved) return; // plain tap: the click listener below handles it
    swallowClick = true;

    const vh = window.innerHeight;
    const collapsedPx = vh * PANEL_COLLAPSED_VH;
    const expandedPx = vh * PANEL_EXPANDED_VH;
    if (lastHeight < (PANEL_MINIMIZED_PX + collapsedPx) / 2) setState("minimized");
    else if (lastHeight < (collapsedPx + expandedPx) / 2) setState("collapsed");
    else setState("expanded");
  }

  toggle.addEventListener("pointerup", endDrag);
  toggle.addEventListener("pointercancel", endDrag);
  toggle.addEventListener("click", () => {
    if (swallowClick) { swallowClick = false; return; }
    if (!isMobile()) return;
    setState(panel.dataset.state === "expanded" ? "collapsed" : "expanded");
  });

  // Follow the OS theme: the palette lives in CSS, so re-read it and redraw.
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const onTheme = () => {
    if (map && baseLayer) {
      map.removeLayer(baseLayer);
      baseLayer = makeBaseLayer();
      baseLayer.addTo(map);
      baseLayer.bringToBack();
    }
    rebuildPalette();
    recomputeColours();
    renderLegend();
    renderTaxaTable();
    renderTaxonList();
    if (treeLayer) treeLayer.draw();
  };
  if (dark.addEventListener) dark.addEventListener("change", onTheme);
}

async function loadWardLayer() {
  if (wardLayer) { wardLayer.addTo(map); wardLayer.bringToFront(); return; }
  try {
    const geojson = await loadJSON(DATA + "wards.geojson");
    wardLayer = L.geoJSON(geojson, {
      style: { color: cssVar("--text-primary"), weight: 1, opacity: 0.35, fill: false },
      interactive: false,
    }).addTo(map);
    wardLayer.bringToFront();
  } catch (err) {
    showLoadError(`Couldn't load ward boundaries: ${err.message}`);
  }
}

let baseLayer = null;
function makeBaseLayer() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const source = basemapSource(dark);
  return L.tileLayer(source.url, {
    attribution: source.attribution,
    // detectRetina fetches @2x tiles one zoom level deeper, and pays for it by
    // decrementing the layer's own maxZoom. Left at MAX_ZOOM that silently puts the
    // deepest zoom above the layer's ceiling and the basemap disappears entirely, so
    // the layer is given one level of headroom to give back.
    maxZoom: MAX_ZOOM + 1,
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
  meta.wards.forEach((w) => state.wards.add(parseInt(w.ward, 10)));

  const hash = readHash();
  if (hash && hash.mode) state.colourMode = hash.mode;

  baseLayer = makeBaseLayer();
  map = L.map("map", {
    center: (hash && hash.center) || TORONTO_CENTER,
    zoom: (hash && hash.zoom) || DEFAULT_ZOOM,
    minZoom: 10,
    maxZoom: MAX_ZOOM,
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
  await new Promise((r) => setTimeout(r, 0)); // let the badge paint before the sync work

  buildProjection();
  buildIndex();
  buildTaxonLookups();
  visible = new Uint8Array(trees.n);
  colourIdx = new Uint8Array(trees.n);

  rebuildPalette();
  recomputeColours();

  treeLayer = new TreeLayer();
  treeLayer.addTo(map);

  renderFilterBar();
  renderLegend();
  setupPanel();
  setupMapInteraction();
  applyFilters();
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
    if (state.selectedTree >= 0) {
      const i = state.selectedTree;
      closePopup();
      selectTree(i); // reopen, now that it can show an address
    }
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
