// Visible check given to the worker. The grader uses its own held-out cases.
import assert from "node:assert/strict";
import { sumRange } from "./range.mjs";
assert.equal(sumRange(1, 3), 6);
console.log("visible-check: ok");
