import { describe, expect, it } from "vitest";
import { type HerdrPaneQuery, seedTerminalFocusFromHerdr } from "../src/utils/herdr-focus.ts";

function target(interval: number) {
	const seeded: boolean[] = [];
	return {
		seeded,
		getUnfocusedRenderInterval: () => interval,
		seedTerminalFocus: (focused: boolean) => seeded.push(focused),
	};
}

const reply =
	(stdout: string, error: Error | null = null): HerdrPaneQuery =>
	(_file, _args, _options, callback) =>
		callback(error, stdout);

describe("seedTerminalFocusFromHerdr", () => {
	it("marks an unfocused Herdr pane unfocused", () => {
		const t = target(150);
		const calls: string[][] = [];
		const query: HerdrPaneQuery = (file, args, options, callback) => {
			calls.push([file, ...args]);
			reply(JSON.stringify({ result: { pane: { focused: false } } }))(file, args, options, callback);
		};
		seedTerminalFocusFromHerdr(t, { HERDR_PANE_ID: "w3:p1", HERDR_BIN_PATH: "/bin/herdr" }, query);
		expect(calls).toEqual([["/bin/herdr", "pane", "get", "w3:p1"]]);
		expect(t.seeded).toEqual([false]);
	});

	it("leaves a focused pane alone", () => {
		const t = target(150);
		seedTerminalFocusFromHerdr(
			t,
			{ HERDR_PANE_ID: "w3:p1" },
			reply(JSON.stringify({ result: { pane: { focused: true } } })),
		);
		expect(t.seeded).toEqual([]);
	});

	it("does nothing outside Herdr or when the interval is off", () => {
		const never: HerdrPaneQuery = () => {
			throw new Error("must not query herdr");
		};
		seedTerminalFocusFromHerdr(target(150), {}, never);
		seedTerminalFocusFromHerdr(target(0), { HERDR_PANE_ID: "w3:p1" }, never);
	});

	it("ignores errors and unparseable output", () => {
		const t = target(150);
		seedTerminalFocusFromHerdr(t, { HERDR_PANE_ID: "p" }, reply("", new Error("no socket")));
		seedTerminalFocusFromHerdr(t, { HERDR_PANE_ID: "p" }, reply("not json"));
		expect(t.seeded).toEqual([]);
	});
});
