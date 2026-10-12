import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUtf8Text, pathExists, selectListing, utf8SafeLength } from "./hostFiles";
import { AI_STEP_OUTPUT_MAX_CHARS, SHELL_TIMEOUT_MS, clipStep, createOutputCollector, selectShellExecutionMode, shellSpawnArgs } from "./shellExecution";

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

describe("shell output collection", () => {
  test("keeps a multi-byte character that is split across chunks", () => {
    const bytes = new TextEncoder().encode("中".repeat(1000));
    const collector = createOutputCollector();
    for (let index = 0; index < bytes.length; index += 7) collector.push(bytes.subarray(index, index + 7));
    expect(collector.finish()).toEqual({ text: "中".repeat(1000), tail: "中".repeat(1000), truncated: false });
  });

  test("caps the text exactly and keeps the end of the stream for the cwd marker", () => {
    const collector = createOutputCollector(1000, 64);
    collector.push(new TextEncoder().encode("a".repeat(5000)));
    collector.push(new TextEncoder().encode("\n__MUSE_CWD_x__/usr\n"));
    const result = collector.finish();
    expect(result.text).toBe("a".repeat(1000));
    expect(result.truncated).toBe(true);
    expect(result.tail.endsWith("\n__MUSE_CWD_x__/usr\n")).toBe(true);
  });

  test("never cuts a surrogate pair at the cap", () => {
    const collector = createOutputCollector(3);
    collector.push(new TextEncoder().encode("ab😀c"));
    expect(collector.finish().text).toBe("ab");
  });
});

describe("agent step output", () => {
  test("clips stdout and stderr to the shared cap", () => {
    const step = clipStep({ command: "cat big", stdout: "x".repeat(50_000), stderr: "short", cwd: "/", exitCode: 0, requiresConfirmation: false });
    expect(step.stdout.length).toBeLessThanOrEqual(AI_STEP_OUTPUT_MAX_CHARS);
    expect(step.stdout).toContain("已截断");
    expect(step.stderr).toBe("short");
  });

  test("returns a small step unchanged", () => {
    const step = { command: "ls", stdout: "a", stderr: "", cwd: "/", exitCode: 0, requiresConfirmation: false };
    expect(clipStep(step)).toBe(step);
  });
});

describe("host file helpers", () => {
  test("only whole-file UTF-8 counts as editable text", () => {
    expect(isUtf8Text(new TextEncoder().encode("你好\n"))).toBe(true);
    // "你好" in GBK: a .txt file like this must not be saved back as text.
    expect(isUtf8Text(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0x0a]))).toBe(false);
  });

  test("text pages end on a UTF-8 character boundary", () => {
    const bytes = new TextEncoder().encode("ab中");
    expect(utf8SafeLength(bytes)).toBe(5);
    expect(utf8SafeLength(bytes.subarray(0, 4))).toBe(2);
    expect(utf8SafeLength(bytes.subarray(0, 3))).toBe(2);
    expect(utf8SafeLength(new TextEncoder().encode("😀").subarray(0, 3))).toBe(0);
    expect(utf8SafeLength(new Uint8Array([0x80, 0x80, 0x80, 0x80]))).toBe(4);
  });

  test("a symlink exists even when its target does not", () => {
    const directory = mkdtempSync(join(tmpdir(), "mfmm-"));
    try {
      symlinkSync(join(directory, "missing"), join(directory, "broken"));
      writeFileSync(join(directory, "file"), "x");
      expect(pathExists(join(directory, "broken"))).toBe(true);
      expect(pathExists(join(directory, "file"))).toBe(true);
      expect(pathExists(join(directory, "nothing"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("removing a symlink to a folder leaves the target intact", () => {
    const directory = mkdtempSync(join(tmpdir(), "mfmm-"));
    try {
      const target = join(directory, "target");
      writeFileSync(join(directory, "keep"), "x");
      symlinkSync(directory, target);
      rmSync(target, { recursive: true, force: false });
      expect(pathExists(target)).toBe(false);
      expect(pathExists(join(directory, "keep"))).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("sorts folders first before cutting a large listing", () => {
    const items = [...Array.from({ length: 600 }, (_, index) => ({ name: `file${index}`, rank: 1 })), { name: "z-folder", rank: 0 }, { name: "a-folder", rank: 0 }];
    const listed = selectListing(items, 500);
    expect(listed).toHaveLength(500);
    expect(listed.slice(0, 2).map((item) => item.name)).toEqual(["a-folder", "z-folder"]);
    expect(listed[2]?.name).toBe("file0");
    expect(listed[3]?.name).toBe("file1");
    expect(listed[11]?.name).toBe("file9");
    expect(listed[12]?.name).toBe("file10");
  });
});
