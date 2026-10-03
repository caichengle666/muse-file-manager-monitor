export type ShellExecutionMode = "direct" | "sudo" | "shell";

// A root-requested command must still run when the worker is already root, so the
// sudo branch and the plain-shell branch have to stay mutually exclusive.
export function selectShellExecutionMode(runAsRoot: boolean, uid: number | undefined): ShellExecutionMode {
  if (!runAsRoot) return "shell";
  return uid !== undefined && uid !== 0 ? "sudo" : "direct";
}
