"""Train a tree genus/species classifier on 2025 Toronto ortho crops (Kaggle GPU script).

Input dataset (attached under /kaggle/input/): manifest.csv, genus_classes.csv,
species_classes.csv, crops.bin + crops_index.csv (every 192 px crop's JPEG bytes packed
end to end; ~0.108 m/px, labelled tree at the centre). See pack_crops.py.

One ConvNeXt-Tiny backbone, three heads: genus (CE), species (CE, ignored where the tree's
species isn't a class), log-DBH (smooth L1, auxiliary). Evaluates with 8-way dihedral TTA on
test, annex_street (City street trees inside the held-out Annex) and annex (Annex
Neighbourwoods survey, incl. private trees). Everything lands in /kaggle/working.

Run locally for a smoke test with:  python train.py --data <dir> --smoke
"""
import argparse, glob, io, json, os, time
import numpy as np, pandas as pd, torch, torch.nn as nn, torch.nn.functional as F
from PIL import Image
from torch.utils.data import DataLoader, Dataset
import timm

p = argparse.ArgumentParser()
p.add_argument('--data', default=None)
p.add_argument('--out', default='/kaggle/working')
p.add_argument('--model', default='convnext_tiny.fb_in22k')
p.add_argument('--epochs', type=int, default=14)
p.add_argument('--bs', type=int, default=96)
p.add_argument('--lr', type=float, default=4e-4)
p.add_argument('--workers', type=int, default=4)
p.add_argument('--smoke', action='store_true')
args = p.parse_args()

def find(root, want):
    """First directory under root holding a file that satisfies want(name). Walks top-down
    and stops early; Kaggle's input mount is slow to glob across 100k+ files."""
    for d, _, fs in os.walk(root, followlinks=True):
        if any(want(f) for f in fs):
            return d
    raise FileNotFoundError(root)


if args.data is None:   # find the attached dataset wherever Kaggle mounted it
    args.data = find('/kaggle/input', lambda f: f == 'manifest.csv')
WEIGHTS = next(iter(sorted(sum((glob.glob('/kaggle/input/' + '*/' * k + '*.safetensors') for k in range(1, 5)), []))), None)
t_load = time.time()
BLOB = np.fromfile(os.path.join(args.data, 'crops.bin'), dtype=np.uint8)   # all JPEGs, ~1.7 GB, one sequential read
IDX = pd.read_csv(os.path.join(args.data, 'crops_index.csv'))
print('data', args.data, 'weights', WEIGHTS, f'blob {BLOB.nbytes/1e9:.2f} GB in {time.time()-t_load:.0f}s', flush=True)
os.makedirs(args.out, exist_ok=True)
dev = 'cuda' if torch.cuda.is_available() else 'cpu'

M = pd.read_csv(os.path.join(args.data, 'manifest.csv'), low_memory=False)
genera = pd.read_csv(os.path.join(args.data, 'genus_classes.csv'), header=None)[0].tolist()
species = pd.read_csv(os.path.join(args.data, 'species_classes.csv'), header=None)[0].tolist()
gi, si = {g: i for i, g in enumerate(genera)}, {s: i for i, s in enumerate(species)}
M['g'] = M.genus_cls.map(gi).fillna(-1).astype(int)
M['s'] = M.species_cls.map(si).fillna(-1).astype(int)
M['d'] = np.log(M.dbh_cm.clip(1, 300)).where(M.dbh_cm.notna(), np.nan)
M = M.merge(IDX, on='id', how='inner')
if args.smoke:
    M = M.groupby('split').head(256); args.epochs = 1
print(M.split.value_counts().to_dict(), flush=True)

MEAN = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1); STD = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)


