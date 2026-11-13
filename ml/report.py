"""Build a self-contained HTML report from a training run's outputs.

    python report.py data/run3            -> data/run3/report.html

Reads <run>/report.json, predictions.csv, probs_<split>_{genus,species}.npy (written by
kaggle/train.py), joins truth from data/manifest.csv, and embeds example crops from
data/crops/. Charts are inline SVG with native hover titles; no external scripts.
"""
import base64, html, io, json, os, sys
import numpy as np, pandas as pd
from PIL import Image

RUN = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(RUN, 'report.json')))
P = pd.read_csv(os.path.join(RUN, 'predictions.csv'))
M = pd.read_csv(os.path.join(HERE, 'data', 'manifest.csv'), low_memory=False)
genera, species = R['genera'], R['species']
P = P.merge(M[['id', 'genus_cls', 'species_cls', 'genus', 'sp', 'common', 'dbh_cm', 'lat', 'lon', 'site']], on='id', how='left')
probs = {s: np.load(os.path.join(RUN, f'probs_{s}_genus.npy')).astype(np.float32)
         for s in P.split.unique() if os.path.exists(os.path.join(RUN, f'probs_{s}_genus.npy'))}
LOC = {'by': 'Back yard', 'fy': 'Front yard', 'sy': 'Side yard', 'st': 'Street boulevard', 'pk': 'Park',
       'pl': 'Parking lot', 'cr': 'Courtyard / other', 'ut': 'Utility corridor'}
try:   # where each Annex tree stands, from the local survey table
    import duckdb
    _con = duckdb.connect(os.path.join(HERE, 'data', 'ml.duckdb'), read_only=True)
    _a = _con.sql("select 'a' || annex_id::varchar id, location from annex").df()
    P = P.merge(_a, on='id', how='left')
except Exception as e:
    print('no Annex locations:', e)
    P['location'] = None
esc = html.escape
pct = lambda v: '–' if v is None or v != v else f'{100 * v:.0f}%'

SET_LABELS = [('test', 'Test (unseen neighbourhoods)'), ('test_leafon', 'Test, in-leaf areas'),
              ('test_leafoff_nw', 'Test, leaf-off NW'), ('annex_street', 'Annex City street trees'),
              ('annex', 'Annex survey, all')] + \
             [(k, {'annex_c': 'Annex survey, City-owned', 'annex_p': 'Annex survey, private', 'annex_j': 'Annex survey, jointly owned'}.get(k, f'Annex survey, ownership “{k[6:]}”'))
              for k in sorted(R) if k.startswith('annex_') and k != 'annex_street' and R[k].get('genus_n', 0) >= 30]


# ---------- small SVG helpers ----------
def hbar_rows(rows, width=420, key='v', label_w=190, fmt=pct, max_v=1.0):
    """rows: list of dicts with label, v, n. Single-series horizontal bars."""
    h = 26; W = label_w + width + 70
    out = [f'<svg viewBox="0 0 {W} {h * len(rows) + 8}" class="chart" role="img">']
    for i, r in enumerate(rows):
        y = i * h + 4; v = r.get(key)
        out.append(f'<text x="{label_w - 8}" y="{y + 15}" text-anchor="end" class="lab">{esc(r["label"])}</text>')
        out.append(f'<rect x="{label_w}" y="{y + 3}" width="{width}" height="16" class="track"/>')
        if v is not None and v == v:
            w = max(2, width * v / max_v)
            out.append(f'<g><title>{esc(r["label"])}: {fmt(v)} (n={r.get("n", "?")})</title>'
                       f'<rect x="{label_w}" y="{y + 3}" width="{w:.1f}" height="16" rx="4" class="s1"/></g>')
            out.append(f'<text x="{label_w + w + 6:.1f}" y="{y + 15}" class="val">{fmt(v)}</text>')
    out.append('</svg>')
    return ''.join(out)


