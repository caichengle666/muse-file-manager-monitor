// File helpers for privileged.ts, kept free of the platform SDK so they can be tested.
import { closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

// Whether the bytes are entirely valid UTF-8. Only such a file may be edited:
// saving decoded text back would replace every invalid byte with U+FFFD.
export function isUtf8Text(bytes: Uint8Array): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
}

// Length of `bytes` without a multi-byte UTF-8 character cut off at its end, so a
// page of text never ends (or the next one starts) in the middle of a character.
export function utf8SafeLength(bytes: Uint8Array): number {
  const length = bytes.byteLength;
  for (let back = 1; back <= Math.min(3, length); back += 1) {
    const byte = bytes[length - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue;
    const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return size > back ? length - back : length;
  }
  return length;
}

// Existence of the path itself; a symlink, even a broken one, exists.
export function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

const collator = new Intl.Collator("zh-CN", { numeric: true });
// Folders first (rank 0), then files (1), then the rest, by name. Sorting happens
// before the cut so a large directory never hides its folders past the limit.
export function selectListing<T extends { name: string; rank: number }>(items: T[], limit: number): T[] {
  return [...items].sort((a, b) => a.rank - b.rank || collator.compare(a.name, b.name)).slice(0, limit);
}

// Names hidden unless "show sensitive" is on. A display filter, not access control.
export const blockedNames = /^(\.env(?:\..*)?|credentials?(?:\..*)?|.*(?:secret|password|token|private|cookie|session|wallet|\.pem|\.key)$|id_rsa.*|\.ssh|\.aws|\.gnupg|\.netrc)$/i;

// Whether a resolved path (a symlink target) is hidden by the sensitive-name filter.
// Only the part below the selected root is checked, as when resolving a requested
// path, so links inside the private root (itself named "private") still resolve.
export function hiddenBelowRoot(root: string, absolute: string, blocked: RegExp): boolean {
  const relation = relative(root, absolute);
  const insideRoot = relation !== ".." && !relation.startsWith(`..${sep}`);
  return (insideRoot ? relation : absolute).split("/").filter(Boolean).some((part) => blocked.test(part));
}

// How an existing text file is laid out on disk. The editor shows the text without
// a BOM and a <textarea> always hands back LF line breaks, so a save restores both;
// otherwise changing one character would rewrite every line of a CRLF file and drop
// the BOM a CSV needs to open as UTF-8 in Excel.
export type TextFormat = { bom: boolean; eol: "\n" | "\r\n" };

export function detectTextFormat(bytes: Uint8Array): TextFormat {
  const bom = bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    if (index > 0 && bytes[index - 1] === 0x0d) crlf += 1; else lf += 1;
  }
  return { bom, eol: crlf > lf ? "\r\n" : "\n" };
}

export function applyTextFormat(content: string, format: TextFormat): string {
  let text = format.eol === "\r\n" ? content.replace(/\r?\n/g, "\r\n") : content;
  if (format.bom && !text.startsWith("\uFEFF")) text = `\uFEFF${text}`;
  return text;
}

// Write and fsync, so a rename that follows never exposes an empty file after a crash.
export function writeFileDurably(path: string, data: string | Uint8Array, flag: "wx" | "w" = "wx"): void {
  const fd = openSync(path, flag);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Persist a rename in its directory. Best effort: some filesystems refuse fsync on a directory.
export function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* not supported here */ }
}

// One legacy private-workspace file. It lands under a temporary name and is renamed
// into place, so an interrupted run never leaves a half-written file behind under
// the real name. A file already there at least as large as the data is kept (an
// earlier run, or the user, wrote it); a smaller one is the truncated leftover of an
// older version that wrote in place, and is replaced.
export function writeMigratedFile(target: string, bytes: Uint8Array): "written" | "kept" {
  try {
    const existing = lstatSync(target);
    if (!existing.isFile() || existing.size >= bytes.byteLength) return "kept";
  } catch { /* not there yet */ }
  const directory = dirname(target);
  const temporary = join(directory, `.muse-migrate-${crypto.randomUUID()}.tmp`);
  try {
    writeFileDurably(temporary, bytes, "wx");
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* never created */ }
    throw error;
  }
  fsyncDirectory(directory);
  return "written";
}
