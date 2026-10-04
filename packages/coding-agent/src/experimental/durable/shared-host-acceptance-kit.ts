/**
 * shared-host-acceptance-kit — the tiny shared harness for the executable
 * acceptances/canaries in this directory: fail-fast checks + session
 * open/attach/invoke wiring over the seam (one copy).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SessionMetadata } from "@earendil-works/pi-server";

export type Invoke = (id: string, member: string, args?: unknown[]) => Promise<unknown>;

export interface OpenableHost {
	host: {
		openSession(
			metadata: SessionMetadata,
			context: unknown,
		): Promise<{
			attachClient: (
				context: unknown,
			) => Promise<{ invokeService: (call: unknown, publish: unknown, ctx: unknown) => Promise<unknown> }>;
		}>;
	};
}

export function makeChecks(): { check: (label: string, condition: boolean) => void; failures: number } {
	const state = { failures: 0 };
	return {
		check(label: string, condition: boolean): void {
			if (condition) {
				console.log(`PASS ${label}`);
				return;
			}
			state.failures += 1;
			console.error(`FAIL ${label}`);
		},
		get failures(): number {
			return state.failures;
		},
	} as { check: (label: string, condition: boolean) => void; failures: number };
}

export async function openAttachedSessions(host: OpenableHost, ids: readonly string[]): Promise<Invoke> {
	const attachments = new Map<
		string,
		{ invokeService: (call: unknown, publish: unknown, ctx: unknown) => Promise<unknown> }
	>();
	for (const id of ids) {
		const handle = await host.host.openSession({ id }, BACKGROUND_CONTEXT);
		attachments.set(id, await handle.attachClient(BACKGROUND_CONTEXT));
	}
	return (id, member, args = []) =>
		attachments.get(id)!.invokeService({ member, args }, async () => undefined, BACKGROUND_CONTEXT);
}
