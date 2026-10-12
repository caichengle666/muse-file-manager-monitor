import { describe, expect, test } from "bun:test";
import { AI_TASK_MAX_STEPS, recordStep, stepsSince } from "./aiTask";
import { AI_STEP_OUTPUT_MAX_CHARS } from "./shellExecution";

const step = (command: string, stdout = "") => ({ command, stdout, stderr: "", cwd: "/", exitCode: 0, requiresConfirmation: false });

describe("AI task steps", () => {
  test("returns only the steps the page has not seen", () => {
    const task = { steps: [] as Array<ReturnType<typeof step>>, stepCount: 0 };
    recordStep(task, step("a"));
    recordStep(task, step("b"));
    recordStep(task, step("c"));
    expect(stepsSince(task, 0).map((item) => item.command)).toEqual(["a", "b", "c"]);
    expect(stepsSince(task, 2).map((item) => item.command)).toEqual(["c"]);
    expect(stepsSince(task, 3)).toEqual([]);
  });

  test("keeps the latest steps and the running total", () => {
    const task = { steps: [] as Array<ReturnType<typeof step>>, stepCount: 0 };
    for (let index = 0; index < AI_TASK_MAX_STEPS + 10; index += 1) recordStep(task, step(String(index)));
    expect(task.steps).toHaveLength(AI_TASK_MAX_STEPS);
    expect(task.stepCount).toBe(AI_TASK_MAX_STEPS + 10);
    expect(stepsSince(task, AI_TASK_MAX_STEPS + 8).map((item) => item.command)).toEqual([String(AI_TASK_MAX_STEPS + 8), String(AI_TASK_MAX_STEPS + 9)]);
    // A page far behind gets every step still kept.
    expect(stepsSince(task, 0)).toHaveLength(AI_TASK_MAX_STEPS);
  });

  test("stores step output clipped", () => {
    const task = { steps: [] as Array<ReturnType<typeof step>>, stepCount: 0 };
    const stored = recordStep(task, step("cat log", "x".repeat(2_000_000)));
    expect(stored.stdout.length).toBeLessThanOrEqual(AI_STEP_OUTPUT_MAX_CHARS);
    expect(task.steps[0]).toBe(stored);
  });
});
