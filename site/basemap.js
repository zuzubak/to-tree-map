/* Basemap tiles, shared by the tree map and the analysis pages.
 *
 * CARTO's grey canvas, deliberately desaturated -- the right backdrop for maps whose
 * whole payload is colour.
 *
 * The key handling is the fiddly part, and the reason this is one module rather than a
 * copy per page. CARTO answers unauthenticated requests with an "API KEY REQUIRED"
 * watermark tile (HTTP 200, normal-looking PNG, so it fails silently), and the keyed
 * endpoint is a different shape: under rastertiles/, takes ?key=, and has no {s}
 * subdomain. config.js sets the key and is written at deploy time from a repo secret.
 *
 * With no key we fall back to Esri's keyless grey canvas rather than to a watermarked
 * CARTO, so `python -m http.server` in site/ gives a working map with no setup. Esri
 * only serves real tiles to zoom 16, hence the per-source native zoom.
 */
(function (global) {
  "use strict";

  const ESRI = {
    light: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    dark: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  };
  const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  /* CARTO serves real raster tiles to z20, so that's where maps using it stop -- going
   * further would only upscale, which is what made the old Esri basemap go grainy
   * past z16. */
  const MAX_ZOOM = 20;

  function source(dark) {
    const key = (global.CARTO_API_KEY || "").trim();
    if (key) {
      return {
        url: "https://basemaps.cartocdn.com/rastertiles/" + (dark ? "dark_all" : "light_all") +
             "/{z}/{x}/{y}{r}.png?key=" + encodeURIComponent(key),
        attribution: 'Basemap &copy; <a href="https://carto.com/attributions">CARTO</a>, ' + OSM,
        maxNativeZoom: 20,
      };
    }
    return {
      url: dark ? ESRI.dark : ESRI.light,
      attribution: 'Basemap &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, ' + OSM,
      maxNativeZoom: 16,
    };
  }

  /* credit: what the page's own data should be attributed to, appended after the
   * basemap's own credit. */
  function layer({ dark, credit = "" } = {}) {
    const src = source(dark);
    return L.tileLayer(src.url, {
      attribution: src.attribution + (credit ? " &middot; " + credit : ""),
      // detectRetina fetches @2x tiles one zoom level deeper, and pays for it by
      // decrementing the layer's own maxZoom. Left at MAX_ZOOM that silently puts the
      // deepest zoom above the layer's ceiling and the basemap disappears entirely, so
      // the layer is given one level of headroom to give back.
      maxZoom: MAX_ZOOM + 1,
      maxNativeZoom: src.maxNativeZoom,
      detectRetina: true,
    });
  }

  global.Basemap = { layer, MAX_ZOOM };
})(window);
