/**
 * Security helpers for the AI terminal.
 *
 * Kept in a standalone module (no platform SDK imports) so the SSRF guard and
 * confirmation-token primitives can be unit tested directly.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const AI_REQUEST_TIMEOUT_MS = 60_000;
// Agent steps run inside one platform action call. Keep each call below the
// gateway limit while still allowing slow models enough time to answer.
export const AI_AGENT_REQUEST_TIMEOUT_MS = 100_000;

/**
 * Structured failure details for the AI terminal. The UI shows these verbatim so a
 * failing request can be diagnosed without digging through sandbox logs.
 */
export type AiDiagnostic = {
  phase: "request" | "http" | "response-json" | "model-json" | "shell";
  url: string;
  status: number | null;
  model: string;
  detail: string;
  responseSnippet: string;
  contentSnippet: string;
};


export class AiRequestError extends Error {
  readonly diagnostic: AiDiagnostic;

  constructor(message: string, diagnostic: AiDiagnostic) {
    super(message);
    this.name = "AiRequestError";
    this.diagnostic = diagnostic;
  }
}

// The model answered with an empty tool call or empty content. Some
// OpenAI-compatible proxies drop tool arguments, so callers may retry once
// instead of failing the whole task.
export class AiEmptyOutputError extends AiRequestError {
  constructor(message: string, diagnostic: AiDiagnostic) {
    super(message, diagnostic);
    this.name = "AiEmptyOutputError";
  }
}

export function describeAiError(error: unknown): AiDiagnostic | null {
  return error instanceof AiRequestError ? error.diagnostic : null;
}

export function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

const PRIVATE_IPV4_PATTERN = /^(?:0|10|127|169\.254|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|172\.(?:1[6-9]|2\d|3[01]))\./;

export function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized) return true;
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized.endsWith(".local") || normalized.endsWith(".internal")) return true;
  if (normalized.includes(":")) return true;
  if (PRIVATE_IPV4_PATTERN.test(normalized)) return true;
  return false;
}

export function normalizeAiBaseUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    if (isPrivateHostname(parsed.hostname)) return null;
    const pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch { return null; }
}

export function requirePublicBaseUrl(value: string): string {
  const normalized = normalizeAiBaseUrl(value);
  if (!normalized) throw new Error("模型地址必须是公网 http(s) 地址，不能指向本机、内网、链路本地或 .local 主机。");
  return normalized;
}

// Models sometimes repeat the JSON object or append extra text. Return the first
// balanced top-level object so `{...}\n{...}` still parses.
function firstJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

export function parseAiCommandContent(content: string): { command: string; explanation: string; done: boolean } {
  const normalized = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const firstObject = firstJsonObject(normalized);
  const candidates = firstObject && firstObject !== normalized ? [normalized, firstObject] : [normalized];
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object") {
        const record = value as { command?: unknown; explanation?: unknown; done?: unknown };
        return { command: String(record.command ?? "").trim(), explanation: String(record.explanation ?? ""), done: record.done === true };
      }
    } catch { /* try the next candidate */ }
  }
  // Last resort: some models ignore the JSON contract and answer with a fenced
  // shell block. Run its first command instead of failing the whole task.
  const salvaged = salvageAiCommandFields(normalized);
  if (salvaged) return salvaged;
  const fenced = /```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/i.exec(content);
  const fallback = fenced?.[1]?.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  if (fallback) return { command: fallback, explanation: "模型没有返回 JSON，已改用代码块中的命令。", done: false };
  throw new Error("模型没有返回可解析的 JSON。");
}

// OpenAI-compatible providers may return message.content as a plain string or as
// an array of typed parts; both shapes must survive JSON parsing.
export function extractAiContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") return (part as { text: string }).text;
      return "";
    }).join("");
  }
  return "";
}

export type AiToolCall = { name: string; arguments: string };

function readAiToolCall(value: unknown): AiToolCall | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { function?: unknown; name?: unknown; arguments?: unknown };
  const fn = record.function && typeof record.function === "object" ? record.function as { name?: unknown; arguments?: unknown } : record;
  const name = typeof fn.name === "string" ? fn.name : "";
  const rawArguments = fn.arguments;
  const args = typeof rawArguments === "string" ? rawArguments : rawArguments && typeof rawArguments === "object" ? JSON.stringify(rawArguments) : "";
  return { name, arguments: args };
}

export function extractAiToolCalls(value: unknown): AiToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map(readAiToolCall).filter((call): call is AiToolCall => call !== null);
}

export function extractAiFunctionCall(value: unknown): AiToolCall | null {
  return readAiToolCall(value);
}

export type AiMessageCommand = { text: string; source: "content" | "tool_call" | "function_call"; toolName: string };

// Some OpenAI-compatible models answer with tool_calls or function_call instead of
// a JSON content string. Prefer text content, then fall back to tool arguments.
export function extractAiMessageCommand(message: unknown): AiMessageCommand | null {
  if (!message || typeof message !== "object") return null;
  const record = message as { content?: unknown; tool_calls?: unknown; function_call?: unknown };
  const content = extractAiContent(record.content);
  if (content.trim()) return { text: content, source: "content", toolName: "" };
  const firstToolCall = extractAiToolCalls(record.tool_calls)[0];
  if (firstToolCall) return { text: firstToolCall.arguments, source: "tool_call", toolName: firstToolCall.name };
  const functionCall = extractAiFunctionCall(record.function_call);
  if (functionCall) return { text: functionCall.arguments, source: "function_call", toolName: functionCall.name };
  return null;
}
// Reads a quoted string starting at `startIndex`, tolerating escaped characters
// and a truncated tail (model output cut off mid-string).
function readQuotedString(value: string, startIndex: number): { text: string; endIndex: number } | null {
  const quote = value[startIndex];
  if (quote !== "\"" && quote !== "'") return null;
  let out = "";
  for (let index = startIndex + 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") {
      const next = value[index + 1];
      if (next === undefined) break;
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === "u") {
        const hex = value.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); index += 4; }
        else out += "u";
      } else out += next;
      index += 1;
      continue;
    }
    if (char === quote) return { text: out, endIndex: index };
    out += char;
  }
  return out ? { text: out, endIndex: value.length } : null;
}

// Last-resort field extraction for malformed JSON (truncated output, trailing
// commas, single quotes or unquoted keys) without pulling in a JSON repair dep.
function salvageAiCommandFields(content: string): { command: string; explanation: string; done: boolean } | null {
  const result: { command?: string; explanation?: string; done?: boolean } = {};
  const keyPattern = /["']?(command|explanation|done)["']?\s*:\s*/gi;
  let match: RegExpExecArray | null;
  while ((match = keyPattern.exec(content)) !== null) {
    const key = (match[1] ?? "").toLowerCase();
    const valueStart = match.index + match[0].length;
    if (key === "done") {
      const boolMatch = /^(true|false)/i.exec(content.slice(valueStart).trimStart());
      if (boolMatch) result.done = boolMatch[1]?.toLowerCase() === "true";
      continue;
    }
    const offset = content.slice(valueStart).search(/\S/);
    if (offset < 0) continue;
    const parsed = readQuotedString(content, valueStart + offset);
    if (!parsed) continue;
    result[key as "command" | "explanation"] = parsed.text;
    keyPattern.lastIndex = parsed.endIndex + 1;
  }
  if (result.command === undefined && result.done !== true) return null;
  return { command: (result.command ?? "").trim(), explanation: result.explanation ?? "模型输出不是合法 JSON，已从文本中恢复字段。", done: result.done ?? false };
}
