export interface TrialGrade {
	outcomePass: boolean;
	reasons: string[];
}

export function gradeTrial(trial: unknown, manifest?: unknown): TrialGrade;
