"""Attribute resident (Rss) anonymous memory in an smaps dump to the strace family that mmap'd it.
Usage: combine.py <smaps file> <retained.json> """
import bisect, collections, json, re, sys

smaps_path, ret_path = sys.argv[1], sys.argv[2]
retained = sorted(json.load(open(ret_path)))
starts = [r[0] for r in retained]
tid_of = {r[0]: r[3] for r in retained}

head = re.compile(r"^([0-9a-f]+)-([0-9a-f]+)\s+(\S+)\s+\S+\s+\S+\s+\S+\s*(.*)$")
maps = []
cur = None
for line in open(smaps_path, errors="replace"):
    m = head.match(line.rstrip("\n"))
    if m:
        cur = {"s": int(m.group(1), 16), "e": int(m.group(2), 16), "perms": m.group(3), "name": m.group(4).strip(), "rss": 0}
        maps.append(cur)
        continue
    r = re.match(r"^Rss:\s+(\d+) kB", line)
    if r and cur is not None:
        cur["rss"] = int(r.group(1))

anon = [m for m in maps if m["name"] in ("", "[anon]")]
print(f"smaps: {len(maps)} mappings, anonymous {len(anon)}, anonymous RSS {sum(m['rss'] for m in anon)/1024:.1f} MB")
by_fam = collections.defaultdict(lambda: [0, 0])  # family -> [rss KB, mappings]
by_tid = collections.Counter()
unmatched = [0, 0]
for m in anon:
    i = bisect.bisect_right(starts, m["s"]) - 1
    fam = None
    if i >= 0 and retained[i][0] <= m["s"] < retained[i][1]:
        fam = retained[i][2]
        m["tid"] = retained[i][3]
    if fam is None:
        unmatched[0] += m["rss"]; unmatched[1] += 1
        continue
    by_fam[fam][0] += m["rss"]; by_fam[fam][1] += 1
    by_tid[m.get("tid", "?")] += m["rss"]
print(f"matched to a traced mmap: {sum(v[0] for v in by_fam.values())/1024:.1f} MB; unmatched: {unmatched[0]/1024:.1f} MB in {unmatched[1]} mappings")
print("\nresident anonymous MB by stack family (top 20):")
for fam, (kb, n) in sorted(by_fam.items(), key=lambda kv: -kv[1][0])[:20]:
    print(f"  {kb/1024:8.1f} MB  {n:5d} mappings  {fam}")
print("\nresident anonymous MB by creating thread id (top 12):")
for tid, kb in by_tid.most_common(12):
    print(f"  tid {tid:>8}  {kb/1024:8.1f} MB")
