// AI Agent step bookkeeping, kept free of the platform SDK so it can be tested.
import { clipStep } from "./shellExecution";

// A task keeps only its latest steps, plus how many it has run in total, so a page
// can ask for just the steps it has not seen yet.
export const AI_TASK_MAX_STEPS = 50;
type StepLog<S> = { steps: S[]; stepCount: number };

export function recordStep<S extends { stdout: string; stderr: string }>(task: StepLog<S>, step: S): S {
  const clipped = clipStep(step);
  task.steps.push(clipped);
  task.steps.splice(0, task.steps.length - AI_TASK_MAX_STEPS);
  task.stepCount += 1;
  return clipped;
}

// The steps after the first `known` ones (as many of them as are still kept).
export function stepsSince<S>(task: StepLog<S>, known: number): S[] {
  return task.steps.slice(Math.max(0, known - (task.stepCount - task.steps.length)));
}
