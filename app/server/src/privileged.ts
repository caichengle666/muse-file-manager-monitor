import {
accessSync,
closeSync,
constants,
existsSync,
lstatSync,
mkdirSync,
openSync,
readFileSync,
readdirSync,
readSync,
realpathSync,
renameSync,
rmSync,
statfsSync,
statSync,
unlinkSync,
writeFileSync,
} from "node:fs";
import { exec, execFile } from "node:child_process";
import { cpus, homedir, hostname, loadavg, platform, release, uptime, userInfo } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { definePrivilegedContracts, definePrivilegedHandlers, z } from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  listHostDirectory: {
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), showSensitive: z.boolean().default(false) }),
    response: z.object({
      ok: z.boolean(), message: z.string(), root: z.enum(["system", "workspace", "build", "private"]), path: z.string(), absolutePath: z.string(), locationLabel: z.string(),
      entries: z.array(z.object({ name: z.string(), path: z.string(), kind: z.enum(["folder", "file", "link"]), targetKind: z.enum(["folder", "file", "other", "broken"]).nullable(), size: z.number(), modifiedAt: z.string(), writable: z.boolean(), removable: z.boolean() })), breadcrumbs: z.array(z.object({ name: z.string(), path: z.string() })),
      truncated: z.boolean(), writable: z.boolean(), userIdentity: z.string(),
    }),
    timeoutMs: 5000,
  },
  listHostImages: {
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), showSensitive: z.boolean().default(false) }),
    response: z.object({
      ok: z.boolean(), message: z.string(),
      entries: z.array(z.object({ name: z.string(), path: z.string(), kind: z.enum(["folder", "file", "link"]), targetKind: z.enum(["folder", "file", "other", "broken"]).nullable(), size: z.number(), modifiedAt: z.string(), writable: z.boolean(), removable: z.boolean() })),
    }),
    timeoutMs: 10000,
  },
  readHostFileChunk: {
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), offset: z.number().int().min(0), limit: z.number().int().min(1024).max(524288), showSensitive: z.boolean().default(false) }),
    response: z.object({
      ok: z.boolean(), message: z.string(), name: z.string().nullable(), mode: z.enum(["text", "hex"]).nullable(),
      content: z.string().nullable(), offset: z.number().int(), nextOffset: z.number().int(), totalSize: z.number().int(),
      eof: z.boolean(), editable: z.boolean(), writable: z.boolean(),
    }),
    timeoutMs: 5000,
  },
  readHostDownloadChunk: {
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), offset: z.number().int().min(0), limit: z.number().int().min(1024).max(524288), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), name: z.string().nullable(), dataBase64: z.string().nullable(), nextOffset: z.number().int(), totalSize: z.number().int(), eof: z.boolean() }),
    timeoutMs: 5000,
  },
  getHostImagePreview: {
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), name: z.string().nullable(), mimeType: z.string().nullable(), dataBase64: z.string().nullable(), size: z.number().int(), tooLarge: z.boolean() }),
    timeoutMs: 10000,
  },
  writeHostTextFile: {
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), content: z.string().max(8_000_000), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    timeoutMs: 5000,
  },
  createHostFile: {
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), directory: z.string().max(2000), name: z.string().max(255), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), path: z.string().nullable() }),
    timeoutMs: 5000,
  },
  createHostDirectory: {
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), directory: z.string().max(2000), name: z.string().max(255), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), path: z.string().nullable() }),
    timeoutMs: 5000,
  },
  deleteHostEntry: {
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    timeoutMs: 5000,
  },
  moveHostEntry: {
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), targetDirectory: z.string().max(2000), newName: z.string().max(255), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), path: z.string().nullable() }),
    timeoutMs: 5000,
  },
  uploadHostFile: {
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), directory: z.string().max(2000), name: z.string().max(255), dataBase64: z.string().max(16_000_000), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), path: z.string().nullable() }),
    timeoutMs: 5000,
  },
  materializePrivateWorkspace: {
    request: z.object({ entries: z.array(z.object({ path: z.string().max(2000), kind: z.enum(["folder", "file"]), dataBase64: z.string().max(8_000_000).nullable() })).max(1000) }),
    response: z.object({ ok: z.boolean(), message: z.string(), migrated: z.boolean(), path: z.string() }),
    timeoutMs: 15000,
  },
  executeShell: {
    request: z.object({ command: z.string().min(1).max(4000), root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000) }),
    response: z.object({ ok: z.boolean(), stdout: z.string(), stderr: z.string(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), cwd: z.string(), durationMs: z.number().int() }),
    timeoutMs: 30000,
  },
  readSystemSnapshot: {
    request: z.object({}),
    response: z.object({
      sampledAt: z.string(), platform: z.string(), hostname: z.string(), kernelVersion: z.string(), uptimeSec: z.number(), serviceUptimeSec: z.number(), bootedAt: z.string(), serviceStartedAt: z.string(), cpuPercent: z.number(), cpuCores: z.array(z.object({ name: z.string(), percent: z.number() })), loadAverage: z.array(z.number()).length(3),
      memory: z.object({ total: z.number(), used: z.number(), cached: z.number(), buffers: z.number(), available: z.number(), percent: z.number() }),
      mounts: z.array(z.object({ path: z.string(), total: z.number(), used: z.number(), available: z.number(), percent: z.number() })),
      disks: z.array(z.object({ name: z.string(), readPerSec: z.number(), writePerSec: z.number() })),
      network: z.object({ rxPerSec: z.number(), txPerSec: z.number(), interfaces: z.array(z.object({ name: z.string(), rxPerSec: z.number(), txPerSec: z.number() })) }), processCount: z.number().int(),
      processesByCpu: z.array(z.object({ pid: z.number().int(), name: z.string(), cpuPercent: z.number(), memoryBytes: z.number(), status: z.string() })),
      processesByMemory: z.array(z.object({ pid: z.number().int(), name: z.string(), cpuPercent: z.number(), memoryBytes: z.number(), status: z.string() })),
    }),
    timeoutMs: 5000,
  },
  scanHomeDirectories: {
    request: z.object({ offset: z.number().int().min(0) }),
    response: z.object({ ok: z.boolean(), message: z.string(), item: z.object({ name: z.string(), path: z.string(), size: z.number(), timedOut: z.boolean() }).nullable(), nextOffset: z.number().int(), total: z.number().int(), done: z.boolean() }),
    timeoutMs: 5000,
  },
});

