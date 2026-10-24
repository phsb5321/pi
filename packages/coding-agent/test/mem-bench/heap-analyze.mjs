// Dominator-tree analysis of V8 heap snapshots (9989-mem-bench, no dependencies).
//
// Usage: node heap-analyze.mjs <snapshot> [<later-snapshot>] [--top N] [--growers N] [--paths N]
//
// One snapshot: top-N retainers by retained size (dominator tree) and per-group self/retained sizes.
// Two snapshots (earlier, later): also the top-N growers, group retained size later minus earlier,
// and the shortest retainer path (root -> object) for the top --paths growers.
//
// Group key: "<type>|<name>" for object-like nodes; type alone for strings, code and hidden
// nodes, whose names are content or internals. Retained size of a group counts only nodes whose
// immediate dominator is not in the same group, so it does not double count nested members.
// Weak edges are excluded from the graph, as the V8 retainer semantics require.
// Algorithm: Cooper, Harvey, Kennedy, "A Simple, Fast Dominance Algorithm" (iterative).
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	if (i < 0) return dflt;
	const v = Number(args[i + 1]);
	args.splice(i, 2);
	return v;
};
const TOP = opt("--top", 15);
const GROWERS = opt("--growers", 10);
const PATHS = opt("--paths", 3);
const files = args;
if (files.length < 1 || files.length > 2) throw new Error("usage: heap-analyze.mjs <snapshot> [<later-snapshot>]");

const STRINGLIKE = new Set(["string", "concatenated string", "sliced string", "code", "hidden", "synthetic"]);

function analyze(path) {
	const snap = JSON.parse(readFileSync(path, "utf8"));
	const meta = snap.snapshot.meta;
	const NF = meta.node_fields.length;
	const EF = meta.edge_fields.length;
	const iType = meta.node_fields.indexOf("type");
	const iName = meta.node_fields.indexOf("name");
	const iSelf = meta.node_fields.indexOf("self_size");
	const iEdgeCount = meta.node_fields.indexOf("edge_count");
	const eType = meta.edge_fields.indexOf("type");
	const eName = meta.edge_fields.indexOf("name_or_index");
	const eTo = meta.edge_fields.indexOf("to_node");
	const nodeTypes = meta.node_types[iType];
	const edgeTypes = meta.edge_types[eType];
	const WEAK = edgeTypes.indexOf("weak");
	const strings = snap.strings;
	const nodes = snap.nodes;
	const edges = snap.edges;
	const N = nodes.length / NF;

	// CSR of non-weak out-edges plus per-node metadata.
	const self = new Float64Array(N);
	const type = new Uint8Array(N);
	const nameIdx = new Uint32Array(N);
	const firstEdge = new Uint32Array(N + 1);
	const outTo = [];
	const outName = [];
	const outType = [];
	let e = 0;
	for (let i = 0; i < N; i++) {
		const base = i * NF;
		self[i] = nodes[base + iSelf];
		type[i] = nodes[base + iType];
		nameIdx[i] = nodes[base + iName];
		const count = nodes[base + iEdgeCount];
		firstEdge[i] = outTo.length;
		for (let k = 0; k < count; k++, e += EF) {
			if (edges[e + eType] === WEAK) continue;
			outTo.push(edges[e + eTo] / NF);
			outName.push(edges[e + eName]);
			outType.push(edges[e + eType]);
		}
	}
	firstEdge[N] = outTo.length;
	const label = (i) => {
		const t = nodeTypes[type[i]];
		return STRINGLIKE.has(t) ? t : `${t}|${strings[nameIdx[i]]}`;
	};

	// Iterative DFS from root (node 0) for postorder numbers.
	const po = new Int32Array(N).fill(-1);
	const order = []; // postorder
	const stack = [0];
	const it = new Uint32Array(N);
	for (let i = 0; i < N; i++) it[i] = firstEdge[i];
	const seen = new Uint8Array(N);
	seen[0] = 1;
	while (stack.length) {
		const v = stack[stack.length - 1];
		if (it[v] < firstEdge[v + 1]) {
			const w = outTo[it[v]++];
			if (!seen[w]) {
				seen[w] = 1;
				stack.push(w);
			}
		} else {
			stack.pop();
			po[v] = order.length;
			order.push(v);
		}
	}
	const reachable = order.length;

	// Predecessors of reachable nodes (CSR).
	const predCount = new Uint32Array(N + 1);
	for (const v of order) for (let k = firstEdge[v]; k < firstEdge[v + 1]; k++) predCount[outTo[k] + 1]++;
	for (let i = 0; i < N; i++) predCount[i + 1] += predCount[i];
	const preds = new Uint32Array(predCount[N]);
	const fill = predCount.slice(0, N);
	for (const v of order) for (let k = firstEdge[v]; k < firstEdge[v + 1]; k++) preds[fill[outTo[k]]++] = v;

	// Cooper-Harvey-Kennedy.
	const idom = new Int32Array(N).fill(-1);
	idom[0] = 0;
	const intersect = (a, b) => {
		while (a !== b) {
			while (po[a] < po[b]) a = idom[a];
			while (po[b] < po[a]) b = idom[b];
		}
		return a;
	};
	let changed = true;
	while (changed) {
		changed = false;
		for (let oi = order.length - 1; oi >= 0; oi--) {
			const v = order[oi];
			if (v === 0) continue;
			let nd = -1;
			for (let k = predCount[v]; k < predCount[v + 1]; k++) {
				const p = preds[k];
				if (idom[p] < 0) continue;
				nd = nd < 0 ? p : intersect(p, nd);
			}
			if (nd !== idom[v]) {
				idom[v] = nd;
				changed = true;
			}
		}
	}

	// Retained size: children are processed before parents in ascending postorder.
	const retained = Float64Array.from(self);
	for (const v of order) {
		if (v !== 0 && idom[v] >= 0) retained[idom[v]] += retained[v];
	}
	return { N, reachable, label, self, retained, idom, firstEdge, outTo, outName, outType, edgeTypes, strings, nodeTypes, type };
}

