import { ModelsError } from "@earendil-works/pi-ai";

/** What a seat is authorized to invoke. Issued by the coordinator, never inferred from labels. */
export interface InvocationAdmission {
	seatId: string;
	sessionId: string;
	provider: string;
	modelId: string;
	api: string;
	/** Effective endpoint the admission was issued for. Undefined means "provider default". */
	baseUrl?: string;
	attemptId: string;
	revision: number;
	/** Epoch milliseconds. */
	expiresAt: number;
}

/** The final, resolved request as it is about to reach a provider. */
export interface InvocationRequest {
	provider: string;
	modelId: string;
	api: string;
	baseUrl?: string;
}

/** "pre" runs before credential resolution; "final" runs after it, immediately before invocation. */
export type InvocationPhase = "pre" | "final";

export type InvocationGuard = (request: InvocationRequest, phase: InvocationPhase) => void | Promise<void>;

export type InvocationRefusalCode =
	| "wrong-model"
	| "session-drift"
	| "missing-admission"
	| "provider-mismatch"
	| "uncertain-effect";

export class InvocationRefusal extends ModelsError {
	readonly refusal: InvocationRefusalCode;

	constructor(code: InvocationRefusalCode, message: string) {
		super("auth", `Model fence refused (${code}): ${message}`);
		this.refusal = code;
	}
}

export interface InvocationFenceOptions {
	/** Current admission, or undefined when absent, revoked or unverifiable. */
	admission: () => InvocationAdmission | undefined;
	/** Identity of the live session branch. */
	sessionId: () => string;
	now?: () => number;
}

/**
 * Fail-closed guard. Any mismatch, missing value or thrown error refuses. A passed "final" check
 * marks the attempt as started; a second invocation of the same attempt is refused because the
 * first may have reached the transport without a verified outcome.
 */
export function createInvocationFence(options: InvocationFenceOptions): InvocationGuard {
	const started = new Set<string>();
	const now = options.now ?? Date.now;
	return (request, phase) => {
		let admission: InvocationAdmission | undefined;
		let sessionId: string;
		try {
			admission = options.admission();
			sessionId = options.sessionId();
		} catch (error) {
			throw new InvocationRefusal("missing-admission", error instanceof Error ? error.message : String(error));
		}
		if (!admission || !(admission.expiresAt > now())) {
			throw new InvocationRefusal("missing-admission", "no current admission");
		}
		if (admission.sessionId !== sessionId) {
			throw new InvocationRefusal("session-drift", `admission for ${admission.sessionId}, session is ${sessionId}`);
		}
		if (admission.modelId !== request.modelId) {
			throw new InvocationRefusal("wrong-model", `admitted ${admission.modelId}, requested ${request.modelId}`);
		}
		if (
			admission.provider !== request.provider ||
			admission.api !== request.api ||
			(phase === "final" && admission.baseUrl !== request.baseUrl)
		) {
			throw new InvocationRefusal(
				"provider-mismatch",
				`admitted ${admission.provider}/${admission.api}, resolved ${request.provider}/${request.api}`,
			);
		}
		if (phase === "final") {
			if (started.has(admission.attemptId)) {
				throw new InvocationRefusal("uncertain-effect", `attempt ${admission.attemptId} already started`);
			}
			started.add(admission.attemptId);
		}
	};
}
