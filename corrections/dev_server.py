"""Local stand-in for the reader-report backend, so the whole loop runs on localhost.

    python corrections/dev_server.py        # then open http://localhost:8000

It serves site/ exactly like `python -m http.server`, plus the routes the production
backend (a Cloudflare Worker, still to be written) will have:

    POST /api/report            a reader's report from the popup form
    GET  /review/<id>?t=<sig>   the review page an email links to
    POST /review/<id>           approve (with edits) or deny

and three that only exist here, standing in for the parts that are external services in
production:

    GET  /dev/inbox             the emails that would have gone to REVIEWER
    GET  /dev/corrections       every approved correction and how it reconciled
    POST /dev/rebuild           re-run the dbt models and export (production: the push
                                to master that approval makes triggers the workflow)

Approval appends a row to dbt/seeds/tree_corrections.csv -- the same file production
commits to. Reports and the fake outbox live in corrections/.dev/, which is gitignored.
"""
from __future__ import annotations

import csv
import hashlib
import hmac
import html
import json
import re
import secrets
import subprocess
import sys
import threading
import time
import math
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
STATE = ROOT / "corrections" / ".dev"
SEED = ROOT / "dbt" / "seeds" / "tree_corrections.csv"
PY = sys.executable
PORT = 8000

REVIEWER = "mkennedytoronto@gmail.com"
PUBLIC_MAP = "https://malcolmkennedy.com/to-tree-map/"
KINDS = {"remove", "species", "dbh", "address", "other"}
APPLY_KINDS = ("remove", "species", "dbh", "address")
SEED_COLS = [
    "correction_id", "struct_id", "kind", "approved_at",
    "snap_botanical", "snap_dbh_cm", "snap_address", "snap_street", "snap_lon", "snap_lat",
    "new_botanical", "new_dbh_cm", "new_address", "new_street", "new_lon", "new_lat", "new_ward",
    "note",
]
DBT_SELECT = ("tree_corrections int_tree_corrections int_street_trees dim_taxa street_trees "
              "tree_stats_by_ward tree_stats_overall")

lock = threading.Lock()
rate: dict[str, list[float]] = {}
rebuild = {"state": "idle", "log": "", "started": None}


# ---------------------------------------------------------------- storage ------------

def load() -> dict:
    path = STATE / "reports.json"
    return json.loads(path.read_text()) if path.exists() else {}


def save(reports: dict) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "reports.json").write_text(json.dumps(reports, indent=1))


def secret() -> bytes:
    path = STATE / "secret"
    if not path.exists():
        STATE.mkdir(parents=True, exist_ok=True)
        path.write_text(secrets.token_hex(32))
    return path.read_text().encode()


def sign(report_id: str) -> str:
    return hmac.new(secret(), report_id.encode(), hashlib.sha256).hexdigest()[:24]


# ---------------------------------------------------------------- placement ----------
#
# The City positions every tree at its address -- a point on the parcel, not the trunk --
# so a corrected address means a corrected position. Looked up in the City's own address
# repository (the geocoder behind map.toronto.ca), which needs no key and is what the
# inventory itself was geocoded against.

GEOCODER = "https://map.toronto.ca/geoservices/rest/search/rankedsearch"
_geo_cache: dict[str, dict | None] = {}


def geocode(address: int, street: str) -> dict | None:
    """An exact address-point match, or None. Never a street centroid or a near miss."""
    q = f"{address} {street}".strip().upper()
    if q in _geo_cache:
        return _geo_cache[q]
    hit = None
    try:
        url = GEOCODER + "?" + urllib.parse.urlencode({"searchString": q})
        with urllib.request.urlopen(url, timeout=10) as resp:
            best = (json.load(resp).get("result", {}).get("bestResult") or [{}])[0]
        if best.get("matchType") == "Exact" and best.get("featureClass") == "Address":
            ward = re.search(r"Ward: .*\((\d+)\)", best.get("detail") or "")
            hit = {"lat": best["latitude"], "lon": best["longitude"], "label": best["key_Desc"],
                   "ward": ward.group(1).zfill(2) if ward else None}
    except (OSError, ValueError, KeyError):
        return None  # don't cache a network failure
    _geo_cache[q] = hit
    return hit


def metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    dy = (b[0] - a[0]) * 111_320
    dx = (b[1] - a[1]) * 111_320 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)


