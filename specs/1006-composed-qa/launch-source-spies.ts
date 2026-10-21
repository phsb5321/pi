// Dependency spies for the narrow actual-main source check. No host, socket,
// real terminal, provider, compiler or production session is constructed.
export const trace = {
	hosts: [] as { socket: string; sessions: string[]; closed: boolean }[],
	processTerminals: 0,
	uiStarts: 0,
	uiStops: 0,
	keybindingSets: 0,
};

export async function createSharedDurableUnixHost(options: { socket: string; sessions: string[] }) {
	const host = { socket: options.socket, sessions: [...options.sessions], closed: false };
	trace.hosts.push(host);
	return { async close() { host.closed = true; } };
}

export class ProcessTerminal {
	constructor() { trace.processTerminals++; }
}

interface SpyComponent { finish: () => void }
export class TuiMainScreen {
	private components: SpyComponent[] = [];
	constructor(_terminal: ProcessTerminal) {}
	addChild(component: SpyComponent) { this.components.push(component); }
	setFocus(_component: SpyComponent) {}
	requestRender() {}
	start() {
		trace.uiStarts++;
		queueMicrotask(() => { for (const component of this.components) component.finish(); });
	}
	stop() { trace.uiStops++; }
}

export class KeybindingsManager {
	static create() { return new KeybindingsManager(); }
}
export function setKeybindings(_keybindings: KeybindingsManager) { trace.keybindingSets++; }
export function createThinPresentation(options: { onExit?: () => void }) {
	return { component: { finish: () => options.onExit?.() }, async exit() {}, dispose() {} };
}

// These are imported by the frozen source but never used by its main path in
// this check. Any attempted real attachment fails rather than being simulated.
export const Client = { async connect() { throw new Error("SOURCE_CHECK: real client forbidden"); } };
export function attachSession() { throw new Error("SOURCE_CHECK: real attachment forbidden"); }
export function createThinClient() { throw new Error("SOURCE_CHECK: real thin client forbidden"); }
export function createUnixTransportFactory() { throw new Error("SOURCE_CHECK: real Unix transport forbidden"); }
export function openThinDurablePresentation() { throw new Error("SOURCE_CHECK: real presentation binding forbidden"); }