type HostRoot = "system" | "workspace" | "build" | "private";
type CpuTickSample = { total: number; idle: number };
type CpuSample = { total: CpuTickSample; cores: Map<string, CpuTickSample> };
type NetworkCounter = { rx: number; tx: number };
type DiskCounter = { readBytes: number; writeBytes: number };
type ProcSample = { pid: number; name: string; ticks: number; rss: number; status: string };
type RateSample = { atMs: number; cpu: CpuSample; network: Map<string, NetworkCounter>; disks: Map<string, DiskCounter>; processes: Map<number, ProcSample> };

let cachedBootedAtMs: number | null = null;

function systemBootedAtMs(nowMs: number, uptimeSec: number): number {
  if (cachedBootedAtMs !== null) return cachedBootedAtMs;
  try {
    const match = readFileSync("/proc/stat", "utf8").match(/^btime\s+(\d+)\s*$/m);
    const bootSeconds = Number(match?.[1]);
    if (Number.isFinite(bootSeconds) && bootSeconds > 0) cachedBootedAtMs = bootSeconds * 1000;
  } catch { /* fall back to the high-precision monotonic uptime below */ }
  if (cachedBootedAtMs === null) cachedBootedAtMs = nowMs - uptimeSec * 1000;
  return cachedBootedAtMs;
}

const blockedNames = /^(\.env(?:\..*)?|credentials?(?:\..*)?|.*(?:secret|password|token|private|cookie|session|wallet|\.pem|\.key)$|id_rsa.*|\.ssh|\.aws|\.gnupg|\.netrc)$/i;

function findRoot(kind: HostRoot): { path: string; label: string } | null {
  const cwd = process.cwd();
  if (kind === "system") {
    try { return { path: realpathSync("/"), label: "系统根目录" }; } catch { return null; }
  }
  if (kind === "private") {
    // Keep user-managed files beside the artifact's durable app data. This is a
    // real on-disk directory, not the blob-backed legacy virtual workspace.
    const privatePath = join(cwd, "data", "private");
    try {
      mkdirSync(privatePath, { recursive: true });
      return { path: realpathSync(privatePath), label: "私有文件" };
    } catch { return null; }
  }
  const workspaceCandidates = [join(homedir(), "workspace"), "/home/hatch/workspace"];
  const buildCandidates = [join(cwd, ".space-build"), join(cwd, "client", "dist"), "/home/hatch/workspace/ts-spaces/space-2/.space-build", "/home/hatch/workspace/ts-spaces/space-2/client/dist"];
  const candidates = kind === "workspace" ? workspaceCandidates : buildCandidates;
  const found = candidates.find((candidate) => {
    try { return existsSync(candidate) && lstatSync(candidate).isDirectory(); } catch { return false; }
  });
  if (found) return { path: realpathSync(found), label: kind === "workspace" ? "工作区文件" : "构件编译输出" };
  if (kind === "build") {
    try { if (lstatSync(cwd).isDirectory()) return { path: realpathSync(cwd), label: "构件运行目录" }; } catch { /* unavailable */ }
  }
  return null;
}

function safeRelative(raw: string, showSensitive: boolean): string | null {
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || (!showSensitive && blockedNames.test(part)))) return null;
  return parts.join("/");
}

function inside(root: string, absolute: string): boolean {
  const relation = relative(root, absolute);
  return relation !== ".." && !relation.startsWith(`..${sep}`);
}

/**
 * Resolve a browser path against the selected mode's starting directory.
 * An empty path means "go to the start"; an absolute path may point anywhere
 * on the host. Dot-segment traversal is rejected rather than normalized so
 * callers cannot smuggle `..` through an otherwise valid request.
 */
function resolveRequested(start: string, raw: string, showSensitive: boolean): { absolute: string; relativePath: string } | null {
  if (!raw) return { absolute: start, relativePath: start };
  const normalized = raw.replace(/\\/g, "/");
  const absoluteInput = normalized.startsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) return null;
  const absolute = absoluteInput ? resolve("/", ...parts) : resolve(start, ...parts);
  // Allow an absolute path that repeats the selected root (notably the
  // artifact's own data/private directory), while still filtering any
  // user-selected descendants and all paths outside that root.
  const checkPath = inside(start, absolute) ? relative(start, absolute) : absolute;
  const checkParts = checkPath.split("/").filter(Boolean);
  if (!showSensitive && checkParts.some((part) => blockedNames.test(part))) return null;
  return { absolute, relativePath: absolute };
}

