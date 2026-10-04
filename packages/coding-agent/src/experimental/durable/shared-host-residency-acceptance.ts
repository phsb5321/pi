/** Pi #9: repeated native residency cycles and restart continuity through
 * actual presentation attach/release and the awaited public park gate.
 * Provider-free controller/view checks; populated tool/history/GC proof is
 * in shared-host-residency-reclaim-regression.ts. No fleet RAM claim.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { InProcessSessionAttachment, RoutedSessionHandle } from "@earendil-works/pi-server";
import { createSharedHostResidency, type ResidencyState, type ResidentRecord } from "./shared-host-residency.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "sdk-residency-cycles-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent-dir");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const ids = ["res-s1", "res-s2", "res-s3"];
const events: Array<{ id: string; state: ResidencyState }> = [];
let checks = 0;
function check(label: string, value: boolean): void {
	assert.equal(value, true, label);
	checks++;
	console.log(`PASS ${label}`);
}
const record = (id: string): ResidentRecord => JSON.parse(readFileSync(join(root, `${id}.resident.json`), "utf8"));
async function openHost() {
	const host = await createSharedHostResidency({
		policy: { maxSessions: ids.length },
		hydrate: { root, onState: (id, state) => events.push({ id, state }) },
	});
	const handles = new Map<string, RoutedSessionHandle>();
	const attachments = new Map<string, InProcessSessionAttachment>();
	for (const id of ids) {
		const handle = await host.runtime.host.openSession({ id }, context);
		handles.set(id, handle);
		attachments.set(id, await handle.attachClient(context));
	}
	return {
		host,
		handles,
		attachments,
		invoke: (id: string, member: string) =>
			attachments.get(id)!.invokeService({ serviceId: "pi.durable", member, args: [] }, async () => {}, context),
	};
}
const baseline = new Map<string, ResidentRecord>();
const first = await openHost();
try {
	for (const id of ids) baseline.set(id, record(id));
	for (let cycle = 1; cycle <= 3; cycle++)
		for (const id of ids) {
			check(
				`cycle ${cycle} refuses park with actual presentation ${id}`,
				(await first.host.parkWhenQuiescent(id)) === "refused-not-quiescent",
			);
			await first.attachments.get(id)!.release(context);
			first.attachments.delete(id);
			check(`cycle ${cycle} awaits quiescent park ${id}`, (await first.host.parkWhenQuiescent(id)) === "parked");
			check(
				`cycle ${cycle} drops native residency ${id}`,
				events.some((event) => event.id === id && event.state.released === cycle && !event.state.openedRetained),
			);
			first.attachments.set(id, await first.handles.get(id)!.attachClient(context));
			await first.invoke(id, "view");
			await first.invoke(id, "abort");
			check(
				`cycle ${cycle} resumes identical native binding ${id}`,
				JSON.stringify(record(id)) === JSON.stringify(baseline.get(id)),
			);
			check(
				`cycle ${cycle} awaits native reopen ${id}`,
				events.some((event) => event.id === id && event.state.resumed === cycle && event.state.openedRetained),
			);
		}
} finally {
	await first.host.close();
}
const second = await openHost();
try {
	for (const id of ids) {
		check(`restart preserves native binding ${id}`, JSON.stringify(record(id)) === JSON.stringify(baseline.get(id)));
		const extra = await second.handles.get(id)!.attachClient(context);
		check(
			`two presentations registered ${id}`,
			second.host.core.state(second.host.runtime.control).presentations.get(id) === 2,
		);
		await extra.release(context);
		check(
			`one presentation remains ${id}`,
			second.host.core.state(second.host.runtime.control).presentations.get(id) === 1,
		);
		await second.attachments.get(id)!.release(context);
		check(`zero presentations permits awaited park ${id}`, (await second.host.parkWhenQuiescent(id)) === "parked");
	}
	check("unknown session refuses park", (await second.host.parkWhenQuiescent("missing")) === "unknown-session");
} finally {
	await second.host.close();
}
console.log(`RESIDENCY CYCLES: ${checks} PASS; RAM/live UNPROVEN`);