def place(address: int, street: str, tree: tuple[float, float],
          from_address: int | None, from_street: str | None) -> dict | None:
    """Where the dot goes for a corrected address.

    The City's tree points sit anywhere from on the address point to 25 m off it (toward
    the curb, mostly). So where the old address resolves and the tree sat near it, the
    tree keeps that same offset from the new address point: a neighbouring lot is
    usually oriented the same way, and the dot stays at the curb instead of jumping
    onto the house. Otherwise it goes on the address point itself.
    """
    new = geocode(address, street)
    if not new:
        return None
    out = dict(new, offset=False)
    old = geocode(from_address, from_street) if from_address and from_street else None
    if old and metres((old["lat"], old["lon"]), tree) < 60 and metres((old["lat"], old["lon"]), (new["lat"], new["lon"])) < 300:
        out.update(lat=new["lat"] + tree[0] - old["lat"], lon=new["lon"] + tree[1] - old["lon"], offset=True)
    out["lat"], out["lon"] = round(out["lat"], 7), round(out["lon"], 7)
    return out


def taxa_index() -> dict:
    meta = json.loads((SITE / "data" / "trees.meta.json").read_text())
    return {t["botanical"]: t for t in meta["taxa"]}


# ---------------------------------------------------------------- validation ---------

STRUCT_RE = re.compile(r"^[A-Z]{0,3}\d{1,8}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,100}@[^@\s]{1,100}\.[^@\s]{2,}$")


