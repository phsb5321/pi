"""Replay `strace -f -ttt -k -e trace=mmap,munmap,clone3,clone` in timestamp order.
Usage: analyze2.py <strace file> <retained.json>
Writes retained anonymous ranges [start, end, family, tid, size] and prints per-family and per-thread
summaries. Family = first stack frame outside libc/ld wrappers and allocator plumbing."""
import collections, json, re, sys

SKIP_MOD = ("ld-linux", "libc.so", "libgcc", "libstdc++")
SKIP_SYM = ("mmap", "__mmap", "mremap", "malloc", "_int_malloc", "sysmalloc", "__libc_malloc", "_dl_", "_start",
            "dl_main", "dl_sysdep", "__libc_start", "allocate_zeros", "__GI_", "__clone", "start_thread", "clone3")
BLOCK = re.compile(r"^(\d+)\s+(\d+\.\d+)\s+(.*)$")
FRAME = re.compile(r"^\s+> (\S+?)\((\S*?)\)?\s*\[")

def family(frames):
    for mod, sym in frames:
        if any(m in mod for m in SKIP_MOD):
            continue
        if any(sym.startswith(s) for s in SKIP_SYM):
            continue
        return sym[:90] if sym else f"{mod.rsplit('/', 1)[-1]}:?"
    return "(unknown)"

# 1) group lines into blocks: a syscall line plus its stack frames
blocks = []
cur = None
for line in open(sys.argv[1], errors="replace"):
    line = line.rstrip("\n")
    m = BLOCK.match(line)
    if m:
        cur = {"pid": m.group(1), "ts": float(m.group(2)), "text": m.group(3), "frames": []}
        blocks.append(cur)
        continue
    f = FRAME.match(line)
    if f and cur is not None:
        cur["frames"].append((f.group(1), (f.group(2) or "").split("+")[0]))
# 2) join unfinished/resumed pairs; a resumed block carries the frames of the completed call
done = []
open_calls = {}
for b in blocks:
    t = b["text"]
    u = re.match(r"^(\w+)\((.*?)\s*<unfinished \.\.\.>$", t)
    if u:
        open_calls[(b["pid"], u.group(1))] = b
        continue
    r = re.match(r"^<\.\.\. (\w+) resumed>\)?(.*)$", t)
    if r and (b["pid"], r.group(1)) in open_calls:
        start = open_calls.pop((b["pid"], r.group(1)))
        head = start["text"].rsplit("<unfinished", 1)[0].rstrip()
        done.append({"pid": b["pid"], "ts": b["ts"], "text": f"{r.group(1)}({head.split('(', 1)[1]}){r.group(2)}",
                     "frames": b["frames"] or start["frames"]})
        continue
    done.append(b)
done.sort(key=lambda b: b["ts"])
# optional cutoff: replay only events up to the smaps dump (epoch seconds), so teardown is excluded
CUT = float(sys.argv[3]) + 1.0 if len(sys.argv) > 3 else float("inf")
done = [b for b in done if b["ts"] <= CUT]

# 3) replay in time order
ivals = {}  # start -> [end, family, size, tid]
starts = []
thread_creator = {}
counts = collections.Counter()
mm = re.compile(r"^(mmap)\((NULL|0x[0-9a-f]+), (\d+), ([^)]*)\)\s*= (0x[0-9a-f]+)")
um = re.compile(r"^munmap\((0x[0-9a-f]+), (\d+)\)\s*= 0")
cl = re.compile(r"^clone3\(.*\)\s*= (\d+)")

def remove(a, b):
    for s in list(ivals):
        e, fam, sz, tid = ivals[s]
        if e <= a or s >= b:
            continue
        del ivals[s]
        if s < a:
            ivals[s] = [a, fam, a - s, tid]
        if e > b:
            ivals[b] = [e, fam, e - b, tid]

for b in done:
    t = b["text"]
    c = cl.match(t)
    if c and "CLONE_THREAD" in t:
        counts["thread_clones"] += 1
        thread_creator[c.group(1)] = family(b["frames"])
        continue
    x = mm.match(t)
    if x and "MAP_ANONYMOUS" in x.group(4) and not x.group(5).startswith("0x0") and x.group(5) != "-1":
        counts["mmap_anon"] += 1
        addr, length = int(x.group(5), 16), int(x.group(3))
        ivals[addr] = [addr + length, family(b["frames"]), length, b["pid"]]
        continue
    y = um.match(t)
    if y:
        counts["munmap"] += 1
        a = int(y.group(1), 16)
        remove(a, a + int(y.group(2)))
print(f"events: {dict(counts)}  thread clones: {counts['thread_clones']}")
json.dump([[s, e, fam, tid, sz] for s, (e, fam, sz, tid) in sorted(ivals.items())], open(sys.argv[2], "w"))
print(f"retained anonymous ranges: {len(ivals)}, virtual {sum(v[2] for v in ivals.values())/1048576:.1f} MB")
json.dump(thread_creator, open(sys.argv[2] + ".threads", "w"))
