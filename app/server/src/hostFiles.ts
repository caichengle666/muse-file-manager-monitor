// File helpers for privileged.ts, kept free of the platform SDK so they can be tested.
import { lstatSync } from "node:fs";

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
