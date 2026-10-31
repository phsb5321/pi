export interface TrialRecordGrade {
	outcomePass: boolean;
	reasons: string[];
	complete: boolean;
}

export function evaluateRangeCandidate(
	src: unknown,
	inputs: unknown[],
): { reason?: string; results?: { ok: boolean; value?: unknown; error?: string }[] };
export function gradeRangeCandidate(src: unknown, cases: unknown[]): string[];
export function reconcileDispatches(record: unknown): string[];
export function gradeTrialRecord(
	record: unknown,
	gradeTrial: (trial: unknown, manifest?: unknown) => { outcomePass: boolean; reasons: string[] },
	manifest?: unknown,
): TrialRecordGrade;