class Crops(Dataset):
    def __init__(self, df, train):
        self.df, self.train = df.reset_index(drop=True), train

    def __len__(self):
        return len(self.df)

    def __getitem__(self, i):
        r = self.df.iloc[i]
        jpg = io.BytesIO(BLOB[r.offset:r.offset + r.length].tobytes())
        x = torch.from_numpy(np.array(Image.open(jpg).convert('RGB'))).permute(2, 0, 1).float() / 255
        if self.train:
            k = np.random.randint(4); x = torch.rot90(x, k, (1, 2))
            if np.random.rand() < .5: x = x.flip(2)
            dx, dy = np.random.randint(-12, 13, 2)                      # labels are a few m loose
            x = torch.roll(x, (int(dy), int(dx)), (1, 2))
            x = (x * np.random.uniform(.8, 1.2) + np.random.uniform(-.06, .06)).clamp(0, 1)
        return (x - MEAN) / STD, r.g, r.s, (r.d if r.d == r.d else -99.0)


def model():
    if WEIGHTS:   # offline: weights shipped as a Kaggle dataset
        from safetensors.torch import load_file
        m = timm.create_model(args.model, pretrained=False, num_classes=0)
        m.load_state_dict(load_file(WEIGHTS))
    else:
        m = timm.create_model(args.model, pretrained=True, num_classes=0)
    n = m.num_features
    m.heads = nn.ModuleDict({'g': nn.Linear(n, len(genera)), 's': nn.Linear(n, len(species)), 'd': nn.Linear(n, 1)})
    return m


def fwd(m, x):
    f = m(x)
    return m.heads['g'](f), m.heads['s'](f), m.heads['d'](f).squeeze(1)


net = model().to(dev).to(memory_format=torch.channels_last)
tr = M[M.split == 'train']
dl = DataLoader(Crops(tr, True), args.bs, shuffle=True, num_workers=args.workers, drop_last=True, pin_memory=True, persistent_workers=args.workers > 0)
opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=0.05)
steps = args.epochs * len(dl)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, args.lr, total_steps=steps, pct_start=0.06)
scaler = torch.cuda.amp.GradScaler(enabled=dev == 'cuda')


@torch.no_grad()
def predict(df, tta=False):
    net.eval()
    L = DataLoader(Crops(df, False), args.bs * 2, num_workers=args.workers)
    G, S, D = [], [], []
    for x, *_ in L:
        x = x.to(dev).to(memory_format=torch.channels_last)
        views = [torch.rot90(v, k, (2, 3)) for v in ([x, x.flip(3)] if tta else [x]) for k in (range(4) if tta else [0])]
        with torch.autocast(dev, enabled=dev == 'cuda'):
            outs = [fwd(net, v) for v in views]
        G.append(torch.stack([o[0].float().softmax(1) for o in outs]).mean(0).cpu())
        S.append(torch.stack([o[1].float().softmax(1) for o in outs]).mean(0).cpu())
        D.append(torch.stack([o[2].float() for o in outs]).mean(0).cpu())
    net.train()
    return torch.cat(G).numpy(), torch.cat(S).numpy(), torch.cat(D).numpy()


def metrics(df, G, S):
    out = {'n': len(df)}
    m = df.g.values >= 0
    if m.any():
        out['genus_top1'] = float((G[m].argmax(1) == df.g.values[m]).mean())
        out['genus_top3'] = float((np.argsort(-G[m], 1)[:, :3] == df.g.values[m, None]).any(1).mean())
        out['genus_n'] = int(m.sum())
    m = df.s.values >= 0
    if m.any():
        out['species_top1'] = float((S[m].argmax(1) == df.s.values[m]).mean())
        out['species_top3'] = float((np.argsort(-S[m], 1)[:, :3] == df.s.values[m, None]).any(1).mean())
        out['species_n'] = int(m.sum())
    return out


va = M[M.split == 'val']
best, hist, t0, start = -1, [], time.time(), 0
CKPT = os.path.join(args.out, 'ckpt.pt')
if os.path.exists(CKPT):   # resume after a disconnect (Colab) from the last finished epoch
    c = torch.load(CKPT, map_location=dev, weights_only=False)
    net.load_state_dict(c['net']); opt.load_state_dict(c['opt']); sched.load_state_dict(c['sched']); scaler.load_state_dict(c['scaler'])
    best, hist, start = c['best'], c['hist'], c['epoch'] + 1
    print('resumed after epoch', c['epoch'], flush=True)