def validate(body: dict) -> tuple[dict | None, str | None]:
    """Everything the browser sends is untrusted; keep only what we expect."""
    kind = body.get("kind")
    tree = body.get("tree") or {}
    proposed = body.get("proposed") or {}
    if kind not in KINDS:
        return None, "unknown problem type"
    sid = str(tree.get("struct_id") or "")
    if not STRUCT_RE.match(sid):
        return None, "missing tree id"
    try:
        lat, lon = float(tree["lat"]), float(tree["lon"])
    except (KeyError, TypeError, ValueError):
        return None, "missing position"
    if not (43.5 < lat < 43.9 and -79.7 < lon < -79.1):
        return None, "position outside Toronto"
    email = (body.get("email") or "").strip()[:200] or None
    if email and not EMAIL_RE.match(email):
        return None, "bad email"
    note = (body.get("note") or "").strip()[:1000] or None
    if kind == "other" and not note:
        return None, "describe the problem"

    def s(v, n=80):
        return str(v)[:n] if v not in (None, "") else None

    def i(v):
        try:
            return int(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None

    clean_prop: dict = {}
    if kind == "remove":
        clean_prop["reason"] = proposed.get("reason") if proposed.get("reason") in ("stump", "never", "unsure") else "unsure"
    elif kind == "species":
        clean_prop["unsure"] = bool(proposed.get("unsure"))
        clean_prop["botanical"] = None if clean_prop["unsure"] else s(proposed.get("botanical"))
        if not clean_prop["unsure"] and clean_prop["botanical"] not in taxa_index():
            return None, "unknown species"
    elif kind == "dbh":
        d = i(proposed.get("dbh_cm"))
        if not d or not 1 <= d <= 300:
            return None, "trunk size out of range"
        clean_prop["dbh_cm"] = d
    elif kind == "address":
        a, st = i(proposed.get("address")), s(proposed.get("street"))
        if not a or not st:
            return None, "address incomplete"
        clean_prop.update(address=a, street=st.upper())
        # Placed here, not trusted from the browser: the form's lookup is only a preview.
        clean_prop["place"] = place(a, st, (lat, lon), i(tree.get("address")), s(tree.get("street")))

    m = body.get("measured") or None
    return {
        "kind": kind,
        "proposed": clean_prop,
        "measured": {"value": m.get("value"), "unit": s(m.get("unit"), 4), "how": s(m.get("how"), 8)} if isinstance(m, dict) else None,
        "note": note,
        "email": email,
        "tree": {
            "struct_id": sid, "lat": lat, "lon": lon,
            "botanical": s(tree.get("botanical")), "common": s(tree.get("common")),
            "dbh": i(tree.get("dbh")) or 0, "address": i(tree.get("address")),
            "street": s(tree.get("street")), "ward": i(tree.get("ward")),
            "cross": [s(c) for c in (tree.get("cross") or [])[:2]],
            "payload": s(tree.get("payload"), 40),
            # Fields already carrying an approved correction. The snapshot above holds the
            # City's values for them, not what the map showed.
            "corrected": [k for k in (tree.get("corrected") or []) if k in APPLY_KINDS][:4],
        },
    }, None


# ---------------------------------------------------------------- presentation -------

KIND_LABEL = {
    "remove": "No tree here", "species": "Wrong species", "dbh": "Wrong trunk size",
    "address": "Wrong address", "other": "Something else",
}
REASON_LABEL = {"stump": "cut down (stump or empty spot)", "never": "never a tree here", "unsure": "not sure why"}


def where(t: dict) -> str:
    return " ".join(str(x) for x in (t.get("address"), t.get("street")) if x) or "no address"


def city_says(r: dict) -> str:
    t = r["tree"]
    return {
        "remove": f"{t['common'] or t['botanical']}, {t['dbh'] or '?'} cm",
        "species": f"{t['common']} ({t['botanical']})",
        "dbh": f"{t['dbh']} cm" if t["dbh"] else "not recorded",
        "address": where(t),
    }.get(r["kind"], "")


def reader_says(r: dict) -> str:
    p, k = r["proposed"], r["kind"]
    if k == "remove":
        return "no tree: " + REASON_LABEL[p["reason"]]
    if k == "species":
        if p.get("unsure"):
            return "not this species; doesn't know which"
        tx = taxa_index().get(p["botanical"], {})
        return f"{tx.get('common') or p['botanical']} ({p['botanical']})"
    if k == "dbh":
        m = r.get("measured") or {}
        how = f" (measured {m.get('value')} {m.get('unit')} {m.get('how')})" if m.get("value") else ""
        return f"{p['dbh_cm']} cm{how}"
    if k == "address":
        pl = p.get("place")
        moves = (f"; dot moves {metres((r['tree']['lat'], r['tree']['lon']), (pl['lat'], pl['lon'])):.0f} m"
                 if pl else "; not in the City's address list, place it by hand")
        return f"{p['address']} {p['street']}{moves}"
    return r.get("note") or ""


def links(t: dict, base: str) -> dict:
    lat, lon = t["lat"], t["lon"]
    return {
        "map": f"{base}#19/{lat:.5f}/{lon:.5f}&t={lat:.6f},{lon:.6f}",
        "streetview": f"https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={lat},{lon}",
        "satellite": f"https://www.google.com/maps/@{lat},{lon},40m/data=!3m1!1e3",
    }


def subject(r: dict) -> str:
    t = r["tree"]
    head = f"Tree report: {KIND_LABEL[r['kind']].lower()} at {where(t).title()}"
    if r["kind"] in ("species", "dbh", "address"):
        # Common names only; the botanical ones and the measurement are in the body.
        def short(v: str) -> str:
            return re.sub(r" \((?:measured .*|[A-Z][a-z]+ [^)]*)\)$", "", v)
        head += f" ({short(city_says(r))} → {short(reader_says(r))})"
    return head


def email_html(rid: str, r: dict, review_url: str, others: int) -> str:
    """The message the reviewer gets. Production sends this same HTML through Resend."""
    t, e = r["tree"], html.escape
    lk = links(t, PUBLIC_MAP)
    rows = [("The City says", city_says(r)), ("Reader says", reader_says(r))] if r["kind"] != "other" else []
    rows += [
        ("Tree", f"{t['common'] or t['botanical']} · {t['dbh'] or '?'} cm · STRUCTID {t['struct_id']}"),
        ("Where", where(t) + (f" (between {' and '.join(t['cross'])})" if t["cross"] else "")),
    ]
    if r["note"] and r["kind"] != "other":
        rows.append(("Their note", r["note"]))
    if t.get("corrected"):
        rows.append(("Already corrected", ", ".join(t["corrected"]) + " (the City-says values above are the City's)"))
    rows.append(("Reply to", r["email"] or "(no email given)"))
    table = "".join(
        f'<tr><td style="padding:4px 12px 4px 0;color:#6b6a66;vertical-align:top;white-space:nowrap">{e(k)}</td>'
        f'<td style="padding:4px 0">{e(v)}</td></tr>' for k, v in rows)
    other_note = (f'<p style="color:#b4531f">{others} other open report{"s" if others > 1 else ""} on this tree.</p>'
                  if others else "")
    body_other = f'<blockquote style="margin:0 0 12px;padding-left:10px;border-left:3px solid #ddd">{e(r["note"])}</blockquote>' if r["kind"] == "other" else ""
    return f"""<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111;max-width:560px">
<p style="font-size:16px;font-weight:600;margin:0 0 10px">{e(KIND_LABEL[r['kind']])}</p>
{body_other}<table style="border-collapse:collapse;font-size:14px">{table}</table>
{other_note}
<p style="margin:16px 0">
<a href="{e(review_url)}" style="background:#2a78d6;color:#fff;padding:8px 16px;border-radius:5px;text-decoration:none;font-weight:600">Review</a>
</p>
<p style="font-size:13px"><a href="{e(lk['streetview'])}">Street View</a> · <a href="{e(lk['satellite'])}">Satellite</a> · <a href="{e(lk['map'])}">On the tree map</a></p>
<p style="font-size:12px;color:#898781">Approving or denying happens on the review page, behind a button, so a link scanner opening this email can't do either. Report {e(rid)}.</p>
</div>"""


PAGE_CSS = """
:root{color-scheme:light;--bg:#f9f9f7;--card:#fcfcfb;--text:#0b0b0b;--muted:#6b6a66;--line:#e1e0d9;--accent:#2a78d6;--warn:#b4531f;--ok:#14855e}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#0d0d0d;--card:#1a1a19;--text:#fff;--muted:#a3a29a;--line:#2c2c2a;--accent:#3987e5;--warn:#e07a46;--ok:#2fb486}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:12px 0}
table{border-collapse:collapse;width:100%}td,th{padding:5px 10px 5px 0;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th{font-weight:500;color:var(--muted);white-space:nowrap}
a{color:var(--accent)}label{display:block;margin:10px 0 4px;font-weight:500}
input,select,textarea{font:inherit;width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg);color:var(--text)}
button{font:inherit;font-weight:600;padding:8px 16px;border-radius:5px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.deny{color:var(--warn)}
.actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}.pill{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:99px;border:1px solid currentColor}
.ok{color:var(--ok)}.warn{color:var(--warn)}iframe{width:100%;height:520px;border:1px solid var(--line);border-radius:8px;background:#fff}
.inbox a.row{display:block;padding:10px 12px;border-bottom:1px solid var(--line);text-decoration:none;color:var(--text)}.inbox a.row:hover{background:var(--card)}
.inbox .row small{color:var(--muted)}pre{white-space:pre-wrap;font-size:12px;background:var(--card);border:1px solid var(--line);padding:10px;border-radius:6px;max-height:260px;overflow:auto}
.devbar{font-size:12px;color:var(--muted);margin-bottom:16px}.devbar a{margin-right:12px}
"""


def page(title: str, body: str) -> bytes:
    nav = ('<div class="devbar">localhost demo · <a href="/">Map</a><a href="/dev/inbox">Inbox</a>'
           '<a href="/dev/corrections">Corrections</a></div>')
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title>'
            f'<style>{PAGE_CSS}</style></head><body><main>{nav}{body}</main></body></html>').encode()


