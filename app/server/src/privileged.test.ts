import { describe, expect, test } from "bun:test";
import { selectShellExecutionMode } from "./shellExecution";

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
