/**
 * Security helpers for the AI terminal.
 *
 * Kept in a standalone module (no platform SDK imports) so the SSRF guard and
 * confirmation-token primitives can be unit tested directly.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const AI_REQUEST_TIMEOUT_MS = 60_000;

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

export function parseAiCommandContent(content: string): { command: string; explanation: string; done: boolean } {
  const normalized = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const candidates = [normalized];
  const objectStart = normalized.indexOf("{");
  const objectEnd = normalized.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(normalized.slice(objectStart, objectEnd + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object") {
        const record = value as { command?: unknown; explanation?: unknown; done?: unknown };
        return { command: String(record.command ?? "").trim(), explanation: String(record.explanation ?? ""), done: Boolean(record.done) };
      }
    } catch { /* try the next candidate */ }
  }
  throw new Error("模型没有返回可解析的 JSON。");
}