def review_page(rid: str, r: dict, token: str, flash: str = "") -> bytes:
    e, t = html.escape, r["tree"]
    lk = links(t, "/")
    status = r["status"]
    pill = {"pending": "", "approved": '<span class="pill ok">approved</span>',
            "denied": '<span class="pill warn">denied</span>', "closed": '<span class="pill">closed, no map change</span>'}[status]
    facts = [
        ("Problem", KIND_LABEL[r["kind"]]),
        ("The City says", city_says(r)) if r["kind"] != "other" else None,
        ("Reader says", reader_says(r)),
        ("Their note", r["note"]) if r["note"] and r["kind"] != "other" else None,
        ("Tree", f"{t['common'] or t['botanical']} ({t['botanical']}), {t['dbh'] or '?'} cm"),
        ("Address", where(t) + (f", between {' and '.join(t['cross'])}" if t["cross"] else "")),
        ("STRUCTID", t["struct_id"]),
        ("Already corrected", ", ".join(t["corrected"])) if t.get("corrected") else None,
        ("Reply to", r["email"] or "(none)"),
        ("Received", r["received"][:16].replace("T", " ")),
    ]
    rows = "".join(f"<tr><th>{e(k)}</th><td>{e(str(v))}</td></tr>" for k, v in (f for f in facts if f))
    others = [k for k, o in load().items() if k != rid and o["tree"]["struct_id"] == t["struct_id"]]
    other_html = ("<p class='warn'>Other reports on this tree: " + ", ".join(
        f'<a href="/review/{k}?t={sign(k)}">{k}</a>' for k in others) + "</p>") if others else ""

    if status != "pending":
        done = f"<p>{e(r.get('decision_note') or '')}</p>" if r.get("decision_note") else ""
        if r.get("correction_id"):
            done += (f"<p>Correction <code>{r['correction_id']}</code> is in <code>dbt/seeds/tree_corrections.csv</code>. "
                     "In production that's a commit to master, which triggers the rebuild.</p>"
                     + rebuild_widget())
        form = done
    else:
        # The reviewer can correct the correction before it goes in: a reader's species
        # "unsure", or an "other" that is really an address fix, gets recast here.
        suggested = r["kind"] if r["kind"] in APPLY_KINDS and not r["proposed"].get("unsure") else ""
        p = r["proposed"]
        taxa = sorted(taxa_index().values(), key=lambda x: -x["count"])
        opts = "".join(
            f'<option value="{e(x["botanical"])}"{" selected" if x["botanical"] == p.get("botanical") else ""}>'
            f'{e((x["common"] or x["botanical"]) + " (" + x["botanical"] + ")")}</option>'
            for x in taxa if x["genus"])
        pl = p.get("place")
        placed_text = (f"Found {pl['label']}" + (", keeping the tree's offset from its old address." if pl.get("offset") else ", on its address point.")
                       if pl else "Not found in the City's address list. Look up a corrected address, or drag the blue dot into place.")
        kind_opts = "".join(
            f'<option value="{k}"{" selected" if k == suggested else ""}>{e(lbl)}</option>'
            for k, lbl in [("", "Don't change the map (close as handled)"), ("remove", "Remove the tree"),
                           ("species", "Change the species"), ("dbh", "Change the trunk size"),
                           ("address", "Change the address")])
        form = f"""
<form method="post" action="/review/{rid}">
<input type="hidden" name="t" value="{token}">
<label for="kind">Apply as</label><select name="kind" id="kind">{kind_opts}</select>
<div data-for="species"><label for="botanical">Species</label><select name="botanical" id="botanical"><option value="">Choose…</option>{opts}</select></div>
<div data-for="dbh"><label for="dbh">Trunk diameter, cm</label><input name="dbh_cm" id="dbh" type="number" min="1" max="300" value="{p.get('dbh_cm') or ''}"></div>
<div data-for="address"><label for="addr">Street number and street</label>
<div style="display:flex;gap:6px"><input name="address" id="addr" style="flex:0 0 90px" value="{p.get('address') or t['address'] or ''}"><input name="street" id="street" value="{e(p.get('street') or t['street'] or '')}">
<button type="button" id="lookup" style="flex:none">Look up</button></div>
<div id="placed" class="muted" style="margin:6px 0">{e(placed_text)}</div>
<div id="pmap" style="height:320px;border-radius:8px;border:1px solid var(--line)"></div>
<div class="muted" style="font-size:12px;margin-top:4px">Grey: where the City has it. Blue: where it will go. Drag the blue dot onto the tree if you can see it.</div>
<input type="hidden" name="new_lat" id="new_lat" value="{pl['lat'] if pl else ''}"><input type="hidden" name="new_lon" id="new_lon" value="{pl['lon'] if pl else ''}">
<input type="hidden" name="new_ward" id="new_ward" value="{e((pl or {}).get('ward') or '')}"></div>
<label for="note">Public note <span class="muted">(goes in the repo; optional)</span></label>
<input name="note" id="note" placeholder="e.g. stump visible on Street View, Aug 2025">
<div class="actions"><button class="primary" name="action" value="approve">Approve</button>
<button class="deny" name="action" value="deny">Deny</button></div>
</form>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const $=(id)=>document.getElementById(id);
const city=[{t['lat']},{t['lon']}];
let pmap=null,marker=null;
function setPoint(ll,pan){{$('new_lat').value=ll[0].toFixed(7);$('new_lon').value=ll[1].toFixed(7);
  if(!marker){{marker=L.marker(ll,{{draggable:true,icon:L.divIcon({{className:'',html:'<div style="width:16px;height:16px;border-radius:50%;background:#2a78d6;border:2px solid #fff;box-shadow:0 0 0 1px #2a78d6"></div>',iconSize:[16,16],iconAnchor:[8,8]}})}}).addTo(pmap);
    marker.on('dragend',()=>{{const p=marker.getLatLng();$('new_lat').value=p.lat.toFixed(7);$('new_lon').value=p.lng.toFixed(7);$('placed').textContent='Placed by hand.'}});}}
  else marker.setLatLng(ll);
  if(pan)pmap.fitBounds(L.latLngBounds([city,ll]).pad(0.6),{{maxZoom:20}});}}
function initMap(){{if(pmap)return;pmap=L.map('pmap',{{maxZoom:21}});
  const sat=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{{z}}/{{y}}/{{x}}',{{maxZoom:21,maxNativeZoom:19,attribution:'Esri World Imagery'}}).addTo(pmap);
  const streets=L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png',{{maxZoom:21,maxNativeZoom:19,attribution:'&copy; OpenStreetMap'}});
  L.control.layers({{'Satellite':sat,'Streets':streets}}).addTo(pmap);
  L.circleMarker(city,{{radius:7,color:'#fff',weight:2,fillColor:'#898781',fillOpacity:1}}).addTo(pmap).bindTooltip('The City has it here');
  pmap.setView(city,19);
  if($('new_lat').value)setPoint([+$('new_lat').value,+$('new_lon').value],true);}}
$('lookup').onclick=async()=>{{$('placed').textContent='Looking up…';
  const q=new URLSearchParams({{address:$('addr').value,street:$('street').value,lat:city[0],lon:city[1],from_address:{json.dumps(t['address'] or '')},from_street:{json.dumps(t['street'] or '')}}});
  const r=await (await fetch('/api/place?'+q)).json();
  if(!r.found){{$('placed').textContent="Not in the City's address list. Drag the blue dot into place.";if(!marker)setPoint(city,false);return}}
  $('new_ward').value=r.ward||'';setPoint([r.lat,r.lon],true);$('placed').textContent='Found '+r.label+(r.offset?", keeping the tree's offset from its old address.":', on its address point.');}};
const k=$('kind');const sync=()=>{{document.querySelectorAll('[data-for]').forEach(d=>d.hidden=d.dataset.for!==k.value);
  if(k.value==='address'){{initMap();setTimeout(()=>pmap.invalidateSize(),0);if(!marker)setPoint(city,false)}}}};k.onchange=sync;sync();
</script>"""

    return page(f"Review {rid}", f"""
<h1>{e(KIND_LABEL[r['kind']])} {pill}</h1>
<div class="muted">Report {rid}</div>
{f'<p class="warn">{e(flash)}</p>' if flash else ''}
<div class="card"><table>{rows}</table>
<p style="margin:10px 0 0"><a href="{e(lk['streetview'])}" target="_blank">Street View</a> ·
<a href="{e(lk['satellite'])}" target="_blank">Satellite</a> · <a href="{e(lk['map'])}" target="_blank">On the tree map</a></p></div>
{other_html}
{form}""")