for ep in range(start, args.epochs):
    tot = 0
    for i, (x, g, s, d) in enumerate(dl):
        x, g, s, d = x.to(dev, non_blocking=True).to(memory_format=torch.channels_last), g.to(dev), s.to(dev), d.to(dev).float()
        with torch.autocast(dev, enabled=dev == 'cuda'):
            lg, ls, ld = fwd(net, x)
            loss = F.cross_entropy(lg.float(), g, ignore_index=-1, label_smoothing=.1)
            if (s >= 0).any():
                loss = loss + F.cross_entropy(ls.float(), s, ignore_index=-1, label_smoothing=.1)
            dm = d > -50
            if dm.any():
                loss = loss + .3 * F.smooth_l1_loss(ld.float()[dm], d[dm])
        opt.zero_grad(set_to_none=True)
        scaler.scale(loss).backward(); scaler.step(opt); scaler.update(); sched.step()
        tot += loss.item()
        if i % 200 == 0:
            print(f'ep {ep} it {i}/{len(dl)} loss {loss.item():.3f} {time.time()-t0:.0f}s', flush=True)
    G, S, _ = predict(va)
    mv = metrics(va, G, S); mv.update(epoch=ep, train_loss=tot / len(dl), secs=time.time() - t0)
    hist.append(mv); print(json.dumps(mv), flush=True)
    score = mv.get('genus_top1', 0) + mv.get('species_top1', 0)
    if score > best:
        best = score; torch.save(net.state_dict(), os.path.join(args.out, 'model.pt'))
    torch.save({'net': net.state_dict(), 'opt': opt.state_dict(), 'sched': sched.state_dict(), 'scaler': scaler.state_dict(),
                'best': best, 'hist': hist, 'epoch': ep}, CKPT + '.tmp')
    os.replace(CKPT + '.tmp', CKPT)

net.load_state_dict(torch.load(os.path.join(args.out, 'model.pt'), map_location=dev))
report = {'history': hist, 'model': args.model, 'genera': genera, 'species': species}
preds = []
for split in ['test', 'annex_street', 'annex']:
    df = M[M.split == split]
    if not len(df):
        continue
    G, S, D = predict(df, tta=True)
    report[split] = metrics(df, G, S)
    if split == 'test':   # the NW corner was flown before leaf-out; the rest is in leaf
        nw = ((df.lat > 43.72) & (df.lon < -79.45)).values
        for nm, k in [('test_leafoff_nw', np.flatnonzero(nw)), ('test_leafon', np.flatnonzero(~nw))]:
            report[nm] = metrics(df.iloc[k], G[k], S[k])
    if split == 'annex':
        own = df.site.fillna('?').values          # site holds Annex ownership code (c=city, p=private, ...)
        for o in np.unique(own):
            k = np.flatnonzero(own == o)
            report[f'annex_{o}'] = metrics(df.iloc[k], G[k], S[k])
    print(split, json.dumps(report[split]), flush=True)
    preds.append(pd.DataFrame({'id': df.id.values, 'split': split,
                               'genus_pred': np.array(genera)[G.argmax(1)], 'genus_p': G.max(1),
                               'species_pred': np.array(species)[S.argmax(1)], 'species_p': S.max(1),
                               'dbh_pred': np.exp(D)}))
    np.save(os.path.join(args.out, f'probs_{split}_genus.npy'), G.astype(np.float16))
    np.save(os.path.join(args.out, f'probs_{split}_species.npy'), S.astype(np.float16))
pd.concat(preds).to_csv(os.path.join(args.out, 'predictions.csv'), index=False)
json.dump(report, open(os.path.join(args.out, 'report.json'), 'w'), indent=1)
print('done', time.time() - t0)
