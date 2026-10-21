import assert from "node:assert/strict";
import { choose } from "./dist/covered.js";
assert.equal(choose(1), "positive");
