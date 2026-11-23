/**
 * Copy-on-write view of the message list that `context` handlers receive.
 *
 * Old path: every LLM call ran `structuredClone(messages)` over the whole
 * history, so a large session paid a full copy per call.
 *
 * This view reads the original objects. A node is copied only when a handler
 * writes to it. The copy is shallow, and every parent of the written node is
 * copied too, so the new child is reachable. Untouched messages stay shared
 * with the session state, and the view never writes to them.
 *
 * Only plain objects and arrays are wrapped. Other values (Date, Buffer, Map)
 * pass through as-is, because a Proxy breaks their internal slots.
 */

type Obj = Record<PropertyKey, unknown>;

type Node = {
	orig: object;
	copy: Obj | null;
	/** Keys a handler wrote. Null until the first write. */
	assigned: Set<PropertyKey> | null;
	/** Nodes that hold this one. A write copies them too, so the copy is reachable. */
	parent: Node | null;
	/** Further holders, only when the same object sits under two parents. */
	moreParents: Node[] | null;
	proxy: object;
};

export type ContextView = {
	/** The list to hand to a handler. */
	messages: unknown[];
	/** Turn a handler's value (or the view itself) into plain data. Call once per handler. */
	materialize(value: unknown): unknown[];
};

/** Key under which a view proxy's target holds its node. The get trap answers it, so user code never sees it. */
const NODE = Symbol("pi.contextView.node");

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null;

const isWrappable = (v: object): boolean => {
	if (Array.isArray(v)) return true;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
};

const nodeOfProxy = (v: object): Node | undefined => (v as Obj)[NODE] as Node | undefined;

export const createContextView = (messages: unknown[]): ContextView => {
	const byOrig = new Map<object, Node>();

	const current = (n: Node): Obj => n.copy ?? (n.orig as Obj);

	const ensureCopy = (n: Node): void => {
		if (n.copy) return;
		n.copy = Array.isArray(n.orig) ? (n.orig.slice() as unknown as Obj) : { ...n.orig };
		if (n.parent) ensureCopy(n.parent);
		for (const p of n.moreParents ?? []) ensureCopy(p);
	};

	const markAssigned = (n: Node, k: PropertyKey): void => {
		if (!n.assigned) n.assigned = new Set();
		n.assigned.add(k);
	};

	const wrapChild = (v: unknown, parent: Node): unknown => {
		if (!isObject(v)) return v;
		const known = byOrig.get(v);
		if (known) {
			addParent(known, parent);
			return known.proxy;
		}
		if (nodeOfProxy(v) || !isWrappable(v)) return v; // already a view proxy, or a value passed through
		return makeNode(v, parent).proxy;
	};

	const addParent = (n: Node, parent: Node | null): void => {
		if (!parent || n.parent === parent || n.moreParents?.includes(parent)) return;
		if (!n.parent) n.parent = parent;
		else {
			if (!n.moreParents) n.moreParents = [];
			n.moreParents.push(parent);
		}
	};

	const makeNode = (orig: object, parent: Node | null): Node => {
		const target = (Array.isArray(orig) ? [] : {}) as Obj;
		const n: Node = { orig, copy: null, assigned: null, parent, moreParents: null, proxy: null as unknown as object };
		target[NODE] = n;
		n.proxy = new Proxy(target, traps);
		byOrig.set(orig, n);
		return n;
	};

	const nodeOf = (t: object): Node => (t as Obj)[NODE] as Node;

	const traps: ProxyHandler<object> = {
		get(t, k) {
			const n = nodeOf(t);
			if (k === NODE) return n;
			return wrapChild(Reflect.get(current(n), k), n);
		},
		set(t, k, v) {
			const n = nodeOf(t);
			ensureCopy(n);
			markAssigned(n, k);
			return Reflect.set(n.copy as Obj, k, v);
		},
		deleteProperty(t, k) {
			const n = nodeOf(t);
			ensureCopy(n);
			markAssigned(n, k);
			return Reflect.deleteProperty(n.copy as Obj, k);
		},
		defineProperty(t, k, d) {
			const n = nodeOf(t);
			ensureCopy(n);
			markAssigned(n, k);
			return Reflect.defineProperty(n.copy as Obj, k, d);
		},
		has(t, k) {
			return Reflect.has(current(nodeOf(t)), k);
		},
		ownKeys(t) {
			return Reflect.ownKeys(current(nodeOf(t)));
		},
		getOwnPropertyDescriptor(t, k) {
			const n = nodeOf(t);
			const d = Reflect.getOwnPropertyDescriptor(current(n), k);
			if (d && "value" in d) d.value = wrapChild(d.value, n);
			return d;
		},
		getPrototypeOf(t) {
			return Reflect.getPrototypeOf(current(nodeOf(t)));
		},
	};

	const root = makeNode(messages, null);

	// Turn a value into plain data. `memo` keeps one result per node and per walked handler object.
	const realize = (n: Node, memo: Map<object, unknown>): unknown => {
		if (!n.copy) return n.orig;
		const hit = memo.get(n);
		if (hit !== undefined) return hit;
		const out = n.copy;
		memo.set(n, out);
		for (const k of Object.keys(out)) {
			const v = out[k];
			if (n.assigned?.has(k)) {
				out[k] = unwrap(v, memo);
			} else if (isObject(v)) {
				// Untouched slot: an original, which may hold a written child.
				const cn = byOrig.get(v);
				if (cn?.copy) out[k] = realize(cn, memo);
			}
		}
		return out;
	};

	const unwrap = (v: unknown, memo: Map<object, unknown>): unknown => {
		if (!isObject(v)) return v;
		const pn = nodeOfProxy(v);
		if (pn) return realize(pn, memo);
		const on = byOrig.get(v);
		if (on) return realize(on, memo);
		if (!isWrappable(v)) return v;
		const hit = memo.get(v);
		if (hit !== undefined) return hit;
		memo.set(v, v);
		// A new object made by a handler: replace any view values inside it. Originals are never written.
		for (const k of Object.keys(v)) {
			const cur = (v as Obj)[k];
			const next = unwrap(cur, memo);
			if (next !== cur) (v as Obj)[k] = next;
		}
		return v;
	};

	return {
		messages: root.proxy as unknown[],
		materialize(value: unknown): unknown[] {
			const out = unwrap(value, new Map()) as unknown[];
			// Never hand back the caller's own array: the session state must stay a separate object.
			return out === messages ? messages.slice() : out;
		},
	};
};
