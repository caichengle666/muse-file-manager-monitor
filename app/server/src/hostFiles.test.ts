import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTextFormat, blockedNames, detectTextFormat, hiddenBelowRoot, writeFileDurably, writeMigratedFile } from "./hostFiles";
import { AI_CONTEXT_TEXT_MAX_CHARS, clipMessageText } from "./shellExecution";

const bytes = (text: string) => new TextEncoder().encode(text);
// What the editor does: decode (the default decoder drops a BOM) and hand the text to
// a <textarea>, whose value always uses LF line breaks.
const asEditorText = (raw: Uint8Array) => new TextDecoder("utf-8").decode(raw).replace(/\r\n?/g, "\n");

describe("text format on save", () => {
  test("detects CRLF and BOM", () => {
    expect(detectTextFormat(bytes("\uFEFFa,b\r\nc,d\r\n"))).toEqual({ bom: true, eol: "\r\n" });
  });

  test("plain LF without BOM", () => {
    expect(detectTextFormat(bytes("a\nb\n"))).toEqual({ bom: false, eol: "\n" });
  });

  test("empty file and a file without line breaks", () => {
    expect(detectTextFormat(new Uint8Array())).toEqual({ bom: false, eol: "\n" });
    expect(detectTextFormat(bytes("one line"))).toEqual({ bom: false, eol: "\n" });
  });

  test("mixed line breaks follow the majority", () => {
    expect(detectTextFormat(bytes("a\r\nb\r\nc\n"))).toEqual({ bom: false, eol: "\r\n" });
    expect(detectTextFormat(bytes("a\nb\nc\r\n"))).toEqual({ bom: false, eol: "\n" });
  });

  test("a CRLF file with a BOM survives an edit byte for byte", () => {
    const original = bytes("\uFEFF名称,数量\r\n苹果,1\r\n梨,2\r\n");
    const edited = asEditorText(original).replace("1", "3");
    const saved = bytes(applyTextFormat(edited, detectTextFormat(original)));
    expect(Buffer.from(saved).toString("hex")).toBe(Buffer.from(bytes("\uFEFF名称,数量\r\n苹果,3\r\n梨,2\r\n")).toString("hex"));
  });

  test("an unchanged LF file is written back unchanged", () => {
    const original = bytes("x\ny\n");
    expect(applyTextFormat(asEditorText(original), detectTextFormat(original))).toBe("x\ny\n");
  });

  test("does not double a BOM or a CR", () => {
    expect(applyTextFormat("\uFEFFa\r\nb", { bom: true, eol: "\r\n" })).toBe("\uFEFFa\r\nb");
  });

  test("adds lines typed in the editor with the file's line break", () => {
    expect(applyTextFormat("a\nnew\n", { bom: false, eol: "\r\n" })).toBe("a\r\nnew\r\n");
  });
});

