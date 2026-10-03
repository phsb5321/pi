/**
 * Shared engine shell for the 005 in-process runtime tests.
 * The settle/terminated + echo-attach skeleton is identical across the
 * acceptance and regression harnesses; each caller supplies its own close.
 */
import type { ServiceCall } from "@earendil-works/chord";
import type {
	InProcessSessionAttachment,
	InProcessSessionEngine,
	InProcessSessionIdentity,
} from "../src/index.ts";

export function echoEngineShell(
	identity: InProcessSessionIdentity,
	onClose: () => void,
): InProcessSessionEngine {
	let settle: (error: Error | undefined) => void = () => {};
	const terminated = new Promise<Error | undefined>((resolve) => {
		settle = resolve;
	});
	return {
		identity,
		terminated,
		attach(): InProcessSessionAttachment {
			return {
				async invokeService(call: ServiceCall): Promise<never | undefined> {
					return { echoed: call } as never;
				},
				async release(): Promise<void> {},
			};
		},
		async close(): Promise<void> {
			onClose();
			settle(undefined);
		},
	};
}
