/* Reader reports for the Toronto street tree map.
 *
 *   POST /report             a report from the popup form (CORS, Turnstile, rate-limited)
 *   GET  /place              where a corrected address puts the dot (CORS)
 *   GET  /review/<id>?t=sig  the review page the email links to
 *   POST /review/<id>        approve (with edits), deny, or close
 *   GET  /corrections        every approved correction and how it reconciled at the last build
 *
 * Approving appends a row to dbt/seeds/tree_corrections.csv through the GitHub API. That
 * push to master is what rebuilds and redeploys the map; see .github/workflows/refresh.yml.
 * corrections/dev_server.py implements the same routes for localhost.
 */

const KINDS = new Set(["remove", "species", "dbh", "address", "other", "add"]);
const APPLY_KINDS = ["remove", "species", "dbh", "address"];
const SEED_COLS = [
  "correction_id", "struct_id", "kind", "approved_at",
  "snap_botanical", "snap_dbh_cm", "snap_address", "snap_street", "snap_lon", "snap_lat",
  "new_botanical", "new_dbh_cm", "new_address", "new_street", "new_lon", "new_lat", "new_ward",
  "snap_count", "note",
];
const KIND_LABEL = {
  remove: "No tree here", species: "Wrong species", dbh: "Wrong trunk size",
  address: "Wrong address", other: "Something else", add: "Missing tree",
};
const REASON_LABEL = { stump: "cut down (stump or empty spot)", never: "never a tree here", unsure: "not sure why" };
const PER_IP_HOUR = 20;
const PER_DAY = 300; // across everyone: a ceiling on how many emails a flood can cause

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "OPTIONS") return cors(req, env, new Response(null, { status: 204 }));
      if (path === "/report" && req.method === "POST") return cors(req, env, await postReport(req, env, url));
      if (path === "/place" && req.method === "GET") return cors(req, env, await getPlace(url));
      const m = path.match(/^\/review\/([0-9a-f]{8})$/);
      if (m && req.method === "GET") return await getReview(m[1], url, env);
      if (m && req.method === "POST") return await postReview(m[1], req, env, url);
      if (path === "/corrections") return await getCorrections(env);
      if (path === "/") return new Response("Reader reports for the Toronto street tree map.\n", { headers: { "content-type": "text/plain" } });
      return new Response("Not found\n", { status: 404 });
    } catch (err) {
      console.error(err && err.stack || err);
      return cors(req, env, json(500, { error: "something went wrong on the server" }));
    }
  },

  // Daily housekeeping.
  async scheduled(_event, env) {
    const cutoff = new Date(Date.now() - 90 * 864e5).toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE reports SET email = NULL WHERE status != 'pending' AND decided_at < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM hits WHERE at < ?").bind(Math.floor(Date.now() / 1000) - 86400),
    ]);
  },
};