// Migration remains intentionally confined to the artifact's private data root.
function resolveInside(root: string, raw: string, showSensitive: boolean): { absolute: string; relativePath: string } | null {
  const relativePath = safeRelative(raw, showSensitive);
  if (relativePath === null) return null;
  const absolute = resolve(root, relativePath);
  return inside(root, absolute) ? { absolute, relativePath } : null;
}

function resolveExisting(start: string, raw: string, showSensitive: boolean): { absolute: string; relativePath: string } | null {
  const target = resolveRequested(start, raw, showSensitive);
  if (!target) return null;
  try {
    const absolute = realpathSync(target.absolute);
    // The private root itself is intentionally named "private". Treat the
    // configured root as trusted and apply sensitive-name filtering only to
    // descendants. If a symlink escapes the root, inspect the full target.
    const checkPath = inside(start, absolute) ? relative(start, absolute) : absolute;
    const parts = checkPath.split("/").filter(Boolean);
    if (parts.some((part) => !showSensitive && blockedNames.test(part))) return null;
    return { absolute, relativePath: absolute };
  } catch { return null; }
}

function validLeaf(name: string, showSensitive: boolean): string | null {
  const clean = name.trim();
  if (!clean || clean === "." || clean === ".." || /[\\/\u0000-\u001f]/.test(clean) || (!showSensitive && blockedNames.test(clean))) return null;
  return clean;
}

function breadcrumbsFor(absolutePath: string, startName: string): Array<{ name: string; path: string }> {
  const crumbs: Array<{ name: string; path: string }> = [
    { name: `${startName}（起始）`, path: "" },
    { name: "/", path: "/" },
  ];
  const parts = absolutePath.split("/").filter(Boolean);
  let cursor = "";
  for (const part of parts) {
    cursor += `/${part}`;
    crumbs.push({ name: part, path: cursor });
  }
  return crumbs;
}