def rebuild_widget() -> str:
    return """<div class="card"><button id="rb" class="primary">Rebuild the map locally</button>
<span id="rbs" class="muted" style="margin-left:8px"></span><pre id="rbl" hidden></pre></div>
<script>
const b=document.getElementById('rb'),s=document.getElementById('rbs'),l=document.getElementById('rbl');
async function poll(){const r=await (await fetch('/dev/rebuild')).json();s.textContent=r.state==='running'?'Running dbt and the export…':r.state==='done'?'Done. Reload the map.':r.state==='failed'?'Failed, see the log.':'';
if(r.log){l.hidden=false;l.textContent=r.log;l.scrollTop=l.scrollHeight}if(r.state==='running')setTimeout(poll,1000)}
b.onclick=async()=>{await fetch('/dev/rebuild',{method:'POST'});poll()};poll();
</script>"""


# ---------------------------------------------------------------- approval -----------

def approve(rid: str, r: dict, form: dict) -> tuple[str | None, str | None]:
    """Turn a report into a seed row. Returns (correction_id, error)."""
    kind = form.get("kind", "")
    note = (form.get("note") or "").strip()[:200]
    if not kind:
        r.update(status="closed", decision_note=note or None)
        return None, None
    t = r["tree"]
    row = {c: "" for c in SEED_COLS}
    row.update(
        correction_id=f"c{rid}", struct_id=t["struct_id"], kind=kind,
        approved_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        snap_botanical=t["botanical"], snap_dbh_cm=t["dbh"] or 0,
        snap_address=t["address"] if t["address"] is not None else "",
        snap_street=t["street"] or "", snap_lon=t["lon"], snap_lat=t["lat"], note=note,
    )
    if kind == "species":
        if form.get("botanical") not in taxa_index():
            return None, "Choose a species from the list."
        if form["botanical"] == t["botanical"]:
            return None, "That's the species the City already has."
        row["new_botanical"] = form["botanical"]
    elif kind == "dbh":
        try:
            d = int(form.get("dbh_cm", ""))
        except ValueError:
            return None, "Enter a trunk diameter."
        if not 1 <= d <= 300:
            return None, "Trunk diameter must be 1 to 300 cm."
        row["new_dbh_cm"] = d
    elif kind == "address":
        try:
            a = int(form.get("address", ""))
        except ValueError:
            return None, "Enter a street number."
        st = (form.get("street") or "").strip().upper()
        if not st:
            return None, "Enter a street."
        try:
            nlat, nlon = float(form.get("new_lat", "")), float(form.get("new_lon", ""))
        except ValueError:
            return None, "Place the tree on the map: look up the address or drag the blue dot."
        if not (43.5 < nlat < 43.9 and -79.7 < nlon < -79.1):
            return None, "That position is outside Toronto."
        ward = (form.get("new_ward") or "").strip()
        row.update(new_address=a, new_street=st, new_lat=round(nlat, 7), new_lon=round(nlon, 7),
                   new_ward=ward.zfill(2) if ward.isdigit() else "")

    new_file = not SEED.exists() or SEED.stat().st_size == 0
    with SEED.open("a", newline="") as fh:
        w = csv.DictWriter(fh, SEED_COLS)
        if new_file:
            w.writeheader()
        w.writerow(row)
    r.update(status="approved", correction_id=row["correction_id"], decision_note=note or None)
    return row["correction_id"], None


