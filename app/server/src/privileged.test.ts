import { describe, expect, test } from "bun:test";
import { SHELL_TIMEOUT_MS, selectShellExecutionMode, shellSpawnArgs } from "./shellExecution";

describe("shell execution mode", () => {
  test("runs as root directly when the worker is already root", () => {
    expect(selectShellExecutionMode(true, 0)).toBe("direct");
  });

  test("escalates with sudo only when the worker is not root", () => {
    expect(selectShellExecutionMode(true, 1000)).toBe("sudo");
  });

  test("falls back to the direct path when uid is unavailable", () => {
    expect(selectShellExecutionMode(true, undefined)).toBe("direct");
  });

  test("keeps non-root requests on the plain shell path", () => {
    expect(selectShellExecutionMode(false, 0)).toBe("shell");
    expect(selectShellExecutionMode(false, 1000)).toBe("shell");
  });
});

describe("shell spawn arguments", () => {
  test("keeps the shell timeout below the 30 s privileged contract", () => {
    expect(SHELL_TIMEOUT_MS).toBeLessThan(30_000);
  });

  test("enforces the timeout as root under sudo", () => {
    expect(shellSpawnArgs("sudo", "ls")).toEqual(["sudo", ["-n", "timeout", "-s", "KILL", String(SHELL_TIMEOUT_MS / 1000), "/bin/bash", "-c", "ls"]]);
  });

  test("runs bash directly otherwise", () => {
    expect(shellSpawnArgs("direct", "ls")).toEqual(["/bin/bash", ["-c", "ls"]]);
    expect(shellSpawnArgs("shell", "ls")).toEqual(["/bin/bash", ["-c", "ls"]]);
  });
});
