import type { GoalAdapters } from "./bounded-goal.ts";

export const buildContextPacket: GoalAdapters["buildContextPacket"];
export const summarizeUsage: GoalAdapters["summarizeUsage"];
export const chooseWorkerAction: GoalAdapters["chooseWorkerAction"];
export const evaluateAttempt: GoalAdapters["evaluateAttempt"];
