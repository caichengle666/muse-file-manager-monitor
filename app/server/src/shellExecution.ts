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