const knownTextExtensions = new Set([".txt", ".md", ".json", ".jsonl", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".scss", ".html", ".htm", ".xml", ".svg", ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg", ".properties", ".sql", ".log", ".csv", ".tsv", ".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".php", ".java", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".vue", ".svelte", ".gitignore", ".dockerignore"]);
const imageMimeByExtension = new Map<string, string>([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"],
  [".webp", "image/webp"], [".bmp", "image/bmp"], [".svg", "image/svg+xml"],
]);
const imagePreviewLimit = 15 * 1024 * 1024;
function canWrite(path: string): boolean { try { accessSync(path, constants.W_OK); return true; } catch { return false; } }
function isLikelyText(bytes: Uint8Array, path: string): boolean {
  if (knownTextExtensions.has(extname(path).toLowerCase())) return true;
  if (bytes.byteLength === 0) return true;
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 64_000));
  if (sample.some((byte) => byte === 0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(sample); } catch { return false; }
  let suspicious = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  return suspicious / sample.byteLength < 0.02;
}
function toHex(bytes: Uint8Array, offset: number): string {
  const lines: string[] = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const row = bytes.subarray(index, index + 16);
    const hex = [...row].map((value) => value.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = [...row].map((value) => value >= 32 && value <= 126 ? String.fromCharCode(value) : ".").join("");
    lines.push(`${(offset + index).toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return lines.join("\n");
}
function readSlice(path: string, offset: number, limit: number): Uint8Array {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const count = readSync(handle, buffer, 0, limit, offset);
    return buffer.subarray(0, count);
  } finally { closeSync(handle); }
}
function clampPercent(value: number): number { return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)); }
function cpuTick(line: string): CpuTickSample {
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  return { total: values.reduce((sum, value) => sum + value, 0), idle: (values[3] ?? 0) + (values[4] ?? 0) };
}
function cpuSample(): CpuSample {
  const lines = readFileSync("/proc/stat", "utf8").split("\n").filter((line) => /^cpu(?:\d+)?\s/.test(line));
  const totalLine = lines.find((line) => line.startsWith("cpu ")) ?? "cpu 0";
  const cores = new Map<string, CpuTickSample>();
  for (const line of lines) {
    const name = line.trim().split(/\s+/, 1)[0];
    if (name && name !== "cpu") cores.set(name, cpuTick(line));
  }
  return { total: cpuTick(totalLine), cores };
}
function percentFromTicks(current: CpuTickSample, previous?: CpuTickSample): number {
  if (!previous) return 0;
  const totalDelta = Math.max(0, current.total - previous.total);
  const idleDelta = Math.max(0, current.idle - previous.idle);
  return totalDelta > 0 ? clampPercent(((totalDelta - idleDelta) / totalDelta) * 100) : 0;
}
function networkSample(): Map<string, NetworkCounter> {
  const result = new Map<string, NetworkCounter>();
  for (const line of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
    if (!line.includes(":")) continue;
    const [ifaceRaw = "", statsRaw = ""] = line.split(":", 2);
    const name = ifaceRaw.trim();
    const stats = statsRaw.trim().split(/\s+/).map(Number);
    if (name) result.set(name, { rx: stats[0] ?? 0, tx: stats[8] ?? 0 });
  }
  return result;
}
function diskSample(): Map<string, DiskCounter> {
  const result = new Map<string, DiskCounter>();
  try {
    for (const line of readFileSync("/proc/diskstats", "utf8").split("\n")) {
      const fields = line.trim().split(/\s+/);
      const name = fields[2];
      if (!name || !/^(?:vd[a-z]+|sd[a-z]+|xvd[a-z]+|nvme\d+n\d+|dm-\d+|md\d+|loop\d+)$/.test(name)) continue;
      const sectorsRead = Number(fields[5] ?? 0);
      const sectorsWritten = Number(fields[9] ?? 0);
      result.set(name, { readBytes: sectorsRead * 512, writeBytes: sectorsWritten * 512 });
    }
  } catch { /* unavailable */ }
  return result;
}
function memorySample(): { total: number; used: number; cached: number; buffers: number; available: number; percent: number } {
  const values = new Map<string, number>();
  for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const match = line.match(/^([^:]+):\s+(\d+)/);
    if (match?.[1] && match[2]) values.set(match[1], Number(match[2]) * 1024);
  }
  const total = values.get("MemTotal") ?? 0;
  const free = values.get("MemFree") ?? 0;
  const available = values.get("MemAvailable") ?? free;
  const cached = values.get("Cached") ?? 0;
  const buffers = values.get("Buffers") ?? 0;
  const used = Math.max(0, total - free - cached - buffers);
  return { total, used, cached, buffers, available, percent: total > 0 ? clampPercent((used / total) * 100) : 0 };
}
function mountSample(path: string): { path: string; total: number; used: number; available: number; percent: number } {
  try {
    const stats = statfsSync(path);
    const blockSize = Number(stats.bsize);
    const total = Number(stats.blocks) * blockSize;
    const available = Number(stats.bavail) * blockSize;
    const free = Number(stats.bfree) * blockSize;
    const used = Math.max(0, total - free);
    return { path, total, used, available, percent: used + available > 0 ? clampPercent((used / (used + available)) * 100) : 0 };
  } catch { return { path, total: 0, used: 0, available: 0, percent: 0 }; }
}
function processSamples(): Map<number, ProcSample> {
  const result = new Map<number, ProcSample>();
  let entries: string[] = [];
  try { entries = readdirSync("/proc"); } catch { return result; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = raw.lastIndexOf(")"); const open = raw.indexOf("(");
      if (open < 0 || close < 0) continue;
      const rest = raw.slice(close + 2).trim().split(/\s+/);
      result.set(Number(entry), { pid: Number(entry), name: raw.slice(open + 1, close), status: rest[0] ?? "?", ticks: Number(rest[11] ?? 0) + Number(rest[12] ?? 0), rss: Math.max(0, Number(rest[21] ?? 0) * 4096) });
    } catch { /* process exited */ }
  }
  return result;
}
function sleep(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function directorySize(path: string): Promise<{ size: number; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    execFile("du", ["-s", "-B1", "-x", "--", path], { timeout: 3800, maxBuffer: 64_000 }, (error, stdout) => {
      const candidate = error as (Error & { killed?: boolean; signal?: string }) | null;
      const timedOut = Boolean(candidate?.killed || candidate?.signal === "SIGTERM");
      const first = String(stdout).trim().split(/\s+/, 1)[0];
      const size = Number(first ?? 0);
      resolvePromise({ size: Number.isFinite(size) ? Math.max(0, size) : 0, timedOut });
    });
  });
}
function scannableHomeDirectories(): Array<{ name: string; path: string }> {
  const home = "/home/hatch";
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !blockedNames.test(entry.name))
      .map((entry) => ({ name: entry.name, path: join(home, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  } catch { return []; }
}
function identity(): string { try { const user = userInfo(); return `${user.username} · uid ${user.uid}`; } catch { return "运行用户未知"; } }

function getDirectory(rootKind: HostRoot, raw: string, showSensitive: boolean) {
  const selectedRoot = findRoot(rootKind);
  if (!selectedRoot) return null;
  const target = resolveExisting(selectedRoot.path, raw, showSensitive);
  if (!target) return null;
  try { return statSync(target.absolute).isDirectory() ? { ...target, root: selectedRoot } : null; } catch { return null; }
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async listHostDirectory(args) {
    const selectedRoot = findRoot(args.root);
    const labels: Record<HostRoot, string> = { system: "系统根目录", workspace: "工作区文件", build: "构件编译输出", private: "私有文件" };
    const startName = args.root === "system" ? "系统" : args.root === "workspace" ? "工作区" : args.root === "build" ? "构件" : "私有";
    const empty = { ok: false, message: "这个目录在当前构件运行环境中不可用。", root: args.root, path: "", absolutePath: "", locationLabel: labels[args.root], entries: [], breadcrumbs: [{ name: `${startName}（起始）`, path: "" }], truncated: false, writable: false, userIdentity: identity() };
    if (!selectedRoot) return empty;
    const target = resolveExisting(selectedRoot.path, args.path, args.showSensitive);
    if (!target) return { ...empty, message: "路径无效、不可达，或属于当前隐藏的敏感位置。" };
    try {
      if (!statSync(target.absolute).isDirectory()) return { ...empty, message: "这个位置不是文件夹。" };
      const dirents = readdirSync(target.absolute, { withFileTypes: true });
      const filtered = dirents.filter((entry) => args.showSensitive || !blockedNames.test(entry.name));
      const visible = filtered.slice(0, 500);
      const entries = visible.map((entry) => {
        const lexical = join(target.absolute, entry.name);
        let size = 0; let modifiedAt = new Date(0).toISOString(); let writable = false;
        let targetKind: "folder" | "file" | "other" | "broken" | null = null;
        try {
          const lstats = lstatSync(lexical);
          modifiedAt = lstats.mtime.toISOString();
          if (entry.isSymbolicLink()) {
            try {
              const resolved = realpathSync(lexical);
              const resolvedParts = resolved.split("/").filter(Boolean);
              if (!args.showSensitive && resolvedParts.some((part) => blockedNames.test(part))) targetKind = "other";
              else {
                const targetStats = statSync(resolved);
                targetKind = targetStats.isDirectory() ? "folder" : targetStats.isFile() ? "file" : "other";
                size = targetStats.isFile() ? targetStats.size : 0;
                writable = canWrite(resolved);
              }
            } catch { targetKind = "broken"; }
          } else {
            size = lstats.isFile() ? lstats.size : 0;
            writable = canWrite(lexical);
          }
        } catch { /* disappeared */ }
        const path = join(target.absolute, entry.name);
        return { name: entry.name, path, kind: entry.isDirectory() ? "folder" as const : entry.isSymbolicLink() ? "link" as const : "file" as const, targetKind, size, modifiedAt, writable, removable: canWrite(target.absolute) };
      }).sort((a, b) => {
        const rank = (entry: typeof a) => entry.kind === "folder" || entry.targetKind === "folder" ? 0 : entry.kind === "file" || entry.targetKind === "file" ? 1 : 2;
        return rank(a) - rank(b) || a.name.localeCompare(b.name, "zh-CN", { numeric: true });
      });
      return { ok: true, message: `${entries.length} 个项目`, root: args.root, path: target.absolute, absolutePath: target.absolute, locationLabel: selectedRoot.label, entries, breadcrumbs: breadcrumbsFor(target.absolute, startName), truncated: filtered.length > visible.length, writable: canWrite(target.absolute), userIdentity: identity() };
    } catch { return { ...empty, path: target.absolute, absolutePath: target.absolute, breadcrumbs: breadcrumbsFor(target.absolute, startName), message: "目录无法读取，可能已移动或权限不足。" }; }
  },

  async listHostImages(args) {
    const directory = getDirectory(args.root, args.path, args.showSensitive);
    if (!directory) return { ok: false, message: "路径无效、不可达，或属于当前隐藏的敏感位置。", entries: [] };
    try {
      const entries = readdirSync(directory.absolute, { withFileTypes: true })
        .filter((entry) => (args.showSensitive || !blockedNames.test(entry.name)) && imageMimeByExtension.has(extname(entry.name).toLowerCase()))
        .flatMap((entry) => {
          const lexical = join(directory.absolute, entry.name);
          try {
            const lstats = lstatSync(lexical);
            let targetKind: "folder" | "file" | "other" | "broken" | null = null;
            let size = 0;
            let writable = false;
            if (entry.isSymbolicLink()) {
              try {
                const resolved = realpathSync(lexical);
                if (!args.showSensitive && resolved.split("/").filter(Boolean).some((part) => blockedNames.test(part))) return [];
                const targetStats = statSync(resolved);
                targetKind = targetStats.isFile() ? "file" : targetStats.isDirectory() ? "folder" : "other";
                if (targetKind !== "file") return [];
                size = targetStats.size;
                writable = canWrite(resolved);
              } catch { return []; }
            } else {
              if (!lstats.isFile()) return [];
              size = lstats.size;
              writable = canWrite(lexical);
            }
            return [{ name: entry.name, path: lexical, kind: entry.isSymbolicLink() ? "link" as const : "file" as const, targetKind, size, modifiedAt: lstats.mtime.toISOString(), writable, removable: canWrite(directory.absolute) }];
          } catch { return []; }
        })
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
      return { ok: true, message: `${entries.length} 张图片`, entries };
    } catch { return { ok: false, message: "目录图片无法读取，可能已移动或权限不足。", entries: [] }; }
  },

  async readHostFileChunk(args) {
    const selectedRoot = findRoot(args.root);
    const denied = { ok: false, message: "文件在当前构件运行环境中不可用。", name: null, mode: null, content: null, offset: args.offset, nextOffset: args.offset, totalSize: 0, eof: true, editable: false, writable: false };
    if (!selectedRoot) return denied;
    const target = resolveExisting(selectedRoot.path, args.path, args.showSensitive);
    if (!target) return { ...denied, message: "路径无效、不可达，或属于当前隐藏的敏感位置。" };
    try {
      const stats = statSync(target.absolute);
      if (!stats.isFile()) return { ...denied, message: "只能预览文件。" };
      const first = readSlice(target.absolute, 0, Math.min(64_000, Math.max(1, stats.size)));
      const text = isLikelyText(first, target.absolute);
      const bytes = readSlice(target.absolute, Math.min(args.offset, stats.size), args.limit);
      const nextOffset = Math.min(stats.size, args.offset + bytes.byteLength);
      const writable = canWrite(target.absolute);
      return {
        ok: true,
        message: text ? `文本分页 · ${args.offset + 1}-${nextOffset} / ${stats.size} 字节` : `十六进制分页 · ${args.offset}-${Math.max(args.offset, nextOffset - 1)} / ${stats.size} 字节`,
        name: basename(target.absolute), mode: text ? "text" as const : "hex" as const,
        content: text ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : toHex(bytes, args.offset),
        offset: args.offset, nextOffset, totalSize: stats.size, eof: nextOffset >= stats.size,
        editable: text && stats.size <= 8_000_000 && writable, writable,
      };
    } catch { return { ...denied, message: "文件无法读取，可能已移动或权限不足。" }; }
  },

  async readHostDownloadChunk(args) {
    const selectedRoot = findRoot(args.root);
    const denied = { ok: false, message: "文件不可用。", name: null, dataBase64: null, nextOffset: args.offset, totalSize: 0, eof: true };
    if (!selectedRoot) return denied;
    const target = resolveExisting(selectedRoot.path, args.path, args.showSensitive);
    if (!target) return { ...denied, message: "路径无效、不可达，或属于当前隐藏的敏感位置。" };
    try {
      const stats = statSync(target.absolute);
      if (!stats.isFile()) return { ...denied, message: "只能下载文件。" };
      const bytes = readSlice(target.absolute, Math.min(args.offset, stats.size), args.limit);
      const nextOffset = Math.min(stats.size, args.offset + bytes.byteLength);
      return { ok: true, message: "文件分块已读取。", name: basename(target.absolute), dataBase64: Buffer.from(bytes).toString("base64"), nextOffset, totalSize: stats.size, eof: nextOffset >= stats.size };
    } catch { return { ...denied, message: "文件无法读取。" }; }
  },

  async getHostImagePreview(args) {
    const selectedRoot = findRoot(args.root);
    const denied = { ok: false, message: "图片不可用。", name: null, mimeType: null, dataBase64: null, size: 0, tooLarge: false };
    if (!selectedRoot) return denied;
    const target = resolveExisting(selectedRoot.path, args.path, args.showSensitive);
    if (!target) return { ...denied, message: "路径无效、不可达，或属于当前隐藏的敏感位置。" };
    try {
      const stats = statSync(target.absolute);
      if (!stats.isFile()) return { ...denied, message: "只能预览图片文件。" };
      const mimeType = imageMimeByExtension.get(extname(target.absolute).toLowerCase());
      if (!mimeType) return { ...denied, name: basename(target.absolute), size: stats.size, message: "此图片格式不支持预览。" };
      if (stats.size > imagePreviewLimit) {
        return { ok: false, message: "文件过大，建议下载", name: basename(target.absolute), mimeType, dataBase64: null, size: stats.size, tooLarge: true };
      }
      const bytes = readFileSync(target.absolute);
      return { ok: true, message: "图片已载入。", name: basename(target.absolute), mimeType, dataBase64: bytes.toString("base64"), size: stats.size, tooLarge: false };
    } catch {
      return { ...denied, message: "图片读取失败，文件可能已损坏、移动或没有读取权限。" };
    }
  },

  async writeHostTextFile(args) {
    const selectedRoot = findRoot(args.root);
    if (!selectedRoot) return { ok: false, message: "这个目录在当前构件运行环境中不可用。" };
    const target = resolveExisting(selectedRoot.path, args.path, args.showSensitive);
    if (!target) return { ok: false, message: "路径无效、不可达，或属于当前隐藏的敏感位置。" };
    let temporaryPath = "";
    try {
      const stats = statSync(target.absolute);
      if (!stats.isFile()) return { ok: false, message: "只能编辑文件。" };
      const first = readSlice(target.absolute, 0, Math.min(64_000, Math.max(1, stats.size)));
      if (!isLikelyText(first, target.absolute)) return { ok: false, message: "二进制文件只能查看十六进制或下载，不能按文本保存。" };
      if (!canWrite(target.absolute)) return { ok: false, message: "当前运行用户没有这个文件的写入权限。" };
      const parentDirectory = dirname(target.absolute);
      if (!canWrite(parentDirectory)) return { ok: false, message: "为保护原文件，保存需要其所在目录可写；当前目录只读，未作任何更改。" };
      temporaryPath = join(parentDirectory, `.${basename(target.absolute)}.muse-${crypto.randomUUID()}.tmp`);
      writeFileSync(temporaryPath, args.content, { encoding: "utf8", mode: stats.mode, flag: "wx" });
      renameSync(temporaryPath, target.absolute);
      temporaryPath = "";
      return { ok: true, message: "文件已原子保存，原内容已安全替换。" };
    } catch {
      if (temporaryPath) try { unlinkSync(temporaryPath); } catch { /* temporary file may not exist */ }
      return { ok: false, message: "保存失败，原文件未被主动删除；请检查目录权限或文件是否已移动。" };
    }
  },

  async createHostFile(args) {
    const directory = getDirectory(args.root, args.directory, args.showSensitive);
    const name = validLeaf(args.name, args.showSensitive);
    if (!directory || !name) return { ok: false, message: "目录或文件名无效。", path: null };
    const destination = join(directory.absolute, name);
    if (existsSync(destination)) return { ok: false, message: "同名项目已经存在。", path: null };
    try { writeFileSync(destination, "", { encoding: "utf8", flag: "wx" }); return { ok: true, message: "文件已创建。", path: destination }; }
    catch { return { ok: false, message: "创建失败，当前运行用户可能没有目录写入权限。", path: null }; }
  },

  async createHostDirectory(args) {
    const directory = getDirectory(args.root, args.directory, args.showSensitive);
    const name = validLeaf(args.name, args.showSensitive);
    if (!directory || !name) return { ok: false, message: "目录或文件夹名称无效。", path: null };
    const destination = join(directory.absolute, name);
    if (existsSync(destination)) return { ok: false, message: "同名项目已经存在。", path: null };
    try { mkdirSync(destination); return { ok: true, message: "文件夹已创建。", path: destination }; }
    catch { return { ok: false, message: "创建失败，当前运行用户可能没有目录写入权限。", path: null }; }
  },

  async deleteHostEntry(args) {
    const selectedRoot = findRoot(args.root);
    if (!selectedRoot || !args.path) return { ok: false, message: "不能删除这个位置。" };
    const source = resolveRequested(selectedRoot.path, args.path, args.showSensitive);
    if (!source || !existsSync(source.absolute)) return { ok: false, message: "项目不存在或路径无效。" };
    const parent = dirname(source.absolute);
    const quarantine = join(parent, `.${basename(source.absolute)}.muse-delete-${crypto.randomUUID()}`);
    let staged = false;
    try {
      renameSync(source.absolute, quarantine);
      staged = true;
      rmSync(quarantine, { recursive: true, force: false });
      if (existsSync(quarantine) || existsSync(source.absolute)) return { ok: false, message: "删除未完成：文件系统仍报告项目存在，请刷新后重试。" };
      return { ok: true, message: "项目已从磁盘永久删除。" };
    } catch {
      if (staged && existsSync(quarantine) && !existsSync(source.absolute)) {
        try { renameSync(quarantine, source.absolute); } catch {
          return { ok: false, message: `删除过程中断，项目保留在同目录临时位置 ${basename(quarantine)}；请勿重复操作。` };
        }
      }
      return { ok: false, message: existsSync(source.absolute) ? "删除失败，原项目仍在原位置；请检查上级目录权限。" : "删除状态异常，请刷新目录确认实际结果后再操作。" };
    }
  },

  async moveHostEntry(args) {
    const selectedRoot = findRoot(args.root);
    const targetDirectory = getDirectory(args.root, args.targetDirectory, args.showSensitive);
    const name = validLeaf(args.newName, args.showSensitive);
    if (!selectedRoot || !targetDirectory || !name || !args.path) return { ok: false, message: "源路径、目标目录或名称无效。", path: null };
    const source = resolveRequested(selectedRoot.path, args.path, args.showSensitive);
    if (!source || !existsSync(source.absolute)) return { ok: false, message: "源项目不存在。", path: null };
    const destination = join(targetDirectory.absolute, name);
    if (existsSync(destination)) return { ok: false, message: "目标位置已有同名项目。", path: null };
    try {
      renameSync(source.absolute, destination);
      if (!existsSync(destination) || existsSync(source.absolute)) return { ok: false, message: "移动结果无法确认，请刷新源目录和目标目录后再操作。", path: null };
      return { ok: true, message: "项目已在磁盘上移动或重命名。", path: destination };
    } catch {
      return { ok: false, message: existsSync(source.absolute) ? "移动失败，原项目仍在原位置；请检查权限、目标路径或是否跨文件系统。" : "移动状态异常，请刷新目录确认实际位置后再操作。", path: null };
    }
  },

  async uploadHostFile(args) {
    const directory = getDirectory(args.root, args.directory, args.showSensitive);
    const name = validLeaf(args.name, args.showSensitive);
    if (!directory || !name) return { ok: false, message: "目录或文件名无效。", path: null };
    const destination = join(directory.absolute, name);
    if (existsSync(destination)) return { ok: false, message: "同名项目已经存在。", path: null };
    try {
      const bytes = Buffer.from(args.dataBase64, "base64");
      if (bytes.byteLength > 12_000_000) return { ok: false, message: "单个上传文件不能超过 12 MB。", path: null };
      writeFileSync(destination, bytes, { flag: "wx" });
      return { ok: true, message: "文件已上传到磁盘目录。", path: destination };
    } catch { return { ok: false, message: "上传失败，当前运行用户可能没有目录写入权限。", path: null }; }
  },

  async materializePrivateWorkspace(args) {
    const root = findRoot("private");
    if (!root) return { ok: false, message: "私有目录无法创建。", migrated: false, path: "" };
    const marker = join(dirname(root.path), ".private-workspace-migrated-v1");
    if (existsSync(marker)) return { ok: true, message: "私有目录已使用磁盘存储。", migrated: false, path: root.path };
    try {
      const folders = args.entries.filter((entry) => entry.kind === "folder").sort((a, b) => a.path.split("/").length - b.path.split("/").length);
      const files = args.entries.filter((entry) => entry.kind === "file");
      for (const entry of [...folders, ...files]) {
        const target = resolveInside(root.path, entry.path, false);
        if (!target || !target.relativePath) throw new Error("invalid migration path");
        if (entry.kind === "folder") {
          if (existsSync(target.absolute) && !statSync(target.absolute).isDirectory()) throw new Error("folder conflict");
          mkdirSync(target.absolute, { recursive: true });
          continue;
        }
        mkdirSync(dirname(target.absolute), { recursive: true });
        if (existsSync(target.absolute)) continue;
        if (entry.dataBase64 === null) throw new Error("missing file data");
        writeFileSync(target.absolute, Buffer.from(entry.dataBase64, "base64"), { flag: "wx" });
      }
      writeFileSync(marker, `${new Date().toISOString()}\n`, { encoding: "utf8", flag: "wx" });
      return { ok: true, message: args.entries.length ? `已把 ${args.entries.length} 个原有项目迁移到真实目录。` : "私有目录已切换为真实磁盘目录。", migrated: args.entries.length > 0, path: root.path };
    } catch {
      return { ok: false, message: "原有私有数据迁移未完成；旧数据仍保留，请重试。", migrated: false, path: root.path };
    }
  },

  async executeShell(args) {
    const directory = getDirectory(args.root, args.path, true);
    const cwd = directory?.absolute ?? findRoot(args.root)?.path ?? process.cwd();
    const started = Date.now();
    return new Promise((resolvePromise) => {
      exec(args.command, { cwd, timeout: 30000, maxBuffer: 1_000_000, shell: "/bin/bash" }, (error, stdout, stderr) => {
        const candidate = error as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
        const timedOut = Boolean(candidate?.killed && candidate.signal === "SIGTERM");
        const code = typeof candidate?.code === "number" ? candidate.code : error ? null : 0;
        resolvePromise({ ok: !error, stdout: String(stdout), stderr: timedOut ? `${String(stderr)}${stderr ? "\n" : ""}命令超过 30 秒，已终止。` : String(stderr), exitCode: code, timedOut, cwd, durationMs: Math.max(0, Date.now() - started) });
      });
    });
  },

  async readSystemSnapshot() {
    const previous: RateSample = { atMs: Date.now(), cpu: cpuSample(), network: networkSample(), disks: diskSample(), processes: processSamples() };
    await sleep(600);
    const atMs = Date.now();
    const current: RateSample = { atMs, cpu: cpuSample(), network: networkSample(), disks: diskSample(), processes: processSamples() };
    const elapsedSec = Math.max(0.05, (current.atMs - previous.atMs) / 1000);
    const cpuPercent = percentFromTicks(current.cpu.total, previous?.cpu.total);
    const cpuCores = [...current.cpu.cores.entries()].map(([name, ticks]) => ({ name, percent: percentFromTicks(ticks, previous?.cpu.cores.get(name)) }));
    const totalDelta = previous ? Math.max(0, current.cpu.total.total - previous.cpu.total.total) : 0;
    const coreCount = Math.max(1, cpus().length);
    const allProcesses = [...current.processes.values()].map((processNow) => {
      const processBefore = previous?.processes.get(processNow.pid);
      const tickDelta = Math.max(0, processNow.ticks - (processBefore?.ticks ?? processNow.ticks));
      return { pid: processNow.pid, name: processNow.name, cpuPercent: totalDelta > 0 ? clampPercent((tickDelta / totalDelta) * coreCount * 100) : 0, memoryBytes: processNow.rss, status: processNow.status };
    });
    const processesByCpu = [...allProcesses].sort((a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes).slice(0, 18);
    const processesByMemory = [...allProcesses].sort((a, b) => b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent).slice(0, 18);
    const interfaces = [...current.network.entries()].map(([name, counters]) => {
      const before = previous?.network.get(name);
      return { name, rxPerSec: elapsedSec > 0 ? Math.max(0, (counters.rx - (before?.rx ?? counters.rx)) / elapsedSec) : 0, txPerSec: elapsedSec > 0 ? Math.max(0, (counters.tx - (before?.tx ?? counters.tx)) / elapsedSec) : 0 };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const network = interfaces.filter((item) => item.name !== "lo").reduce((sum, item) => ({ rxPerSec: sum.rxPerSec + item.rxPerSec, txPerSec: sum.txPerSec + item.txPerSec }), { rxPerSec: 0, txPerSec: 0 });
    const disks = [...current.disks.entries()].map(([name, counters]) => {
      const before = previous?.disks.get(name);
      return { name, readPerSec: elapsedSec > 0 ? Math.max(0, (counters.readBytes - (before?.readBytes ?? counters.readBytes)) / elapsedSec) : 0, writePerSec: elapsedSec > 0 ? Math.max(0, (counters.writeBytes - (before?.writeBytes ?? counters.writeBytes)) / elapsedSec) : 0 };
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const sampledAt = new Date(atMs);
    const uptimeSec = uptime();
    const serviceUptimeSec = process.uptime();
    let kernelVersion = `${platform()} ${release()}`;
    try { kernelVersion = readFileSync("/proc/version", "utf8").trim(); } catch { /* use compact fallback */ }
    return {
      sampledAt: sampledAt.toISOString(), platform: `${platform()} ${release()}`, hostname: hostname(), kernelVersion,
      uptimeSec, serviceUptimeSec, bootedAt: new Date(systemBootedAtMs(atMs, uptimeSec)).toISOString(), serviceStartedAt: new Date(atMs - serviceUptimeSec * 1000).toISOString(),
      cpuPercent, cpuCores, loadAverage: loadavg(), memory: memorySample(), mounts: [mountSample("/"), mountSample("/home/hatch"), mountSample("/tmp")], disks,
      network: { ...network, interfaces }, processCount: current.processes.size, processesByCpu, processesByMemory,
    };
  },

  async scanHomeDirectories(args) {
    const directories = scannableHomeDirectories();
    const target = directories[args.offset];
    if (!target) return { ok: true, message: directories.length ? "扫描完成。" : "没有可扫描的一级目录。", item: null, nextOffset: directories.length, total: directories.length, done: true };
    const measured = await directorySize(target.path);
    const nextOffset = args.offset + 1;
    return {
      ok: true,
      message: measured.timedOut ? `${target.name} 扫描超过 3.8 秒，已跳过，界面没有被阻塞。` : `已扫描 ${target.name}`,
      item: { name: target.name, path: target.path, size: measured.size, timedOut: measured.timedOut },
      nextOffset,
      total: directories.length,
      done: nextOffset >= directories.length,
    };
  },
});
