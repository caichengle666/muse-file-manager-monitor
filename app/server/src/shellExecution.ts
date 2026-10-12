export type ShellExecutionMode = "direct" | "sudo" | "shell";

// Below the 30 s privileged-contract timeout so a slow command still returns its
// result instead of failing the whole platform call.
export const SHELL_TIMEOUT_MS = 25_000;

// A root-requested command must still run when the worker is already root, so the
// sudo branch and the plain-shell branch have to stay mutually exclusive.
export function selectShellExecutionMode(runAsRoot: boolean, uid: number | undefined): ShellExecutionMode {
  if (!runAsRoot) return "shell";
  return uid !== undefined && uid !== 0 ? "sudo" : "direct";
}

// Under sudo the root process group cannot be signalled by the worker, so GNU
// `timeout` (which kills its whole process group) enforces the limit as root.
export function shellSpawnArgs(mode: ShellExecutionMode, script: string): [string, string[]] {
  if (mode === "sudo") return ["sudo", ["-n", "timeout", "-s", "KILL", String(SHELL_TIMEOUT_MS / 1000), "/bin/bash", "-c", script]];
  return ["/bin/bash", ["-c", script]];
}

// One command, wherever it comes from (the terminal, the AI Agent). The privileged
// contract enforces it; the agent asks the model to split anything longer.
export const SHELL_COMMAND_MAX_CHARS = 4000;
export const SHELL_OUTPUT_MAX_CHARS = 1_000_000;

// Collects one output stream. Decoding is streamed, so a multi-byte character split
// across chunks stays intact. Past `limit` the text is dropped, but the last
// `tailSize` characters of the whole stream are always kept, so a marker printed
// last (the cwd trap) survives huge output.
export function createOutputCollector(limit = SHELL_OUTPUT_MAX_CHARS, tailSize = 8192) {
  const decoder = new TextDecoder("utf-8");
  let head = "";
  let tail = "";
  let truncated = false;
  const add = (text: string) => {
    if (!text) return;
    tail = (tail + text).slice(-tailSize);
    if (truncated) return;
    if (head.length + text.length <= limit) { head += text; return; }
    let room = limit - head.length;
    // Never cut a surrogate pair in half.
    const code = text.charCodeAt(room - 1);
    if (room > 0 && code >= 0xd800 && code <= 0xdbff) room -= 1;
    head += text.slice(0, room);
    truncated = true;
  };
  return {
    push(chunk: Uint8Array) { add(decoder.decode(chunk, { stream: true })); },
    finish(): { text: string; tail: string; truncated: boolean } { add(decoder.decode()); return { text: head, tail, truncated }; },
  };
}

// Agent step output kept in task state, replies and the saved transcript; the model
// sees the same amount.
export const AI_STEP_OUTPUT_MAX_CHARS = 12_000;
const CLIPPED = "\n…（输出过长，已截断）";
function clipOutput(text: string): string {
  return text.length <= AI_STEP_OUTPUT_MAX_CHARS ? text : text.slice(0, AI_STEP_OUTPUT_MAX_CHARS - CLIPPED.length) + CLIPPED;
}
export function clipStep<T extends { stdout: string; stderr: string }>(step: T): T {
  return step.stdout.length <= AI_STEP_OUTPUT_MAX_CHARS && step.stderr.length <= AI_STEP_OUTPUT_MAX_CHARS ? step : { ...step, stdout: clipOutput(step.stdout), stderr: clipOutput(step.stderr) };
}