def run_rebuild() -> None:
    rebuild.update(state="running", log="", started=time.time())
    steps = [
        ([str(ROOT / ".venv" / "bin" / "dbt"), "build", "--profiles-dir", ".", "--full-refresh", "-s", *DBT_SELECT.split()], ROOT / "dbt"),
        ([PY, "export/export_map_data.py"], ROOT),
    ]
    for cmd, cwd in steps:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
        out = re.sub(r"\x1b\[[0-9;]*m", "", p.stdout + p.stderr)
        keep = [ln for ln in out.splitlines() if re.search(r"WARN \d|ERROR|Done\.|^\s+corrections |Total payload|Exporting", ln)]
        rebuild["log"] += f"$ {' '.join(Path(c).name if i == 0 else c for i, c in enumerate(cmd))}\n" + "\n".join(keep) + "\n"
        if p.returncode:
            rebuild["log"] += out[-3000:]
            rebuild["state"] = "failed"
            return
    rebuild["state"] = "done"


# ---------------------------------------------------------------- http ---------------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    def log_message(self, fmt, *args):
        if not self.path.startswith(("/data/", "/style", "/map.js", "/report.js")):
            super().log_message(fmt, *args)

    def send(self, code: int, body: bytes, ctype: str = "text/html; charset=utf-8") -> None:
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def json(self, code: int, obj) -> None:
        self.send(code, json.dumps(obj).encode(), "application/json")

    def body(self, limit: int = 16_000) -> bytes:
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(min(n, limit))

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        path = url.path

        if path == "/config.js":
            # TREE_REPORT_URL / TURNSTILE_SITE_KEY in the environment point the local map at
            # the real Worker instead of this server's own /api/report.
            existing = (SITE / "config.js").read_text() if (SITE / "config.js").exists() else ""
            lines = [f"window.TREE_REPORT_URL = {json.dumps(os.environ.get('TREE_REPORT_URL', '/api/report'))};"]
            if os.environ.get("TURNSTILE_SITE_KEY"):
                lines.append(f"window.TURNSTILE_SITE_KEY = {json.dumps(os.environ['TURNSTILE_SITE_KEY'])};")
            return self.send(200, (existing + "\n" + "\n".join(lines) + "\n").encode(), "text/javascript")
        if path in ("/header.js", "/map-search.js"):
            return self.send(200, b"/* shared site script: served by malcolmkennedy.com in production */", "text/javascript")

        if path == "/dev/inbox":
            out = sorted((STATE / "outbox").glob("*.json"), reverse=True) if (STATE / "outbox").exists() else []
            msgs = [json.loads(p.read_text()) for p in out]
            sel = q.get("m") or (msgs[0]["id"] if msgs else None)
            listing = "".join(
                f'<a class="row" href="/dev/inbox?m={m["id"]}"><b>{html.escape(m["subject"])}</b><br>'
                f'<small>to {html.escape(m["to"])} · {m["sent"][:16].replace("T", " ")}</small></a>' for m in msgs
            ) or '<p class="muted">Nothing yet. Open a tree on the map and report a problem.</p>'
            frame = f'<h2>Message</h2><iframe src="/dev/inbox/{sel}"></iframe>' if sel else ""
            return self.send(200, page("Inbox", f'<h1>Inbox</h1><p class="muted">What would have been emailed to {REVIEWER}.</p>'
                                       f'<div class="card inbox" style="padding:0">{listing}</div>{frame}'))
        m = re.fullmatch(r"/dev/inbox/([\w-]+)", path)
        if m:
            p = STATE / "outbox" / f"{m.group(1)}.json"
            if not p.exists():
                return self.send(404, b"no such message")
            msg = json.loads(p.read_text())
            # Links in the message open over the whole inbox, not inside its iframe.
            body = msg["html"].replace("<a ", '<a target="_top" ')
            return self.send(200, ('<!doctype html><meta charset="utf-8"><body style="margin:16px;background:#fff">'
                                   f'<p style="font:13px system-ui;color:#6b6a66">Subject: {html.escape(msg["subject"])}</p>'
                                   + body).encode())

        if path == "/dev/corrections":
            data = json.loads((SITE / "data" / "corrections.json").read_text()) if (SITE / "data" / "corrections.json").exists() else {"corrections": []}
            good = {"applied", "city_agrees", "replaced"}
            rows = "".join(
                f'<tr><td><code>{html.escape(c["correction_id"])}</code></td><td>{html.escape(c["kind"])}</td>'
                f'<td>{html.escape(str(c["struct_id"]))}</td>'
                f'<td class="{"ok" if c["status"] in good else "warn"}">{html.escape(c["status"])}'
                f'{" (by fingerprint)" if c.get("matched_by") == "fingerprint" else ""}</td>'
                f'<td class="muted">{html.escape(str(c["approved_at"])[:10])}</td></tr>'
                for c in data["corrections"]) or '<tr><td colspan="5" class="muted">No approved corrections in the last build.</td></tr>'
            return self.send(200, page("Corrections", f"""<h1>Corrections</h1>
<p class="muted">As of the last build: every approved correction and how it reconciled with the City's current data. Anything in orange is not being applied.</p>
<div class="card"><table><tr><th>id</th><th>kind</th><th>STRUCTID</th><th>status</th><th>approved</th></tr>{rows}</table></div>
<div class="card muted" style="font-size:13px"><b>applied</b>: City record unchanged since the report; our fix is live.
<b>city_agrees</b>: City now has the same value; nothing to do. <b>superseded</b>: City changed the record since; City wins.
<b>orphaned</b>: tree not found by STRUCTID or by fingerprint. <b>replaced</b>: a later fix to the same field took over.</div>
{rebuild_widget()}"""))

        if path == "/dev/rebuild":
            return self.json(200, {k: rebuild[k] for k in ("state", "log")})

        if path == "/api/place":
            def num(v):
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return None
            a, st = q.get("address", ""), q.get("street", "").strip()
            lat, lon = num(q.get("lat")), num(q.get("lon"))
            if not a.isdigit() or not st or lat is None or lon is None:
                return self.json(400, {"error": "address, street, lat and lon required"})
            fa = q.get("from_address", "")
            pl = place(int(a), st[:80], (lat, lon), int(fa) if fa.isdigit() else None, q.get("from_street") or None)
            return self.json(200, dict(pl, found=True) if pl else {"found": False})

        m = re.fullmatch(r"/review/([\w-]+)", path)
        if m:
            rid = m.group(1)
            r = load().get(rid)
            if not r or not hmac.compare_digest(q.get("t", ""), sign(rid)):
                return self.send(404, page("Not found", "<h1>No such report</h1>"))
            return self.send(200, review_page(rid, r, q["t"]))

        return super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path

        if path == "/api/report":
            ip = self.client_address[0]
            now = time.time()
            recent = [x for x in rate.get(ip, []) if now - x < 3600]
            if len(recent) >= 20:
                return self.json(429, {"error": "too many reports from here; try later"})
            try:
                body = json.loads(self.body() or b"{}")
            except ValueError:
                return self.json(400, {"error": "bad json"})
            if body.get("website"):
                return self.json(200, {"ok": True})  # honeypot: pretend, drop
            clean, err = validate(body)
            if err:
                return self.json(400, {"error": err})
            rate[ip] = recent + [now]
            with lock:
                reports = load()
                rid = secrets.token_hex(4)
                clean.update(status="pending", received=datetime.now(timezone.utc).isoformat())
                reports[rid] = clean
                save(reports)
                others = sum(1 for k, o in reports.items()
                             if k != rid and o["status"] == "pending" and o["tree"]["struct_id"] == clean["tree"]["struct_id"])
            review_url = f"http://localhost:{PORT}/review/{rid}?t={sign(rid)}"
            (STATE / "outbox").mkdir(parents=True, exist_ok=True)
            msg = {"id": f"{int(now)}-{rid}", "to": REVIEWER, "subject": subject(clean),
                   "sent": datetime.now(timezone.utc).isoformat(), "html": email_html(rid, clean, review_url, others)}
            (STATE / "outbox" / f"{msg['id']}.json").write_text(json.dumps(msg))
            print(f"\n  ✉  {msg['subject']}\n     review: {review_url}\n", flush=True)
            return self.json(200, {"ok": True})

        m = re.fullmatch(r"/review/([\w-]+)", path)
        if m:
            rid = m.group(1)
            form = dict(urllib.parse.parse_qsl(self.body().decode()))
            with lock:
                reports = load()
                r = reports.get(rid)
                if not r or not hmac.compare_digest(form.get("t", ""), sign(rid)):
                    return self.send(404, page("Not found", "<h1>No such report</h1>"))
                if r["status"] != "pending":
                    return self.send(200, review_page(rid, r, form["t"]))
                if form.get("action") == "deny":
                    r.update(status="denied", decision_note=(form.get("note") or "").strip()[:200] or None)
                    err = None
                else:
                    _, err = approve(rid, r, form)
                if not err:
                    save(reports)
            return self.send(200, review_page(rid, r, form["t"], err or ""))

        if path == "/dev/rebuild":
            if rebuild["state"] != "running":
                threading.Thread(target=run_rebuild, daemon=True).start()
                time.sleep(0.05)
            return self.json(200, {"state": rebuild["state"]})

        self.send(404, b"not found")


if __name__ == "__main__":
    if not (SITE / "data" / "trees.meta.json").exists():
        sys.exit("site/data is empty: run the pipeline first (see the README).")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Tree map with reader reports on http://localhost:{PORT}\n"
          f"  fake inbox:   http://localhost:{PORT}/dev/inbox\n"
          f"  corrections:  http://localhost:{PORT}/dev/corrections")
    server.serve_forever()
