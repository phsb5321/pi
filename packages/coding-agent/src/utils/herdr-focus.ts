import { execFile } from "node:child_process";

export interface HerdrFocusTarget {
	getUnfocusedRenderInterval(): number;
	seedTerminalFocus(focused: boolean): void;
}

export type HerdrPaneQuery = (
	file: string,
	args: string[],
	options: { timeout: number; env: NodeJS.ProcessEnv },
	callback: (error: Error | null, stdout: string) => void,
) => void;

/**
 * A terminal reports focus only when it changes, so a pane that starts unfocused would never learn it.
 * Inside a Herdr pane, ask Herdr once whether this pane is focused. Only runs while an unfocused render
 * interval is configured; any failure leaves the pane treated as focused.
 */
export function seedTerminalFocusFromHerdr(
	target: HerdrFocusTarget,
	env: NodeJS.ProcessEnv = process.env,
	query: HerdrPaneQuery = execFile,
): void {
	const pane = env.HERDR_PANE_ID;
	if (!pane || target.getUnfocusedRenderInterval() <= 0) return;
	query(env.HERDR_BIN_PATH || "herdr", ["pane", "get", pane], { timeout: 2000, env }, (error, stdout) => {
		if (error) return;
		let focused: unknown;
		try {
			focused = JSON.parse(stdout)?.result?.pane?.focused;
		} catch {
			return;
		}
		if (focused === false) target.seedTerminalFocus(false);
	});
}
