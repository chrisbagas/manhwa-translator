"""Score engine output (JSON from analyze-node) against fixture ground truth: CER + region counts."""
import json, sys
sys.path.insert(0, '../service')
FIX = '../service/tests/fixtures/generated/'
def lev(a, b):
    d = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        p, d[0] = d[0], i
        for j, cb in enumerate(b, 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (ca != cb))
    return d[-1]
d = json.load(sys.stdin)
err = tot = 0
for n, r in d['results'].items():
    try: gt = json.load(open(FIX + n + '.json'))
    except FileNotFoundError: continue
    ref = ''.join(b['text'] for b in gt['blocks'] if b['kind'] != 'sfx').replace('\n', '').replace(' ', '')
    got = ''.join(x['text'] for x in r['regions'] if x['kind'] != 'sfx').replace(' ', '')
    e = lev(got, ref); err += e; tot += len(ref)
    print(f"{n:18s} {r['ms']:6d} ms  regions {len(r['regions'])}/{len(gt['blocks'])}  CER {e/len(ref):.3f}  det {r['timingsMs']['detect']} rec {r['timingsMs']['recognize']} layout {r['timingsMs']['layout']}")
print(f"overall CER {err/tot:.3f} ({err}/{tot}); load {d['loadMs']} ms; rss {d['rssMB']} MB")
