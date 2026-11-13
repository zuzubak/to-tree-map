"""Predict genus/species/DBH at every point in points.csv, straight from the City's 2025
ortho tile server (Kaggle kernel with internet + GPU).

Points are grouped into 16x16-tile blocks (4096 px at z20). Worker threads fetch the tiles a
block's crops touch, cut a 192 px crop centred on each point, and hand them to the main
thread, which runs the run-3 model with 4-way rotation TTA. Output: preds.npz with one row
per pid. Partial results are flushed every ~100k points so a crash keeps what's done.

Local smoke test:  python predict.py --points <csv> --model <model.pt> --classes <dir> --limit 2000
"""
import argparse, io, os, queue, threading, time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import numpy as np, pandas as pd, requests, torch, torch.nn as nn, timm
from PIL import Image

p = argparse.ArgumentParser()
p.add_argument('--points'); p.add_argument('--model'); p.add_argument('--classes')
p.add_argument('--out', default='/kaggle/working')
p.add_argument('--limit', type=int, default=0)
p.add_argument('--threads', type=int, default=16)
p.add_argument('--bs', type=int, default=256)
args = p.parse_args()


def find(name):
    for d, _, fs in os.walk('/kaggle/input', followlinks=True):
        if name in fs:
            return os.path.join(d, name)
    raise FileNotFoundError(name)


args.points = args.points or find('points.csv')
args.model = args.model or find('model.pt')
args.classes = args.classes or os.path.dirname(find('genus_classes.csv'))
URL = 'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_ortho_2025_color_8cm/MapServer/tile/20/{y}/{x}'
SIZE, H = 192, 96
dev = 'cuda' if torch.cuda.is_available() else 'cpu'

P = pd.read_csv(args.points, usecols=['pid', 'lon', 'lat'])
if args.limit:
    P = P.head(args.limit)