function groupStats(g) {
	const self = new Map();
	const ret = new Map();
	for (let i = 0; i < g.N; i++) {
		if (!g.idom || g.idom[i] < 0) continue;
		const k = g.label(i);
		self.set(k, (self.get(k) ?? 0) + g.self[i]);
		const d = g.idom[i];
		const sameGroup = i !== 0 && d !== i && g.label(d) === k;
		if (!sameGroup) ret.set(k, (ret.get(k) ?? 0) + g.retained[i]);
	}
	return { self, ret };
}

const MB = (n) => (n / 1048576).toFixed(2);
const short = (s) => (s.length > 90 ? `${s.slice(0, 87)}...` : s);

function topRetainers(g, n) {
	const idx = [];
	for (let i = 1; i < g.N; i++) if (g.idom[i] >= 0) idx.push(i);
	idx.sort((a, b) => g.retained[b] - g.retained[a]);
	return idx.slice(0, n);
}

function nodeLine(g, i) {
	return `${MB(g.retained[i]).padStart(8)} MB retained  ${MB(g.self[i]).padStart(7)} MB self  ${g.label(i)}`;
}

function pathTo(g, target) {
	// Shortest path from root by BFS over non-weak edges; returns list of [node, edgeLabel].
	const prev = new Int32Array(g.N).fill(-2);
	prev[0] = -1;
	const q = [0];
	for (let h = 0; h < q.length && prev[target] === -2; h++) {
		const v = q[h];
		for (let k = g.firstEdge[v]; k < g.firstEdge[v + 1]; k++) {
			const w = g.outTo[k];
			if (prev[w] !== -2) continue;
			prev[w] = v;
			q.push(w);
			if (w === target) break;
		}
	}
	if (prev[target] === -2) return null;
	const chain = [];
	for (let v = target; v !== 0; v = prev[v]) {
		const p = prev[v];
		let eLabel = "?";
		for (let k = g.firstEdge[p]; k < g.firstEdge[p + 1]; k++) {
			if (g.outTo[k] !== v) continue;
			const t = g.edgeTypes[g.outType[k]];
			const nm = g.outName[k];
			eLabel = t === "element" || t === "hidden" ? `[${nm}]` : g.strings[nm];
			break;
		}
		chain.push(`${g.label(p)} --${eLabel}--> `);
	}
	chain.reverse();
	return chain.map((c, i) => (i === chain.length - 1 ? `${c}${g.label(target)}` : c)).join("\n    ");
}

const A = analyze(files[0]);
console.log(`# ${files[0]}\nnodes=${A.N} reachable=${A.reachable} root retained=${MB(A.retained[0])} MB`);
console.log(`\n## top ${TOP} retainers (dominator tree, individual objects)`);
for (const i of topRetainers(A, TOP)) console.log(nodeLine(A, i));

if (files.length === 1) process.exit(0);

const B = analyze(files[1]);
console.log(`\n# later: ${files[1]}\nnodes=${B.N} reachable=${B.reachable}`);
const ga = groupStats(A);
const gb = groupStats(B);
const keys = new Set([...ga.ret.keys(), ...gb.ret.keys()]);
const rows = [...keys].map((k) => ({
	k,
	ra: ga.ret.get(k) ?? 0,
	rb: gb.ret.get(k) ?? 0,
	sa: ga.self.get(k) ?? 0,
	sb: gb.self.get(k) ?? 0,
}));
// 'synthetic' is the GC-root/system plumbing, not user data; it is never a grower.
rows.sort((x, y) => y.rb - y.ra - (x.rb - x.ra));
const growable = rows.filter((r) => !r.k.startsWith("synthetic"));
console.log(`\n## top ${GROWERS} growers, group retained size (t50 -> t200)`);
for (const r of growable.slice(0, GROWERS)) {
	console.log(`${MB(r.ra).padStart(8)} -> ${MB(r.rb).padStart(8)} MB  (${MB(r.rb - r.ra).padStart(8)})  self ${MB(r.sa)} -> ${MB(r.sb)}  ${short(r.k)}`);
}
console.log(`\n## top ${TOP} groups by retained size at t200`);
for (const r of [...rows].sort((x, y) => y.rb - x.rb).slice(0, TOP)) {
	console.log(`${MB(r.rb).padStart(8)} MB  (t50 ${MB(r.ra)})  ${short(r.k)}`);
}
for (const r of growable.slice(0, PATHS)) {
	const members = [];
	for (let i = 1; i < B.N; i++) if (B.idom[i] >= 0 && B.label(i) === r.k) members.push(i);
	members.sort((a, b) => B.retained[b] - B.retained[a]);
	if (!members.length) continue;
	console.log(`\n## retainer path, grower: ${short(r.k)}\n    target: ${nodeLine(B, members[0])}`);
	console.log(`    ${pathTo(B, members[0]) ?? "(unreachable)"}`);
}
