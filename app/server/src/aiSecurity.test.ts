import { describe, expect, test } from "bun:test";
import { AiRequestError, constantTimeEqual, describeAiError, digestToken, extractAiContent, isPrivateHostname, normalizeAiBaseUrl, parseAiCommandContent, randomToken, redactSecrets, requirePublicBaseUrl } from "./aiSecurity";

describe("SSRF guard", () => {
  test("accepts public OpenAI-compatible hosts", () => {
    expect(requirePublicBaseUrl("https://api.openai.com")).toBe("https://api.openai.com/v1");
    expect(requirePublicBaseUrl("https://api.deepseek.com/v1/")).toBe("https://api.deepseek.com/v1");
    expect(requirePublicBaseUrl("http://example.com/proxy")).toBe("http://example.com/proxy/v1");
  });

  test("rejects localhost, private ranges, link-local and metadata hosts", () => {
    const blocked = [
      "http://localhost:11434/v1",
      "http://127.0.0.1:8080/v1",
      "http://0.0.0.0/v1",
      "http://10.1.2.3/v1",
      "http://192.168.3.114:1080/v1",
      "http://172.16.0.1/v1",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1/v1",
      "http://metadata.google.internal/v1",
      "http://router.local/v1",
      "http://[::1]:8080/v1",
      "file:///etc/passwd",
      "https://user:pass@api.example.com/v1",
    ];
    for (const url of blocked) {
      expect(isPrivateHostname(new URL(url.startsWith("file") ? "http://placeholder" : url).hostname) || normalizeAiBaseUrl(url) === null).toBe(true);
    }
  });

  test("isPrivateHostname covers .internal", () => {
    expect(isPrivateHostname("foo.internal")).toBe(true);
    expect(isPrivateHostname("api.openai.com")).toBe(false);
  });
});

describe("confirmation tokens", () => {
  test("random tokens are unique and long enough", () => {
    const first = randomToken();
    const second = randomToken();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(60);
  });

  test("digest is deterministic and not the raw token", () => {
    const token = randomToken();
    expect(digestToken(token)).toBe(digestToken(token));
    expect(digestToken(token)).not.toBe(token);
  });

  test("constantTimeEqual matches equal strings only", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("model output parsing", () => {
  test("parses plain JSON", () => {
    expect(parseAiCommandContent('{"command":"pwd","explanation":"show cwd","done":false}')).toEqual({ command: "pwd", explanation: "show cwd", done: false });
  });

  test("parses fenced JSON", () => {
    expect(parseAiCommandContent('```json\n{"command":"ls","explanation":"","done":false}\n```').command).toBe("ls");
  });

  test("parses JSON surrounded by prose", () => {
    expect(parseAiCommandContent('Here is the next step:\n{"command":"git status","explanation":"check","done":false}\nHope that helps').command).toBe("git status");
  });

  test("returns empty command for done tasks", () => {
    expect(parseAiCommandContent('{"command":"","explanation":"all done","done":true}').done).toBe(true);
  });

  test("throws on unparseable content", () => {
    expect(() => parseAiCommandContent("not json at all")).toThrow();
  });
  test(
    "falls back to the first line of a fenced shell block", () => {
      expect(parseAiCommandContent("```bash\nls -la\necho done\n```")).toEqual({ command: "ls -la", explanation: "模型没有返回 JSON，已改用代码块中的命令。", done: false });
    },
  );
});

describe("model content extraction", () => {
describe("error diagnostics", () => {
  test("redacts api keys from reported text", () => {
    expect(redactSecrets('auth failed for sk-abcdef1234567890')).toBe("auth failed for [redacted-key]");
  });

  test("returns diagnostics only for AiRequestError", () => {
    const diagnostic = { phase: "http" as const, url: "https://example.com/v1/chat/completions", status: 404, model: "gpt-4o", detail: "not found", responseSnippet: "{}", contentSnippet: "" };
    expect(describeAiError(new AiRequestError("boom", diagnostic))).toEqual(diagnostic);
    expect(describeAiError(new Error("boom"))).toBeNull();
    expect(describeAiError("boom")).toBeNull();
  });
});

  test("accepts a plain string", () => {
    expect(extractAiContent('{"command":"pwd"}')).toBe('{"command":"pwd"}');
  });

  test("joins typed content parts", () => {
    expect(extractAiContent([{ type: "text", text: '{"command":' }, { type: "text", text: '"pwd"}' }])).toBe('{"command":"pwd"}');
  });

  test("returns empty for missing content", () => {
    expect(extractAiContent(undefined)).toBe("");
    expect(extractAiContent(null)).toBe("");
    expect(extractAiContent(42)).toBe("");
  });
});