/* ------------------------------------------------------------------ http helpers ----- */

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function cors(req, env, resp) {
  const origin = req.headers.get("origin");
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  if (origin && allowed.includes(origin)) {
    resp = new Response(resp.body, resp);
    resp.headers.set("access-control-allow-origin", origin);
    resp.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    resp.headers.set("access-control-allow-headers", "content-type");
    resp.headers.set("access-control-max-age", "86400");
    resp.headers.set("vary", "origin");
  }
  return resp;
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const sign = async (env, id) => (await hmacHex(env.REVIEW_SECRET, "review:" + id)).slice(0, 24);

function sameString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function newId() {
  return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ reference data --- */

// The taxa the map knows, for validating species and labelling them. Read from the live
// payload rather than bundled, so it follows each City refresh by itself.
let taxaCache = null;
async function taxa(env) {
  if (taxaCache && Date.now() - taxaCache.at < 3600e3) return taxaCache.map;
  const meta = await (await fetch(env.PUBLIC_MAP + "data/trees.meta.json", { cf: { cacheTtl: 3600 } })).json();
  const map = new Map(meta.taxa.map((t) => [t.botanical, t]));
  taxaCache = { at: Date.now(), map };
  return map;
}

/* ------------------------------------------------------------------ placement -------- */
//
// The City positions every tree at its address -- a point on the parcel, not the trunk --
// so a corrected address means a corrected position. Looked up in the City's own address
// repository, the geocoder behind map.toronto.ca, which is what the inventory was
// geocoded against.

const GEOCODER = "https://map.toronto.ca/geoservices/rest/search/rankedsearch";

async function geocode(address, street) {
  if (!address || !street) return null;
  const q = `${address} ${street}`.trim().toUpperCase();
  try {
    const resp = await fetch(GEOCODER + "?" + new URLSearchParams({ searchString: q }), { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!resp.ok) return null;
    const best = ((await resp.json()).result?.bestResult || [])[0] || {};
    if (best.matchType !== "Exact" || best.featureClass !== "Address") return null;
    const ward = /Ward: .*\((\d+)\)/.exec(best.detail || "");
    return { lat: best.latitude, lon: best.longitude, label: best.key_Desc, ward: ward ? ward[1].padStart(2, "0") : null };
  } catch {
    return null;
  }
}

function metres(a, b) {
  const dy = (b[0] - a[0]) * 111320;
  const dx = (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180);
  return Math.hypot(dx, dy);
}

/* The City's tree points sit anywhere from on the address point to 25 m off it, mostly
 * toward the curb. Where the old address resolves and the tree sat near it, the tree
 * keeps that offset from the new address point; otherwise it goes on the point itself. */
async function place(address, street, tree, fromAddress, fromStreet) {
  const [nu, old] = await Promise.all([geocode(address, street), geocode(fromAddress, fromStreet)]);
  if (!nu) return null;
  const out = { ...nu, offset: false };
  if (old && metres([old.lat, old.lon], tree) < 60 && metres([old.lat, old.lon], [nu.lat, nu.lon]) < 300) {
    Object.assign(out, { lat: nu.lat + tree[0] - old.lat, lon: nu.lon + tree[1] - old.lon, offset: true });
  }
  out.lat = +out.lat.toFixed(7);
  out.lon = +out.lon.toFixed(7);
  return out;
}

async function getPlace(url) {
  const q = url.searchParams;
  const a = q.get("address") || "", st = (q.get("street") || "").trim().slice(0, 80);
  const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
  if (!/^\d{1,6}$/.test(a) || !st || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json(400, { error: "address, street, lat and lon required" });
  }
  const fa = q.get("from_address") || "";
  const pl = await place(+a, st, [lat, lon], /^\d{1,6}$/.test(fa) ? +fa : null, q.get("from_street"));
  return json(200, pl ? { ...pl, found: true } : { found: false });
}

/* ------------------------------------------------------------------ receiving ------- */

// A City STRUCTID, or R-<report id> for a tree a reader added.
const STRUCT_RE = /^(?:[A-Z]{0,3}\d{1,8}|R-[0-9a-f]{8})$/;
const EMAIL_RE = /^[^@\s]{1,100}@[^@\s]{1,100}\.[^@\s]{2,}$/;

async function validate(body, env) {
  const kind = body.kind, tree = body.tree || {}, proposed = body.proposed || {};
  if (!KINDS.has(kind)) return [null, "unknown problem type"];
  const sid = String(tree.struct_id || "");
  if (kind !== "add" && !STRUCT_RE.test(sid)) return [null, "missing tree id"];
  const lat = Number(tree.lat), lon = Number(tree.lon);
  if (!(lat > 43.5 && lat < 43.9 && lon > -79.7 && lon < -79.1)) return [null, "position outside Toronto"];
  const email = String(body.email || "").trim().slice(0, 200) || null;
  if (email && !EMAIL_RE.test(email)) return [null, "bad email"];
  const note = String(body.note || "").trim().slice(0, 1000) || null;
  if (kind === "other" && !note) return [null, "describe the problem"];

  const s = (v, n = 80) => (v === null || v === undefined || v === "" ? null : String(v).slice(0, n));
  const i = (v) => (Number.isInteger(+v) && v !== null && v !== "" ? +v : null);

  const prop = {};
  if (kind === "remove") {
    prop.reason = ["stump", "never", "unsure"].includes(proposed.reason) ? proposed.reason : "unsure";
  } else if (kind === "species") {
    prop.unsure = !!proposed.unsure;
    prop.botanical = prop.unsure ? null : s(proposed.botanical);
    if (!prop.unsure && !(await taxa(env)).has(prop.botanical)) return [null, "unknown species"];
  } else if (kind === "dbh") {
    const d = i(proposed.dbh_cm);
    if (!d || d < 1 || d > 300) return [null, "trunk size out of range"];
    prop.dbh_cm = d;
  } else if (kind === "address") {
    const a = i(proposed.address), st = s(proposed.street);
    if (!a || !st) return [null, "address incomplete"];
    Object.assign(prop, { address: a, street: st.toUpperCase() });
    // Placed here, not trusted from the browser: the form's lookup is only a preview.
    prop.place = await place(a, st, [lat, lon], i(tree.address), s(tree.street));
  } else if (kind === "add") {
    prop.unsure = !!proposed.unsure;
    prop.botanical = prop.unsure ? null : s(proposed.botanical);
    if (!prop.unsure && !(await taxa(env)).has(prop.botanical)) return [null, "unknown species"];
    const d = i(proposed.dbh_cm);
    if (d !== null && (d < 1 || d > 300)) return [null, "trunk size out of range"];
    const a = i(proposed.address), st = s(proposed.street);
    if (!a || !st) return [null, "address incomplete"];
    // Checked here rather than trusted: the label, and the ward for the new row.
    const found = await geocode(a, st);
    const gc = proposed.genus_counts;
    Object.assign(prop, {
      dbh_cm: d, address: a, street: st.toUpperCase(),
      found: found ? found.label : null,
      ward: (found && found.ward) || (i(tree.ward) ? String(i(tree.ward)).padStart(2, "0") : null),
      genus_counts: gc && typeof gc === "object" && !Array.isArray(gc)
        ? Object.fromEntries(Object.entries(gc).slice(0, 100)
            .filter(([, v]) => Number.isInteger(v) && v >= 0 && v < 10000).map(([k, v]) => [String(k).slice(0, 40), v]))
        : null,
    });
  }

  const m = body.measured && typeof body.measured === "object" ? body.measured : null;
  return [{
    kind,
    proposed: prop,
    measured: m ? { value: Number(m.value) || null, unit: s(m.unit, 4), how: s(m.how, 8) } : null,
    note,
    tree: {
      struct_id: sid, lat, lon,
      botanical: s(tree.botanical), common: s(tree.common),
      dbh: i(tree.dbh) || 0, address: i(tree.address), street: s(tree.street), ward: i(tree.ward),
      cross: (Array.isArray(tree.cross) ? tree.cross : []).slice(0, 2).map((c) => s(c)),
      payload: s(tree.payload, 40),
      corrected: (Array.isArray(tree.corrected) ? tree.corrected : []).filter((k) => APPLY_KINDS.includes(k)).slice(0, 4),
    },
  }, null, email];
}

async function turnstileOk(token, ip, env) {
  if (!env.TURNSTILE_SECRET) return true; // local `wrangler dev` without the secret
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", String(token).slice(0, 2048));
  if (ip) form.append("remoteip", ip);
  const r = await (await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form })).json();
  return !!r.success;
}

async function postReport(req, env, url) {
  const raw = await req.text();
  if (raw.length > 16000) return json(413, { error: "report too large" });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: "bad json" }); }
  if (body.website) return json(200, { ok: true }); // honeypot: pretend, drop

  const ip = req.headers.get("cf-connecting-ip") || "";
  if (!(await turnstileOk(body.turnstile, ip, env))) return json(403, { error: "couldn't confirm you're not a bot; reload and try again" });

  const now = Math.floor(Date.now() / 1000);
  const who = (await hmacHex(env.REVIEW_SECRET, "ip:" + ip)).slice(0, 32);
  const counts = await env.DB.batch([
    env.DB.prepare("SELECT count(*) AS n FROM hits WHERE who = ? AND at > ?").bind(who, now - 3600),
    env.DB.prepare("SELECT count(*) AS n FROM hits WHERE at > ?").bind(now - 86400),
  ]);
  if (counts[0].results[0].n >= PER_IP_HOUR) return json(429, { error: "too many reports from here; try again later" });
  if (counts[1].results[0].n >= PER_DAY) return json(429, { error: "too many reports today; try again tomorrow" });

  const [clean, err, email] = await validate(body, env);
  if (err) return json(400, { error: err });

  const id = newId();
  const received = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO hits (who, at) VALUES (?, ?)").bind(who, now),
    env.DB.prepare("INSERT INTO reports (id, received, kind, struct_id, body, email) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, received, clean.kind, clean.tree.struct_id, JSON.stringify(clean), email),
  ]);
  // Additions have no tree id, so there is nothing to call a duplicate.
  const others = !clean.tree.struct_id ? 0 : (await env.DB.prepare("SELECT count(*) AS n FROM reports WHERE struct_id = ? AND status = 'pending' AND id != ?")
    .bind(clean.tree.struct_id, id).first()).n;

  const r = { ...clean, email };
  const reviewUrl = `${url.origin}/review/${id}?t=${await sign(env, id)}`;
  await sendMail(env, subject(r, await taxa(env)), await emailHtml(env, id, r, reviewUrl, others), email);
  return json(200, { ok: true });
}