def line_chart(xs, series, ylab, width=560, height=220, ymin=0, ymax=1, xlab='epoch'):
    """series: list of (name, ys, css_class). One shared 0-100% axis."""
    L, B, T, Rm = 44, 30, 10, 110
    pw, ph = width - L - Rm, height - B - T
    sx = lambda x: L + (x - xs[0]) / max(1e-9, xs[-1] - xs[0]) * pw
    sy = lambda y: T + (1 - (y - ymin) / (ymax - ymin)) * ph
    o = [f'<svg viewBox="0 0 {width} {height}" class="chart" role="img">']
    for t in np.linspace(ymin, ymax, 5):
        o.append(f'<line x1="{L}" x2="{L + pw}" y1="{sy(t):.1f}" y2="{sy(t):.1f}" class="grid"/>'
                 f'<text x="{L - 6}" y="{sy(t) + 4:.1f}" text-anchor="end" class="tick">{pct(t)}</text>')
    for x in xs[::max(1, len(xs) // 7)]:
        o.append(f'<text x="{sx(x):.1f}" y="{T + ph + 18}" text-anchor="middle" class="tick">{x:g}</text>')
    o.append(f'<text x="{L + pw / 2}" y="{height - 2}" text-anchor="middle" class="tick">{esc(xlab)}</text>')
    used = []
    for name, ys, cls in series:
        pts = [(sx(x), sy(y)) for x, y in zip(xs, ys) if y == y]
        if not pts:
            continue
        o.append(f'<polyline points="{" ".join(f"{a:.1f},{b:.1f}" for a, b in pts)}" class="ln {cls}"/>')
        for (a, b), x, y in zip(pts, xs, ys):
            o.append(f'<g><title>{esc(name)} @ {xlab} {x:g}: {pct(y)}</title><circle cx="{a:.1f}" cy="{b:.1f}" r="9" class="hit"/>'
                     f'<circle cx="{a:.1f}" cy="{b:.1f}" r="3.5" class="dot {cls}"/></g>')
        a, b = pts[-1]
        last = [y for y in ys if y == y][-1]
        while any(abs(b - u) < 14 for u in used):   # keep end labels from overlapping
            b += 14
        used.append(b)
        o.append(f'<text x="{a + 8:.1f}" y="{b + 4:.1f}" class="lab">{esc(name)} {pct(last)}</text>')
    o.append('</svg>')
    return ''.join(o)


def heatmap(cm, labels, cell=22):
    n = len(labels); L = 110; T = 110
    o = [f'<svg viewBox="0 0 {L + n * cell + 10} {T + n * cell + 10}" class="chart heat" role="img">']
    for j, l in enumerate(labels):
        o.append(f'<text transform="translate({L + j * cell + cell / 2 + 4},{T - 6}) rotate(-60)" class="tick">{esc(l)}</text>')
    for i, l in enumerate(labels):
        o.append(f'<text x="{L - 6}" y="{T + i * cell + cell / 2 + 4}" text-anchor="end" class="tick">{esc(l)}</text>')
        tot = cm[i].sum()
        for j in range(n):
            v = cm[i, j] / tot if tot else 0
            step = min(6, int(v * 7))   # 0..6 -> seq ramp classes
            o.append(f'<g><title>true {esc(l)} → predicted {esc(labels[j])}: {pct(v)} ({cm[i, j]} of {tot})</title>'
                     f'<rect x="{L + j * cell}" y="{T + i * cell}" width="{cell - 2}" height="{cell - 2}" rx="2" class="q{step}"/></g>')
    o.append('</svg>')
    return ''.join(o)


def thumb(i, size=112):
    p = os.path.join(HERE, 'data', 'crops', f'{i}.jpg')
    if not os.path.exists(p):
        return ''
    im = Image.open(p).resize((size, size))
    b = io.BytesIO(); im.save(b, 'JPEG', quality=80)
    return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()


# ---------- sections ----------
def tiles():
    t = [('Genus, test', R.get('test', {}).get('genus_top1'), f'{len(genera)} classes'),
         ('Species, test', R.get('test', {}).get('species_top1'), f'{len(species)} classes'),
         ('Genus, Annex City', R.get('annex_c', {}).get('genus_top1'), 'independent survey'),
         ('Genus, Annex private', R.get('annex_p', {}).get('genus_top1'), 'backyards, never trained on')]
    return '<div class="tiles">' + ''.join(
        f'<div class="tile"><div class="tl">{esc(a)}</div><div class="tv">{pct(v)}</div><div class="ts">top-1 · {esc(s)}</div></div>'
        for a, v, s in t) + '</div>'


def sets_table():
    rows = []
    for k, lab in SET_LABELS:
        m = R.get(k)
        if not m:
            continue
        rows.append(f'<tr><td>{esc(lab)}</td><td class="n">{m.get("genus_n", 0):,}</td><td class="n">{pct(m.get("genus_top1"))}</td>'
                    f'<td class="n">{pct(m.get("genus_top3"))}</td><td class="n">{m.get("species_n", 0):,}</td>'
                    f'<td class="n">{pct(m.get("species_top1"))}</td><td class="n">{pct(m.get("species_top3"))}</td></tr>')
    bars = hbar_rows([{'label': lab, 'v': R[k].get('genus_top1'), 'n': R[k].get('genus_n')} for k, lab in SET_LABELS if R.get(k)])
    return (f'<h2>Accuracy by evaluation set</h2><p class="note">Genus top-1. Top-3 = the true class is among the model’s three best guesses.</p>{bars}'
            '<table><thead><tr><th>Set</th><th class="n">Genus n</th><th class="n">Top-1</th><th class="n">Top-3</th>'
            '<th class="n">Species n</th><th class="n">Top-1</th><th class="n">Top-3</th></tr></thead><tbody>' + ''.join(rows) + '</tbody></table>')


def annex_location():
    d = P[(P.split == 'annex') & P.genus_cls.notna() & P.location.notna()]
    if d.empty:
        return ''
    rows = []
    for code, g in d.groupby('location'):
        if len(g) >= 30:
            rows.append({'label': LOC.get(code, code), 'v': float((g.genus_pred == g.genus_cls).mean()), 'n': len(g)})
    rows.sort(key=lambda r: -r['n'])
    return ('<h2>Annex survey by where the tree stands</h2><p class="note">Genus top-1. The model only ever trained on '
            'boulevard and park trees; back and side yards test whether it carries over to private canopy. Groups under 30 trees omitted.</p>'
            + hbar_rows([dict(r, label=f"{r['label']} (n={r['n']:,})") for r in rows]))


def curve():
    H = R.get('history', [])
    if not H:
        return ''
    xs = [h['epoch'] + 1 for h in H]
    return ('<h2>Validation accuracy while training</h2>' +
            line_chart(xs, [('Genus', [h.get('genus_top1', np.nan) for h in H], 's1'),
                            ('Species', [h.get('species_top1', np.nan) for h in H], 's2')], 'top-1') +
            '<div class="legend"><span class="sw s1"></span>Genus <span class="sw s2"></span>Species</div>')


def per_class(split='test'):
    d = P[(P.split == split) & P.genus_cls.notna()]
    if d.empty:
        return ''
    rows = []
    for g in genera:
        t, pr = d.genus_cls == g, d.genus_pred == g
        if t.sum() == 0:
            continue
        rows.append({'label': g, 'n': int(t.sum()), 'recall': (t & pr).sum() / t.sum(),
                     'precision': (t & pr).sum() / pr.sum() if pr.sum() else np.nan})
    rows.sort(key=lambda r: -r['n'])
    W, h, L, pw = 640, 24, 120, 380
    o = [f'<svg viewBox="0 0 {W} {h * len(rows) + 30}" class="chart" role="img">']
    for t in (0, .25, .5, .75, 1):
        x = L + t * pw
        o.append(f'<line x1="{x}" x2="{x}" y1="0" y2="{h * len(rows)}" class="grid"/><text x="{x}" y="{h * len(rows) + 16}" text-anchor="middle" class="tick">{pct(t)}</text>')
    for i, r in enumerate(rows):
        y = i * h + h / 2
        o.append(f'<text x="{L - 8}" y="{y + 4}" text-anchor="end" class="lab">{esc(r["label"])}</text>'
                 f'<text x="{L + pw + 12}" y="{y + 4}" class="tick">n={r["n"]:,}</text>')
        a, b = r['recall'], r['precision']
        if b == b:
            o.append(f'<line x1="{L + min(a, b) * pw:.1f}" x2="{L + max(a, b) * pw:.1f}" y1="{y}" y2="{y}" class="conn"/>')
        for v, cls, nm in ((a, 's1', 'recall'), (b, 's2', 'precision')):
            if v == v:
                o.append(f'<g><title>{esc(r["label"])} {nm}: {pct(v)}</title><circle cx="{L + v * pw:.1f}" cy="{y}" r="9" class="hit"/>'
                         f'<circle cx="{L + v * pw:.1f}" cy="{y}" r="5" class="dot {cls}"/></g>')
    o.append('</svg>')
    return ('<h2>Per-genus recall and precision (test)</h2><p class="note">Recall: share of trees of that genus the model gets right. '
            'Precision: share of the model’s calls for that genus that are right. Sorted by how many test trees there are.</p>'
            + ''.join(o) + '<div class="legend"><span class="sw s1"></span>Recall <span class="sw s2"></span>Precision</div>')


def confusion(split='test'):
    d = P[(P.split == split) & P.genus_cls.isin(genera)]
    if d.empty:
        return ''
    idx = {g: i for i, g in enumerate(genera)}
    cm = np.zeros((len(genera), len(genera)), int)
    for t, p in zip(d.genus_cls, d.genus_pred):
        cm[idx[t], idx[p]] += 1
    keep = cm.sum(1) > 0
    cm = cm[keep][:, keep]
    return ('<h2>Where genera get confused (test)</h2><p class="note">Each row is the true genus, normalised to 100%; '
            'darker = more of that row’s trees predicted as the column. The diagonal is correct.</p>'
            + heatmap(cm, [g for g, k in zip(genera, keep) if k]))


def calibration():
    out = []
    for split, lab in (('test', 'Test'), ('annex', 'Annex survey')):
        d = P[(P.split == split) & P.genus_cls.notna()]
        if d.empty:
            continue
        ok = (d.genus_pred == d.genus_cls).values; conf = d.genus_p.values
        th = np.round(np.arange(0, 0.91, 0.05), 2)
        acc = [ok[conf >= t].mean() if (conf >= t).any() else np.nan for t in th]
        cov = [(conf >= t).mean() for t in th]
        out.append(f'<h3>{lab}</h3>' + line_chart(list(th), [('Accuracy', acc, 's1'), ('Coverage', cov, 's2')], '', xlab='confidence threshold'))
    if not out:
        return ''
    return ('<h2>Trading coverage for accuracy</h2><p class="note">If we only keep genus predictions above a confidence threshold: '
            'accuracy of the kept predictions, and the share of trees kept. Pick a threshold for any map built from this.</p>'
            + ''.join(out) + '<div class="legend"><span class="sw s1"></span>Accuracy of kept <span class="sw s2"></span>Share kept</div>')


def dbh():
    d = P[(P.split == 'test') & P.dbh_cm.notna() & P.dbh_pred.notna()]
    if d.empty:
        return ''
    err = (d.dbh_pred - d.dbh_cm).abs()
    r = np.corrcoef(np.log(d.dbh_pred), np.log(d.dbh_cm.clip(1)))[0, 1]
    bins = pd.cut(d.dbh_cm, [0, 20, 35, 50, 75, 300])
    rows = [{'label': f'{int(b.left)}–{int(b.right)} cm', 'v': float(err[bins == b].median()), 'n': int((bins == b).sum())}
            for b in bins.cat.categories if (bins == b).any()]
    mx = max(r_['v'] for r_ in rows) * 1.1
    return (f'<h2>Trunk diameter from the air (auxiliary head)</h2><p class="note">Median absolute error {err.median():.0f} cm overall; '
            f'correlation of log diameters r = {r:.2f}. Median error by true diameter:</p>'
            + hbar_rows(rows, fmt=lambda v: f'{v:.0f} cm', max_v=mx))


def gallery():
    out = []
    for split, lab in (('test', 'test'), ('annex', 'Annex survey')):
        d = P[(P.split == split) & P.genus_cls.notna()]
        if d.empty:
            continue
        right = d[d.genus_pred == d.genus_cls].nlargest(12, 'genus_p')
        wrong = d[d.genus_pred != d.genus_cls].nlargest(12, 'genus_p')
        for title, sub in ((f'Confident and right ({lab})', right), (f'Confident and wrong ({lab})', wrong)):
            cards = ''.join(
                f'<figure><img src="{thumb(r.id)}" alt="" loading="lazy"><figcaption><b>{esc(str(r.sp if isinstance(r.sp, str) else r.genus_cls))}</b><br>'
                f'pred {esc(r.genus_pred)} {pct(r.genus_p)}' + (f'<br>{esc(str(r.common))}' if isinstance(r.common, str) else '') + '</figcaption></figure>'
                for r in sub.itertuples())
            out.append(f'<h3>{esc(title)}</h3><div class="gal">{cards}</div>')
    return ('<h2>Examples</h2><p class="note">Crops are ~21 m across; the labelled tree is at the centre.</p>' + ''.join(out)) if out else ''


CSS = """
:root{--surface:#fcfcfb;--text:#0b0b0b;--text2:#52514e;--muted:#8a8984;--grid:#e6e5e1;--track:#f0efec;
--s1:#2a78d6;--s2:#eb6834;--q0:#f4f3f0;--q1:#cde2fb;--q2:#9ec5f4;--q3:#6da7ec;--q4:#3987e5;--q5:#256abf;--q6:#104281;}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--surface:#1a1a19;--text:#f0efec;--text2:#c3c2b7;--muted:#8f8e86;
--grid:#2e2e2c;--track:#262624;--s1:#3987e5;--s2:#d95926;--q0:#232322;--q1:#104281;--q2:#184f95;--q3:#256abf;--q4:#3987e5;--q5:#6da7ec;--q6:#b7d3f6;}}
:root[data-theme="dark"]{--surface:#1a1a19;--text:#f0efec;--text2:#c3c2b7;--muted:#8f8e86;--grid:#2e2e2c;--track:#262624;--s1:#3987e5;--s2:#d95926;
--q0:#232322;--q1:#104281;--q2:#184f95;--q3:#256abf;--q4:#3987e5;--q5:#6da7ec;--q6:#b7d3f6;}
body{background:var(--surface);color:var(--text);font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0 auto;max-width:960px;padding:24px 16px 64px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:40px 0 6px}h3{font-size:15px;margin:20px 0 6px;color:var(--text2)}
.note{color:var(--text2);margin:0 0 12px;max-width:68ch}.chart{width:100%;height:auto;max-width:760px;display:block}.heat{max-width:720px}
.lab{font-size:12px;fill:var(--text)}.val,.tick{font-size:11px;fill:var(--text2)}.grid{stroke:var(--grid);stroke-width:1}
.track{fill:var(--track)}rect.s1{fill:var(--s1)}.ln{fill:none;stroke-width:2}.ln.s1{stroke:var(--s1)}.ln.s2{stroke:var(--s2)}
.dot.s1{fill:var(--s1)}.dot.s2{fill:var(--s2)}.dot{stroke:var(--surface);stroke-width:2}.hit{fill:transparent}.conn{stroke:var(--muted);stroke-width:2}
.q0{fill:var(--q0)}.q1{fill:var(--q1)}.q2{fill:var(--q2)}.q3{fill:var(--q3)}.q4{fill:var(--q4)}.q5{fill:var(--q5)}.q6{fill:var(--q6)}
.legend{font-size:12px;color:var(--text2);margin:4px 0 0}.sw{display:inline-block;width:10px;height:10px;border-radius:50%;margin:0 4px 0 12px;vertical-align:-1px}
.sw.s1{background:var(--s1)}.sw.s2{background:var(--s2)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:20px 0}
.tile{border:1px solid var(--grid);border-radius:8px;padding:12px 14px}.tl{font-size:12px;color:var(--text2)}.tv{font-size:32px;font-weight:600}.ts{font-size:12px;color:var(--muted)}
table{border-collapse:collapse;width:100%;margin-top:12px;font-size:13px}th,td{padding:6px 8px;border-bottom:1px solid var(--grid);text-align:left}
.n{text-align:right;font-variant-numeric:tabular-nums}.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px}
figure{margin:0}figure img{width:100%;border-radius:4px;display:block}figcaption{font-size:11px;color:var(--text2);line-height:1.3;margin-top:4px}
"""

page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tree Species Model</title><style>{CSS}</style></head><body>
<h1>Toronto tree species from 2025 aerial imagery</h1>
<p class="note">{esc(R.get('model', ''))}, trained on {len(genera)} genus and {len(species)} species classes from City street trees whose
inventory point sits on the boulevard. Test areas are 1 km cells never seen in training; the Annex is held out entirely.</p>
{tiles()}{sets_table()}{annex_location()}{curve()}{per_class()}{confusion()}{calibration()}{dbh()}{gallery()}
</body></html>"""
out = os.path.join(RUN, 'report.html')
open(out, 'w').write(page)
print(out, f'{len(page) / 1e6:.1f} MB')