n = 256 * 2 ** 20
P['px'] = ((P.lon + 180) / 360 * n).round().astype(int)
lat = np.radians(P.lat)
P['py'] = ((1 - np.log(np.tan(lat) + 1 / np.cos(lat)) / np.pi) / 2 * n).round().astype(int)
blocks = [g for _, g in P.groupby([P.py // 4096, P.px // 4096], sort=False)]
print(len(P), 'points', len(blocks), 'blocks', dev, flush=True)

genera = pd.read_csv(os.path.join(args.classes, 'genus_classes.csv'), header=None)[0].tolist()
species = pd.read_csv(os.path.join(args.classes, 'species_classes.csv'), header=None)[0].tolist()
net = timm.create_model('convnext_tiny.fb_in22k', pretrained=False, num_classes=0)
nf = net.num_features
net.heads = nn.ModuleDict({'g': nn.Linear(nf, len(genera)), 's': nn.Linear(nf, len(species)), 'd': nn.Linear(nf, 1)})
net.load_state_dict(torch.load(args.model, map_location='cpu'))
net = net.to(dev).eval().to(memory_format=torch.channels_last)
MEAN = torch.tensor([0.485, 0.456, 0.406], device=dev).view(1, 3, 1, 1) * 255
STD = torch.tensor([0.229, 0.224, 0.225], device=dev).view(1, 3, 1, 1) * 255

_local = threading.local()
BLACK = np.zeros((256, 256, 3), np.uint8)
stats = {'tiles': 0, 'missing': 0, 'errors': 0}


def get_tile(tx, ty):
    s = getattr(_local, 's', None)
    if s is None:
        s = _local.s = requests.Session(); s.headers['User-Agent'] = 'tree-crown-research/0.1'
    for attempt in range(5):
        try:
            r = s.get(URL.format(x=tx, y=ty), timeout=30)
            stats['tiles'] += 1
            if r.status_code == 200 and r.headers.get('content-type', '').startswith('image'):
                return np.asarray(Image.open(io.BytesIO(r.content)).convert('RGB'))
            if r.status_code in (404, 400) or r.status_code == 200:
                stats['missing'] += 1; return BLACK
        except Exception:
            pass
        time.sleep(2 ** attempt)
    stats['errors'] += 1
    return BLACK


def cut_block(b):
    x0 = b.px.values - H; y0 = b.py.values - H
    need = {(a // 256 + i, c // 256 + j) for a, c in zip(x0, y0) for i in (0, 1) for j in (0, 1)}   # 192 < 256: a 2x2 tile mosaic always covers a crop
    T = {k: get_tile(*k) for k in sorted(need, key=lambda k: (k[1], k[0]))}
    out = np.empty((len(b), SIZE, SIZE, 3), np.uint8)
    for i, (a, c) in enumerate(zip(x0, y0)):
        tx0, ty0 = a // 256, c // 256
        m = np.concatenate([np.concatenate([T[(tx, ty)] for tx in (tx0, tx0 + 1)], 1) for ty in (ty0, ty0 + 1)], 0)
        out[i] = m[c - ty0 * 256:c - ty0 * 256 + SIZE, a - tx0 * 256:a - tx0 * 256 + SIZE]
    return b.pid.values, out


N = int(P.pid.max()) + 1
R = {'g1': np.full(N, 255, np.uint8), 'g1p': np.zeros(N, np.float16), 'g2': np.full(N, 255, np.uint8),
     'g2p': np.zeros(N, np.float16), 's1': np.full(N, 255, np.uint8), 's1p': np.zeros(N, np.float16),
     'dbh': np.zeros(N, np.float16)}


def save():
    np.savez(os.path.join(args.out, 'preds.tmp.npz'), **R, genera=np.array(genera), species=np.array(species))
    os.replace(os.path.join(args.out, 'preds.tmp.npz'), os.path.join(args.out, 'preds.npz'))


@torch.no_grad()
def infer(pids, x):
    x = torch.from_numpy(x).to(dev).permute(0, 3, 1, 2).float()
    x = ((x - MEAN) / STD).contiguous(memory_format=torch.channels_last)
    G = S = D = 0
    with torch.autocast(dev, enabled=dev == 'cuda'):
        for k in range(4):
            f = net(torch.rot90(x, k, (2, 3)))
            G = G + net.heads['g'](f).float().softmax(1); S = S + net.heads['s'](f).float().softmax(1)
            D = D + net.heads['d'](f).float().squeeze(1)
    G, S, D = G / 4, S / 4, D / 4
    gp, gi = G.topk(2, 1); sp, si = S.max(1)
    R['g1'][pids], R['g1p'][pids] = gi[:, 0].cpu().numpy(), gp[:, 0].cpu().numpy()
    R['g2'][pids], R['g2p'][pids] = gi[:, 1].cpu().numpy(), gp[:, 1].cpu().numpy()
    R['s1'][pids], R['s1p'][pids] = si.cpu().numpy(), sp.cpu().numpy()
    R['dbh'][pids] = D.exp().cpu().numpy()


t0, done, next_save = time.time(), 0, 100_000
q = queue.Queue(maxsize=64)


def producer():
    try:
        _produce()
    except BaseException as e:   # surface worker errors in the main thread instead of hanging
        q.put(e)


def _produce():
    pending = deque()   # bounded look-ahead: ex.map would cut every block into RAM at once
    with ThreadPoolExecutor(args.threads) as ex:
        for b in blocks:
            pending.append(ex.submit(cut_block, b))
            if len(pending) >= 2 * args.threads:
                q.put(pending.popleft().result())
        while pending:
            q.put(pending.popleft().result())
    q.put(None)


threading.Thread(target=producer, daemon=True).start()
buf_p, buf_x = [], []
while True:
    item = q.get()
    if isinstance(item, BaseException):
        save(); raise item
    if item is not None:
        buf_p.append(item[0]); buf_x.append(item[1])
    while sum(len(a) for a in buf_p) >= args.bs or (item is None and buf_p):
        pids, x = np.concatenate(buf_p), np.concatenate(buf_x)
        infer(pids[:args.bs], x[:args.bs]); done += len(pids[:args.bs])
        buf_p, buf_x = ([pids[args.bs:]], [x[args.bs:]]) if len(pids) > args.bs else ([], [])
    if done >= next_save:
        save(); next_save += 100_000
        el = time.time() - t0
        print(f'{done}/{len(P)} {el/60:.0f} min, eta {el/done*(len(P)-done)/60:.0f} min, {stats}', flush=True)
    if item is None:
        break
save()
print('done', done, f'{(time.time()-t0)/60:.0f} min', stats, flush=True)
