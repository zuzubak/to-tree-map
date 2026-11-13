"""Pack every crop JPEG into one crops.bin + crops_index.csv (id, offset, length).

Kaggle serves datasets from a network mount where opening 100k+ small files is the
bottleneck; one big file reads sequentially into RAM in seconds. A .bin isn't auto-
extracted the way a .zip is.
"""
import os, sys, pandas as pd
src, out = sys.argv[1], sys.argv[2]
ids, offs, lens, off = [], [], [], 0
with open(os.path.join(out, 'crops.bin'), 'wb') as f:
    for name in sorted(os.listdir(src)):
        if not name.endswith('.jpg'):
            continue
        b = open(os.path.join(src, name), 'rb').read()
        f.write(b); ids.append(name[:-4]); offs.append(off); lens.append(len(b)); off += len(b)
pd.DataFrame({'id': ids, 'offset': offs, 'length': lens}).to_csv(os.path.join(out, 'crops_index.csv'), index=False)
print(len(ids), 'crops,', off / 1e9, 'GB')