async function sendMail(env, subj, html, replyTo) {
  if (!env.RESEND_API_KEY) {
    // Local `wrangler dev`: print it, review link included, instead of sending.
    console.log("[no RESEND_API_KEY] would email:", subj, "\n", (html.match(/href="([^"]*\/review\/[^"]*)"/) || [])[1]?.replace(/&amp;/g, "&"));
    return;
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [env.REVIEWER_EMAIL], subject: subj, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  // The report is already saved; a failed email is logged, not shown to the reader.
  if (!resp.ok) console.error("resend", resp.status, await resp.text());
}

/* ------------------------------------------------------------------ presentation ---- */

const where = (t) => [t.address, t.street].filter(Boolean).join(" ") || "no address";

function citySays(r) {
  const t = r.tree;
  return {
    remove: `${t.common || t.botanical}, ${t.dbh || "?"} cm`,
    species: `${t.common} (${t.botanical})`,
    dbh: t.dbh ? `${t.dbh} cm` : "not recorded",
    address: where(t),
    add: "no tree recorded at this spot",
  }[r.kind] || "";
}

function readerSays(r, tx) {
  const p = r.proposed;
  if (r.kind === "remove") return "no tree: " + REASON_LABEL[p.reason];
  if (r.kind === "species") {
    if (p.unsure) return "not this species; doesn't know which";
    const t = tx && tx.get(p.botanical);
    return `${(t && t.common) || p.botanical} (${p.botanical})`;
  }
  if (r.kind === "dbh") {
    const m = r.measured || {};
    return `${p.dbh_cm} cm` + (m.value ? ` (measured ${m.value} ${m.unit} ${m.how})` : "");
  }
  if (r.kind === "address") {
    const pl = p.place;
    return `${p.address} ${p.street}` + (pl
      ? `; dot moves ${Math.round(metres([r.tree.lat, r.tree.lon], [pl.lat, pl.lon]))} m`
      : "; not in the City's address list, place it by hand");
  }
  if (r.kind === "add") {
    const t = tx && p.botanical && tx.get(p.botanical);
    const name = p.unsure ? "species unknown" : `${(t && t.common) || p.botanical} (${p.botanical})`;
    const m = r.measured || {};
    const size = p.dbh_cm ? `${p.dbh_cm} cm` + (m.value ? ` (measured ${m.value} ${m.unit} ${m.how})` : "") : "trunk not measured";
    return `${name}, ${size}, in front of ${p.address} ${p.street}` + (p.found ? "" : " (not in the City's address list)");
  }
  return r.note || "";
}

function links(t, base) {
  const { lat, lon } = t;
  return {
    map: `${base}#19/${lat.toFixed(5)}/${lon.toFixed(5)}&t=${lat.toFixed(6)},${lon.toFixed(6)}`,
    streetview: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`,
    satellite: `https://www.google.com/maps/@${lat},${lon},40m/data=!3m1!1e3`,
  };
}

function subject(r, tx) {
  const t = r.tree;
  const title = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  if (r.kind === "add") {
    const p = r.proposed, x = p.botanical && tx.get(p.botanical);
    return `Tree report: missing tree at ${title(where(p))} (${p.unsure ? "species unknown" : (x && x.common) || p.botanical})`.slice(0, 200);
  }
  let head = `Tree report: ${KIND_LABEL[r.kind].toLowerCase()} at ${title(where(t))}`;
  if (["species", "dbh", "address"].includes(r.kind)) {
    // Common names only; the botanical ones and the measurement are in the body.
    const short = (v) => v.replace(/ \((?:measured .*|[A-Z][a-z]+ [^)]*)\)$/, "").replace(/;.*$/, "");
    head += ` (${short(citySays(r))} → ${short(readerSays(r, tx))})`;
  }
  return head.slice(0, 200);
}