describe("durable writes", () => {
  test("writes, refuses to clobber with wx, and overwrites with w", () => {
    const dir = mkdtempSync(join(tmpdir(), "mfm-durable-"));
    try {
      const file = join(dir, "f.txt");
      writeFileDurably(file, "one");
      expect(readFileSync(file, "utf8")).toBe("one");
      expect(() => writeFileDurably(file, "two", "wx")).toThrow();
      writeFileDurably(file, "2", "w");
      expect(readFileSync(file, "utf8")).toBe("2");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("legacy private data migration", () => {
  test("writes a new file and leaves no temporary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mfm-migrate-"));
    try {
      expect(writeMigratedFile(join(dir, "a.txt"), bytes("hello"))).toBe("written");
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello");
      expect(readdirSync(dir)).toEqual(["a.txt"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("keeps a complete file already there", () => {
    const dir = mkdtempSync(join(tmpdir(), "mfm-migrate-"));
    try {
      writeFileSync(join(dir, "a.txt"), "hello");
      expect(writeMigratedFile(join(dir, "a.txt"), bytes("HELLO"))).toBe("kept");
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("replaces a truncated leftover of an interrupted older run", () => {
    const dir = mkdtempSync(join(tmpdir(), "mfm-migrate-"));
    try {
      writeFileSync(join(dir, "a.bin"), "he");
      expect(writeMigratedFile(join(dir, "a.bin"), bytes("hello"))).toBe("written");
      expect(readFileSync(join(dir, "a.bin"), "utf8")).toBe("hello");
      expect(readdirSync(dir)).toEqual(["a.bin"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("keeps a folder in the way and cleans up after a failed write", () => {
    const dir = mkdtempSync(join(tmpdir(), "mfm-migrate-"));
    try {
      mkdirSync(join(dir, "taken"));
      expect(writeMigratedFile(join(dir, "taken"), bytes("x"))).toBe("kept");
      expect(() => writeMigratedFile(join(dir, "missing", "a.txt"), bytes("x"))).toThrow();
      expect(readdirSync(dir)).toEqual(["taken"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("sensitive-looking legacy names are written like any other", () => {
    const dir = mkdtempSync(join(tmpdir(), "mfm-migrate-"));
    try {
      for (const name of ["session", ".env", "notes.key", "api_token"]) {
        expect(blockedNames.test(name)).toBe(true);
        expect(writeMigratedFile(join(dir, name), bytes(name))).toBe("written");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("symlink targets and the sensitive-name filter", () => {
  const root = "/srv/app/data/private";

  test("a target inside the private root is not hidden by the root's own name", () => {
    expect(hiddenBelowRoot(root, `${root}/photos/cat.png`, blockedNames)).toBe(false);
    expect(hiddenBelowRoot(root, root, blockedNames)).toBe(false);
  });

  test("a sensitive name below the root is still hidden", () => {
    expect(hiddenBelowRoot(root, `${root}/.ssh/config`, blockedNames)).toBe(true);
  });

  test("a target outside the root is checked on its whole path", () => {
    expect(hiddenBelowRoot("/home/u/workspace", "/home/u/.ssh/id_rsa", blockedNames)).toBe(true);
    expect(hiddenBelowRoot("/home/u/workspace", "/srv/app/data/private/a.png", blockedNames)).toBe(true);
    expect(hiddenBelowRoot("/home/u/workspace", "/etc/hosts", blockedNames)).toBe(false);
  });

  test("a sibling with the root as a name prefix counts as outside", () => {
    expect(hiddenBelowRoot("/data/private", "/data/private-old/a.txt", blockedNames)).toBe(false);
    expect(hiddenBelowRoot("/data/x", "/data/x-session/a.txt", blockedNames)).toBe(true);
  });
});

describe("saved chat message length", () => {
  test("short text is untouched", () => {
    expect(clipMessageText("好")).toBe("好");
    const exact = "a".repeat(AI_CONTEXT_TEXT_MAX_CHARS);
    expect(clipMessageText(exact)).toBe(exact);
  });

  test("a long model explanation is clipped to the transcript limit", () => {
    const clipped = clipMessageText("说明".repeat(30_000));
    expect(clipped.length).toBeLessThanOrEqual(AI_CONTEXT_TEXT_MAX_CHARS);
    expect(clipped).toContain("已截断");
  });

  test("never cuts a surrogate pair in half", () => {
    const clipped = clipMessageText("😀".repeat(15_000));
    expect(clipped.length).toBeLessThanOrEqual(AI_CONTEXT_TEXT_MAX_CHARS);
    expect(clipped).not.toContain("\uFFFD");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped)).toBe(false);
  });
});

describe("drizzle migration journal", () => {
  test("timestamps increase with idx, so a timestamp-based migrator applies every migration", () => {
    const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; when: number }> };
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    for (let index = 1; index < entries.length; index += 1) expect(entries[index]!.when).toBeGreaterThan(entries[index - 1]!.when);
  });
});
