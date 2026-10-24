"""Median and min-max per checkpoint for mem-bench JSONL runs.

Usage: python3 aggregate.py <dir>   where files are named <tree>-<mode>-<run>.jsonl
(mode `nocompact` means session-nocompact). Prints RSS and heap medians with ranges and the delta
between the two trees (first tree: base, second: head).
"""
import glob, json, os, statistics, sys

rows = {}
for f in glob.glob(os.path.join(sys.argv[1], "*.jsonl")):
    tree, rest = os.path.basename(f)[:-6].split("-", 1)
    mode, _run = rest.rsplit("-", 1)
    mode = "session-nocompact" if mode == "nocompact" else mode
    for line in open(f):
        d = json.loads(line)
        rows.setdefault((mode, d["turn"], tree), []).append(d)

for mode in ["session", "session-nocompact", "render", "tui"]:
    for turn in [50, 100, 200]:
        b, h = rows.get((mode, turn, "base"), []), rows.get((mode, turn, "head"), [])
        if not b or not h:
            continue
        bm, hm = [x["rssMB"] for x in b], [x["rssMB"] for x in h]
        bh, hh = [x["heapUsedMB"] for x in b], [x["heapUsedMB"] for x in h]
        print(f"{mode:18} t{turn:<4} RSS base {statistics.median(bm):6.1f} [{min(bm):.1f}-{max(bm):.1f}]"
              f"  head {statistics.median(hm):6.1f} [{min(hm):.1f}-{max(hm):.1f}]"
              f"  heap base {statistics.median(bh):5.1f} head {statistics.median(hh):5.1f} n={len(b)}/{len(h)}")
