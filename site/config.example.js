/* Copy to site/config.js for local development and paste in a CARTO basemap key.
 *
 * site/config.js is gitignored and written at deploy time from the CARTO_API_KEY repo
 * secret (see .github/workflows/refresh.yml). Without it the map falls back to Esri's
 * keyless grey canvas, so local development works with no key at all.
 *
 * This key is not a credential in the usual sense -- the browser has to send it, so it is
 * public on every tile request. Restrict it by domain in the CARTO dashboard rather than
 * trying to keep the value hidden.
 */
window.CARTO_API_KEY = "";