/* Which tree: the City's record, or for an addition the spot the reader tapped. */
function treeRows(r, sep) {
  const t = r.tree;
  const between = t.cross.length ? ` (between ${t.cross.join(" and ")})` : "";
  if (r.kind === "add") return [["Spot", `${t.lat.toFixed(6)}, ${t.lon.toFixed(6)}`], ["Nearest tree's address", where(t) + between]];
  return [["Tree", `${t.common || t.botanical}${sep}${t.dbh || "?"} cm${sep}STRUCTID ${t.struct_id}`], ["Where", where(t) + between]];
}

async function emailHtml(env, id, r, reviewUrl, others) {
  const t = r.tree, tx = await taxa(env);
  const lk = links(t, env.PUBLIC_MAP);
  const rows = r.kind !== "other" ? [["The City says", citySays(r)], ["Reader says", readerSays(r, tx)]] : [];
  rows.push(...treeRows(r, " · "));
  if (r.note && r.kind !== "other") rows.push(["Their note", r.note]);
  if (t.corrected.length) rows.push(["Already corrected", t.corrected.join(", ") + " (the City-says values above are the City's)"]);
  rows.push(["Reply to", r.email || "(no email given)"]);
  const table = rows.map(([k, v]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#6b6a66;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join("");
  return `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111;max-width:560px">
<p style="font-size:16px;font-weight:600;margin:0 0 10px">${esc(KIND_LABEL[r.kind])}</p>
${r.kind === "other" ? `<blockquote style="margin:0 0 12px;padding-left:10px;border-left:3px solid #ddd">${esc(r.note)}</blockquote>` : ""}
<table style="border-collapse:collapse;font-size:14px">${table}</table>
${others ? `<p style="color:#b4531f">${others} other open report${others > 1 ? "s" : ""} on this tree.</p>` : ""}
<p style="margin:16px 0"><a href="${esc(reviewUrl)}" style="background:#2a78d6;color:#fff;padding:8px 16px;border-radius:5px;text-decoration:none;font-weight:600">Review</a></p>
<p style="font-size:13px"><a href="${esc(lk.streetview)}">Street View</a> · <a href="${esc(lk.satellite)}">Satellite</a> · <a href="${esc(lk.map)}">On the tree map</a></p>
<p style="font-size:12px;color:#898781">Approving or denying happens on the review page, behind a button, so a link scanner opening this email can't do either. Report ${esc(id)}.</p>
</div>`;
}

const PAGE_CSS = `
:root{color-scheme:light;--bg:#f9f9f7;--card:#fcfcfb;--text:#0b0b0b;--muted:#6b6a66;--line:#e1e0d9;--accent:#2a78d6;--warn:#b4531f;--ok:#14855e}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0d0d0d;--card:#1a1a19;--text:#fff;--muted:#a3a29a;--line:#2c2c2a;--accent:#3987e5;--warn:#e07a46;--ok:#2fb486}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}h1{font-size:20px;margin:0 0 4px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:12px 0}
table{border-collapse:collapse;width:100%}td,th{padding:5px 10px 5px 0;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th{font-weight:500;color:var(--muted);white-space:nowrap}
a{color:var(--accent)}label{display:block;margin:10px 0 4px;font-weight:500}
input,select,textarea{font:inherit;width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg);color:var(--text)}
button{font:inherit;font-weight:600;padding:8px 16px;border-radius:5px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.deny{color:var(--warn)}
.actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}.pill{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:99px;border:1px solid currentColor}
.ok{color:var(--ok)}.warn{color:var(--warn)}
@media (max-width:520px){th{white-space:normal}}
`;

function page(title, body, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );
}

/* ------------------------------------------------------------------ review ---------- */

async function loadReport(env, id) {
  const row = await env.DB.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first();
  if (!row) return null;
  return { ...JSON.parse(row.body), email: row.email, row };
}

async function getReview(id, url, env) {
  const t = url.searchParams.get("t") || "";
  const r = await loadReport(env, id);
  if (!r || !sameString(t, await sign(env, id))) return page("Not found", "<h1>No such report</h1>", 404);
  return page(`Review ${id}`, await reviewBody(env, id, r, t, ""));
}

async function reviewBody(env, id, r, token, flash) {
  const t = r.tree, row = r.row, tx = await taxa(env);
  const lk = links(t, env.PUBLIC_MAP);
  const pill = { pending: "", approved: '<span class="pill ok">approved</span>', denied: '<span class="pill warn">denied</span>',
    closed: '<span class="pill">closed, no map change</span>' }[row.status];
  const facts = [
    ["Problem", KIND_LABEL[r.kind]],
    r.kind !== "other" && ["The City says", citySays(r)],
    ["Reader says", readerSays(r, tx)],
    r.note && r.kind !== "other" && ["Their note", r.note],
    ...treeRows(r, ", "),
    t.corrected.length && ["Already corrected", t.corrected.join(", ")],
    ["Reply to", r.email || "(none)"],
    ["Received", row.received.slice(0, 16).replace("T", " ") + " UTC"],
  ].filter(Boolean);
  const rows = facts.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("");

  const others = !t.struct_id ? [] : (await env.DB.prepare("SELECT id, status FROM reports WHERE struct_id = ? AND id != ? ORDER BY received")
    .bind(t.struct_id, id).all()).results;
  const otherLinks = await Promise.all(others.map(async (o) => `<a href="/review/${o.id}?t=${await sign(env, o.id)}">${o.id}</a> (${o.status})`));
  const otherHtml = others.length ? `<p class="warn">Other reports on this tree: ${otherLinks.join(", ")}</p>` : "";

  let form;
  if (row.status !== "pending") {
    form = row.decision_note ? `<p>${esc(row.decision_note)}</p>` : "";
    if (row.commit_sha) {
      form += `<p>Committed as correction <code>${esc(row.correction_id)}</code>
(<a href="https://github.com/${env.GITHUB_REPO}/commit/${esc(row.commit_sha)}">${esc(row.commit_sha.slice(0, 7))}</a>).
The map rebuilds on its own in about five minutes: <a href="https://github.com/${env.GITHUB_REPO}/actions">watch the build</a>.</p>`;
    }
  } else {
    const p = r.proposed;
    const isAdd = r.kind === "add";
    const suggested = isAdd ? "add" : APPLY_KINDS.includes(r.kind) && !p.unsure ? r.kind : "";
    const opts = [...tx.values()].filter((x) => x.genus).sort((a, b) => b.count - a.count).map((x) =>
      `<option value="${esc(x.botanical)}"${x.botanical === p.botanical ? " selected" : ""}>${esc((x.common || x.botanical) + " (" + x.botanical + ")")}</option>`).join("");
    const choices = isAdd
      ? [["", "Don't change the map (close as handled)"], ["add", "Add the tree"]]
      : [["", "Don't change the map (close as handled)"], ["remove", "Remove the tree"], ["species", "Change the species"],
        ["dbh", "Change the trunk size"], ["address", "Change the address"]];
    const kindOpts = choices
      .map(([k, l]) => `<option value="${k}"${k === suggested ? " selected" : ""}>${esc(l)}</option>`).join("");
    // An addition goes where the reader tapped; the address only labels it.
    const pl = isAdd ? { lat: t.lat, lon: t.lon, ward: p.ward } : p.place;
    const placed = isAdd
      ? (p.found ? `${p.found} is in the City's address list.` : "That address isn't in the City's list; check it.") +
        " The blue dot is where the reader tapped: drag it onto the trunk if it's off."
      : pl
        ? `Found ${pl.label}` + (pl.offset ? ", keeping the tree's offset from its old address." : ", on its address point.")
        : "Not found in the City's address list. Look up a corrected address, or drag the blue dot into place.";
    form = `
<form method="post" action="/review/${id}">
<input type="hidden" name="t" value="${esc(token)}">
<label for="kind">Apply as</label><select name="kind" id="kind">${kindOpts}</select>
<div data-for="species add"><label for="botanical">Species</label><select name="botanical" id="botanical"><option value="">Choose…</option>${opts}</select></div>
<div data-for="dbh add"><label for="dbh">Trunk diameter, cm${isAdd ? " (optional)" : ""}</label><input name="dbh_cm" id="dbh" type="number" min="1" max="300" value="${esc(p.dbh_cm || "")}"></div>
<div data-for="address add"><label for="addr">Street number and street</label>
<div style="display:flex;gap:6px"><input name="address" id="addr" style="flex:0 0 90px" value="${esc(p.address || t.address || "")}"><input name="street" id="street" value="${esc(p.street || t.street || "")}">
<button type="button" id="lookup" style="flex:none">Look up</button></div>
<div id="placed" class="muted" style="margin:6px 0">${esc(placed)}</div>
<div id="pmap" style="height:320px;border-radius:8px;border:1px solid var(--line)"></div>
<div class="muted" style="font-size:12px;margin-top:4px">${isAdd ? "Blue: where the new tree will go. Drag it onto the trunk if you can see it." : "Grey: where the City has it. Blue: where it will go. Drag the blue dot onto the tree if you can see it."}</div>
<input type="hidden" name="new_lat" id="new_lat" value="${pl ? pl.lat : ""}"><input type="hidden" name="new_lon" id="new_lon" value="${pl ? pl.lon : ""}">
<input type="hidden" name="new_ward" id="new_ward" value="${esc((pl && pl.ward) || "")}"></div>
<label for="note">Public note <span class="muted">(goes in the repo; optional)</span></label>
<input name="note" id="note" maxlength="200" placeholder="e.g. stump visible on Street View, Aug 2025">
<div class="actions"><button class="primary" name="action" value="approve">Approve</button>
<button class="deny" name="action" value="deny">Deny</button></div>
</form>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const $=(id)=>document.getElementById(id);
const city=[${t.lat},${t.lon}];
const isAdd=${isAdd};
const from=${JSON.stringify({ address: t.address || "", street: t.street || "" }).replace(/</g, "\\u003c")};
let pmap=null,marker=null;
function setPoint(ll,pan){$('new_lat').value=ll[0].toFixed(7);$('new_lon').value=ll[1].toFixed(7);
  if(!marker){marker=L.marker(ll,{draggable:true,icon:L.divIcon({className:'',html:'<div style="width:16px;height:16px;border-radius:50%;background:#2a78d6;border:2px solid #fff;box-shadow:0 0 0 1px #2a78d6"></div>',iconSize:[16,16],iconAnchor:[8,8]})}).addTo(pmap);
    marker.on('dragend',()=>{const p=marker.getLatLng();$('new_lat').value=p.lat.toFixed(7);$('new_lon').value=p.lng.toFixed(7);$('placed').textContent='Placed by hand.'});}
  else marker.setLatLng(ll);
  if(pan)pmap.fitBounds(L.latLngBounds([city,ll]).pad(0.6),{maxZoom:20});}
function initMap(){if(pmap)return;pmap=L.map('pmap',{maxZoom:21});
  const sat=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:21,maxNativeZoom:19,attribution:'Esri World Imagery'}).addTo(pmap);
  const streets=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:21,maxNativeZoom:19,attribution:'&copy; OpenStreetMap'});
  L.control.layers({'Satellite':sat,'Streets':streets}).addTo(pmap);
  if(!isAdd)L.circleMarker(city,{radius:7,color:'#fff',weight:2,fillColor:'#898781',fillOpacity:1}).addTo(pmap).bindTooltip('The City has it here');
  pmap.setView(city,19);
  if($('new_lat').value)setPoint([+$('new_lat').value,+$('new_lon').value],true);}
$('lookup').onclick=async()=>{$('placed').textContent='Looking up…';
  const q=new URLSearchParams({address:$('addr').value,street:$('street').value,lat:city[0],lon:city[1],from_address:from.address,from_street:from.street});
  const r=await (await fetch('/place?'+q)).json();
  if(!r.found){$('placed').textContent=isAdd?"Not in the City's address list.":"Not in the City's address list. Drag the blue dot into place.";if(!marker)setPoint(city,false);return}
  $('new_ward').value=r.ward||'';
  if(isAdd){$('placed').textContent='Found '+r.label+'. The tree stays where the blue dot is.';return}
  setPoint([r.lat,r.lon],true);$('placed').textContent='Found '+r.label+(r.offset?", keeping the tree's offset from its old address.":', on its address point.');};
const k=$('kind');const sync=()=>{document.querySelectorAll('[data-for]').forEach(d=>d.hidden=!d.dataset.for.split(' ').includes(k.value));
  if(k.value==='address'||k.value==='add'){initMap();setTimeout(()=>pmap.invalidateSize(),0);if(!marker)setPoint(city,false)}};k.onchange=sync;sync();
document.querySelector('form').addEventListener('submit',(e)=>{const b=e.submitter;if(b){setTimeout(()=>{b.disabled=true;b.textContent='Working…'},0)}});
</script>`;
  }

  return `<h1>${esc(KIND_LABEL[r.kind])} ${pill}</h1>
<div class="muted">Report ${id}</div>
${flash ? `<p class="warn">${esc(flash)}</p>` : ""}
<div class="card"><table>${rows}</table>
<p style="margin:10px 0 0"><a href="${esc(lk.streetview)}" target="_blank" rel="noopener">Street View</a> ·
<a href="${esc(lk.satellite)}" target="_blank" rel="noopener">Satellite</a> · <a href="${esc(lk.map)}" target="_blank" rel="noopener">On the tree map</a></p></div>
${otherHtml}
${form}
<p class="muted" style="margin-top:32px;font-size:12px"><a href="/corrections">All corrections</a></p>`;
}

async function postReview(id, req, env, url) {
  const form = Object.fromEntries(new URLSearchParams(await req.text()));
  const token = form.t || "";
  const r = await loadReport(env, id);
  if (!r || !sameString(token, await sign(env, id))) return page("Not found", "<h1>No such report</h1>", 404);
  if (r.row.status !== "pending") return page(`Review ${id}`, await reviewBody(env, id, r, token, ""));

  const note = String(form.note || "").trim().slice(0, 200);
  const decided = new Date().toISOString();
  let flash = "";

  if (form.action === "deny" || !form.kind) {
    const status = form.action === "deny" ? "denied" : "closed";
    await env.DB.prepare("UPDATE reports SET status = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'")
      .bind(status, decided, note || null, id).run();
  } else {
    const [row, err] = env.GITHUB_TOKEN
      ? await correctionRow(env, id, r, form, note)
      : [null, "GITHUB_TOKEN isn't set on the Worker yet, so nothing can be committed."];
    if (err) {
      flash = err;
    } else {
      const sha = await commitRow(env, row, r);
      await env.DB.prepare("UPDATE reports SET status = 'approved', decided_at = ?, decision_note = ?, correction_id = ?, commit_sha = ? WHERE id = ?")
        .bind(decided, note || null, row.correction_id, sha, id).run();
    }
  }
  return page(`Review ${id}`, await reviewBody(env, id, await loadReport(env, id), token, flash));
}

async function correctionRow(env, id, r, form, note) {
  const t = r.tree, p = r.proposed, kind = form.kind;
  const allowed = r.kind === "add" ? ["add"] : APPLY_KINDS;
  if (!allowed.includes(kind)) return [null, "Unknown correction type."];
  const tx = await taxa(env);
  const row = Object.fromEntries(SEED_COLS.map((c) => [c, ""]));
  Object.assign(row, {
    correction_id: "c" + id, struct_id: t.struct_id, kind,
    approved_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    snap_botanical: t.botanical, snap_dbh_cm: t.dbh || 0, snap_address: t.address ?? "",
    snap_street: t.street || "", snap_lon: t.lon, snap_lat: t.lat, note,
  });
  if (kind === "add") {
    // A new tree has no City record to snapshot; what is kept instead is the address the
    // reader gave, and how many trees of the genus the City had there.
    Object.assign(row, { struct_id: "R-" + id, snap_botanical: "", snap_dbh_cm: "",
      snap_address: p.address ?? "", snap_street: p.street || "" });
  }
  if (kind === "species" || kind === "add") {
    if (!tx.has(form.botanical)) return [null, "Choose a species from the list."];
    if (kind === "species" && form.botanical === t.botanical) return [null, "That's the species the City already has."];
    row.new_botanical = form.botanical;
  }
  if (kind === "dbh" || kind === "add") {
    const raw = String(form.dbh_cm || "").trim();
    if (raw || kind === "dbh") {
      const d = parseInt(raw, 10);
      if (!(d >= 1 && d <= 300)) return [null, "Trunk diameter must be 1 to 300 cm."];
      row.new_dbh_cm = d;
    }
  }
  if (kind === "address" || kind === "add") {
    const a = parseInt(form.address, 10), st = String(form.street || "").trim().toUpperCase().slice(0, 80);
    if (!(a > 0)) return [null, "Enter a street number."];
    if (!st) return [null, "Enter a street."];
    const lat = parseFloat(form.new_lat), lon = parseFloat(form.new_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [null, "Place the tree on the map: look up the address or drag the blue dot."];
    if (!(lat > 43.5 && lat < 43.9 && lon > -79.7 && lon < -79.1)) return [null, "That position is outside Toronto."];
    const ward = String(form.new_ward || "").trim();
    Object.assign(row, { new_address: a, new_street: st, new_lat: +lat.toFixed(7), new_lon: +lon.toFixed(7),
      new_ward: /^\d{1,2}$/.test(ward) ? ward.padStart(2, "0") : "" });
  }
  if (kind === "add") {
    const genus = tx.get(row.new_botanical).genus;
    const samePlace = row.new_address === p.address && row.new_street === p.street;
    // -1: unknown (no counts, or the address was changed in review), never auto-retired.
    row.snap_count = p.genus_counts && samePlace ? (p.genus_counts[genus] || 0) : -1;
  }
  return [row, null];
}

/* ------------------------------------------------------------------ github ---------- */

function csvField(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* Appends one row to the seed and commits it. Retries when someone else committed in
 * between (409), which is the one race this has. Returns the commit sha. */
async function commitRow(env, row, r) {
  const api = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${env.SEED_PATH}`;
  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28", "user-agent": "tree-reports-worker",
  };
  // Rows follow the file's own header, so a column added later can't shift values.
  const lineFor = (header) => {
    const missing = Object.keys(row).filter((k) => row[k] !== "" && row[k] !== null && !header.includes(k));
    if (missing.length) throw new Error(`tree_corrections.csv has no column for ${missing.join(", ")}`);
    return header.map((c) => csvField(row[c])).join(",") + "\n";
  };
  const what = { remove: "remove", species: `species to ${row.new_botanical}`, dbh: `trunk to ${row.new_dbh_cm} cm`,
    address: `address to ${row.new_address} ${row.new_street}`,
    add: `add ${row.new_botanical} at ${row.new_address} ${row.new_street}` }[row.kind];
  const message = `${row.kind === "add" ? "Add tree" : "Correct tree"} ${row.struct_id}: ${what}\n\nApproved reader report ${row.correction_id.slice(1)} (${KIND_LABEL[r.kind].toLowerCase()}).` +
    (row.note ? `\n\n${row.note}` : "");

  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await fetch(`${api}?ref=${env.GITHUB_BRANCH}`, { headers });
    if (!cur.ok) throw new Error(`github read ${cur.status}: ${await cur.text()}`);
    const file = await cur.json();
    let text = b64decode(file.content);
    if (text.includes(`\n${row.correction_id},`)) return file.sha; // already committed by an earlier attempt
    if (text && !text.endsWith("\n")) text += "\n";
    const header = text ? text.split("\n")[0].replace(/\r$/, "").split(",") : SEED_COLS;
    const line = (text ? "" : SEED_COLS.join(",") + "\n") + lineFor(header);
    const put = await fetch(api, {
      method: "PUT", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ message, content: b64encode(text + line), sha: file.sha, branch: env.GITHUB_BRANCH }),
    });
    if (put.ok) return (await put.json()).commit.sha;
    if (put.status !== 409 && put.status !== 422) throw new Error(`github write ${put.status}: ${await put.text()}`);
  }
  throw new Error("github write kept conflicting");
}

/* ------------------------------------------------------------------ corrections ----- */

async function getCorrections(env) {
  let data = { corrections: [] };
  try {
    data = await (await fetch(env.PUBLIC_MAP + "data/corrections.json", { cf: { cacheTtl: 60 } })).json();
  } catch { /* nothing deployed yet */ }
  const good = new Set(["applied", "city_agrees", "replaced"]);
  const rows = data.corrections.map((c) =>
    `<tr><td><code>${esc(c.correction_id)}</code></td><td>${esc(c.kind)}</td><td>${esc(c.struct_id)}</td>` +
    `<td class="${good.has(c.status) ? "ok" : "warn"}">${esc(c.status)}${c.matched_by === "fingerprint" ? " (by fingerprint)" : ""}</td>` +
    `<td class="muted">${esc(String(c.approved_at).slice(0, 10))}</td></tr>`).join("") ||
    '<tr><td colspan="5" class="muted">No approved corrections in the last build.</td></tr>';
  return page("Corrections", `<h1>Corrections</h1>
<p class="muted">As of the last build of the map: every approved correction and how it reconciled with the City's current data. Anything in orange is not being applied.</p>
<div class="card"><table><tr><th>id</th><th>kind</th><th>STRUCTID</th><th>status</th><th>approved</th></tr>${rows}</table></div>
<div class="card muted" style="font-size:13px"><b>applied</b>: City record unchanged since the report; the fix is live.
<b>city_agrees</b>: the City now has the same value. <b>superseded</b>: the City changed the record since, so the City wins.
<b>orphaned</b>: tree not found by STRUCTID or fingerprint. <b>replaced</b>: a later fix to the same field took over.</div>`);
}
