import { defineAction, z, type ActionsModule, type SpaceDb } from "@hatch/space-sdk";
import { AI_AGENT_REQUEST_TIMEOUT_MS, AI_REQUEST_TIMEOUT_MS, AiEmptyOutputError, AiRequestError, type AiDiagnostic, assertPublicResolution, constantTimeEqual, describeAiError, digestToken, extractAiMessageCommand, parseAiCommandContent, randomToken, requirePublicBaseUrl, sameAiOrigin } from "./aiSecurity";
import { eq, sql } from "drizzle-orm";
import { privileged } from "@space/privileged";
import { assessCommand } from "./commandPolicy";
import * as schema from "./schema";
import { AI_STEP_OUTPUT_MAX_CHARS, SHELL_COMMAND_MAX_CHARS, clipStep } from "./shellExecution";
import { AI_TASK_MAX_STEPS, recordStep, stepsSince } from "./aiTask";

type Db = SpaceDb<typeof schema>;
type Row = typeof schema.workspaceItems.$inferSelect;
type RestartRecord = typeof schema.serviceRestartRecord.$inferSelect;

const SERVICE_STARTED_AT = new Date();
const SERVICE_STARTED_AT_MS = SERVICE_STARTED_AT.getTime();
const SERVICE_INSTANCE_ID = crypto.randomUUID();
let restartRecordPromise: Promise<RestartRecord> | null = null;
let tablesPromise: Promise<void> | null = null;

// The drizzle migrations create these tables; this guard covers a database that
// was restored without migration state. Runs once per process.
function ensureTables(db: Db): Promise<void> {
  tablesPromise ??= (async () => {
    await db.run(sql`CREATE TABLE IF NOT EXISTS service_restart_record (id integer PRIMARY KEY NOT NULL, restart_count integer NOT NULL DEFAULT 0, previous_started_at integer, current_started_at integer NOT NULL, instance_id text NOT NULL, updated_at integer NOT NULL)`);
    await db.run(sql`CREATE TABLE IF NOT EXISTS ai_provider_config (id integer PRIMARY KEY NOT NULL, base_url text NOT NULL, api_key text NOT NULL, model text NOT NULL, updated_at integer NOT NULL)`);
    await db.run(sql`CREATE TABLE IF NOT EXISTS ai_agent_context (id integer PRIMARY KEY NOT NULL, task_id text, root text NOT NULL, path text NOT NULL, pending_command text NOT NULL DEFAULT '', confirm_token text, messages_json text NOT NULL, state_json text, updated_at integer NOT NULL)`);
  })().catch((error: unknown) => {
    tablesPromise = null;
    throw error;
  });
  return tablesPromise;
}

async function loadRestartRecord(db: Db): Promise<RestartRecord> {
  if (restartRecordPromise) return restartRecordPromise;
  restartRecordPromise = (async () => {
    await ensureTables(db);
    await db
      .insert(schema.serviceRestartRecord)
      .values({
        id: 1,
        restartCount: 1,
        previousStartedAt: null,
        currentStartedAt: SERVICE_STARTED_AT,
        instanceId: SERVICE_INSTANCE_ID,
        updatedAt: SERVICE_STARTED_AT,
      })
      .onConflictDoUpdate({
        target: schema.serviceRestartRecord.id,
        set: {
          restartCount: sql`CASE WHEN ${schema.serviceRestartRecord.instanceId} <> ${SERVICE_INSTANCE_ID} THEN ${schema.serviceRestartRecord.restartCount} + 1 ELSE ${schema.serviceRestartRecord.restartCount} END`,
          previousStartedAt: sql`CASE WHEN ${schema.serviceRestartRecord.instanceId} <> ${SERVICE_INSTANCE_ID} THEN ${schema.serviceRestartRecord.currentStartedAt} ELSE ${schema.serviceRestartRecord.previousStartedAt} END`,
          currentStartedAt: sql`CASE WHEN ${schema.serviceRestartRecord.instanceId} <> ${SERVICE_INSTANCE_ID} THEN ${SERVICE_STARTED_AT_MS} ELSE ${schema.serviceRestartRecord.currentStartedAt} END`,
          instanceId: sql`CASE WHEN ${schema.serviceRestartRecord.instanceId} <> ${SERVICE_INSTANCE_ID} THEN ${SERVICE_INSTANCE_ID} ELSE ${schema.serviceRestartRecord.instanceId} END`,
          updatedAt: sql`CASE WHEN ${schema.serviceRestartRecord.instanceId} <> ${SERVICE_INSTANCE_ID} THEN ${SERVICE_STARTED_AT_MS} ELSE ${schema.serviceRestartRecord.updatedAt} END`,
        },
      });
    const [record] = await db.select().from(schema.serviceRestartRecord).where(eq(schema.serviceRestartRecord.id, 1)).limit(1);
    if (!record) throw new Error("restart record unavailable");
    return record;
  })().catch((error: unknown) => {
    restartRecordPromise = null;
    throw error;
  });
  return restartRecordPromise;
}

// Per privileged call: matches the contract's per-file limit (a 12 MB file).
const PRIVATE_MIGRATION_BATCH_CHARS = 16_000_000;

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 32_768, bytes.byteLength)));
  }
  return btoa(binary);
}

async function readAiConfig(db: Db): Promise<typeof schema.aiProviderConfig.$inferSelect | null> {
  await ensureTables(db);
  const [config] = await db.select().from(schema.aiProviderConfig).where(eq(schema.aiProviderConfig.id, 1)).limit(1);
  return config ?? null;
}

function savedKeyFor(config: typeof schema.aiProviderConfig.$inferSelect | null, baseUrl: string): string {
  return config?.apiKey && sameAiOrigin(config.baseUrl, baseUrl) ? config.apiKey : "";
}

function maskApiKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : key ? "已保存" : "";
}

function aiDiagnostic(phase: AiDiagnostic["phase"], url: string, model: string, detail: string, extra?: { status?: number | null; responseSnippet?: string; contentSnippet?: string }): AiDiagnostic {
  return { phase, url, model, detail, status: extra?.status ?? null, responseSnippet: extra?.responseSnippet ?? "", contentSnippet: extra?.contentSnippet ?? "" };
}

async function aiFetch(config: typeof schema.aiProviderConfig.$inferSelect, path: string, init?: RequestInit, timeoutMs = AI_REQUEST_TIMEOUT_MS): Promise<Response> {
  const baseUrl = requirePublicBaseUrl(config.baseUrl);
  const url = `${baseUrl}${path}`;
  await assertPublicResolution(url);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal,
      redirect: "error",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (error) {
    const reason = signal.aborted ? `请求超过 ${timeoutMs / 1000} 秒未响应，已中止` : error instanceof Error ? error.message : "未知网络错误";
    throw new AiRequestError(`模型请求失败：${reason}`, aiDiagnostic("request", url, config.model, reason));
  }
}

type AiTaskMessage = { role: "system" | "user" | "assistant"; content: string };
type AiTaskStep = { command: string; stdout: string; stderr: string; cwd: string; exitCode: number | null; requiresConfirmation: boolean };
type AiTaskState = {
  root: "system" | "workspace" | "build" | "private";
  path: string;
  cwd: string | null;
  runAsRoot: boolean;
  messages: AiTaskMessage[];
  pendingCommand: string;
  pendingTokenHash: string | null;
  pendingAutoRun: boolean;
  emptyRetries: number;
  requestRetries: number;
  // The latest steps and the total run so far (see aiTask.ts).
  steps: AiTaskStep[];
  stepCount: number;
  updatedAt: number;
};
const aiTasks = new Map<string, AiTaskState>();
const AI_TASK_TTL_MS = 30 * 60 * 1000;
const AI_TASK_MAX_TASKS = 100;
const AI_MESSAGE_MAX_CHARS = 120_000;
// Task ids with a runAiTask call in progress. Set before the first await so two
// concurrent calls can never both restore and run the same queued command.
const aiTasksInFlight = new Set<string>();
// In-flight tasks whose context was cleared meanwhile; their call must not write
// the task back when it finishes. An id leaves the set when that call ends.
const clearedAiTasks = new Set<string>();

function pruneAiTasks(): void {
  const now = Date.now();
  for (const [id, task] of aiTasks) {
    if (now - task.updatedAt > AI_TASK_TTL_MS) aiTasks.delete(id);
  }
  while (aiTasks.size > AI_TASK_MAX_TASKS) {
    const oldest = [...aiTasks.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
    if (!oldest) break;
    aiTasks.delete(oldest[0]);
  }
}

function pushAiMessage(state: AiTaskState, message: AiTaskMessage): void {
  state.messages.push(message);
  let total = state.messages.reduce((sum, item) => sum + item.content.length, 0);
  while (total > AI_MESSAGE_MAX_CHARS && state.messages.length > 2) {
    // [0] is the system prompt and [1] the task statement; never trim those.
    const removableIndex = state.messages.findIndex((item, index) => index > 1 && item.role !== "system");
    if (removableIndex < 0) break;
    total -= state.messages[removableIndex]?.content.length ?? 0;
    state.messages.splice(removableIndex, 1);
  }
}

// A finished or failed task (ended) clears the task columns so no page can resume it.
async function persistAiTaskState(db: Db, taskId: string, state: AiTaskState, ended: boolean): Promise<void> {
  if (clearedAiTasks.has(taskId)) return;
  // pending_command is what the page shows behind 确认并执行; a command that will
  // run without confirmation must never appear there.
  const columns = ended
    ? { taskId: null, pendingCommand: "", stateJson: null }
    : { taskId, pendingCommand: state.pendingAutoRun ? "" : state.pendingCommand, stateJson: JSON.stringify(state) };
  await db.insert(schema.aiAgentContext).values({
    id: 1,
    root: state.root,
    path: state.path,
    messagesJson: JSON.stringify({ version: 0, messages: [] }),
    updatedAt: new Date(),
    ...columns,
  }).onConflictDoUpdate({ target: schema.aiAgentContext.id, set: { ...columns, updatedAt: new Date() } });
}

const AI_CONTEXT_STEP = z.object({ command: z.string(), stdout: z.string().max(AI_STEP_OUTPUT_MAX_CHARS), stderr: z.string().max(AI_STEP_OUTPUT_MAX_CHARS), cwd: z.string(), exitCode: z.number().int().nullable(), requiresConfirmation: z.boolean() });
const AI_CONTEXT_MESSAGES = z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(20000), steps: z.array(AI_CONTEXT_STEP).optional(), diagnostic: z.object({ phase: z.string(), url: z.string(), status: z.number().int().nullable(), model: z.string(), detail: z.string(), responseSnippet: z.string(), contentSnippet: z.string() }).nullable().optional() })).max(40);
type AiContextMessages = z.infer<typeof AI_CONTEXT_MESSAGES>;
// stepCount is how many steps the current task already has, so the page shows only
// the steps that come after it.
const aiContextSchema = z.object({ ok: z.boolean(), version: z.number().int(), taskId: z.string().nullable(), root: z.enum(["system", "workspace", "build", "private"]), path: z.string(), pendingCommand: z.string(), stepCount: z.number().int(), messages: AI_CONTEXT_MESSAGES });
type AiContext = z.infer<typeof aiContextSchema>;
const EMPTY_AI_CONTEXT: AiContext = { ok: true, version: 0, taskId: null, root: "workspace", path: "", pendingCommand: "", stepCount: 0, messages: [] };

// messages_json is { version, messages }; rows from before versioning hold a bare
// array. Older rows may also hold step output past today's cap; clip it on read.
function parseTranscript(json: string): { version: number; messages: AiContextMessages } {
  const parsed = JSON.parse(json) as unknown;
  const record = Array.isArray(parsed) ? { version: 0, messages: parsed } : parsed as { version?: unknown; messages?: unknown } | null;
  const raw = Array.isArray(record?.messages) ? record.messages as Array<{ steps?: unknown }> : [];
  const clipped = raw.map((message) => (message && Array.isArray(message.steps) ? { ...message, steps: (message.steps as Array<{ stdout?: unknown; stderr?: unknown }>).map((step) => (typeof step?.stdout === "string" && typeof step.stderr === "string" ? clipStep(step as { stdout: string; stderr: string }) : step)) } : message));
  return { version: typeof record?.version === "number" ? record.version : 0, messages: AI_CONTEXT_MESSAGES.catch([]).parse(clipped) };
}

async function readAiContext(db: Db): Promise<AiContext> {
  const [row] = await db.select().from(schema.aiAgentContext).where(eq(schema.aiAgentContext.id, 1)).limit(1);
  if (!row) return EMPTY_AI_CONTEXT;
  try {
    const transcript = parseTranscript(row.messagesJson);
    let state: Partial<AiTaskState> | null = null;
    try { state = row.stateJson ? JSON.parse(row.stateJson) as Partial<AiTaskState> : null; } catch { /* restoreAiTask handles a bad state */ }
    // Rows written before auto-run commands were kept out of pending_command may still hold one.
    const pendingCommand = state?.pendingAutoRun ? "" : row.pendingCommand;
    const stepCount = typeof state?.stepCount === "number" ? state.stepCount : Array.isArray(state?.steps) ? state.steps.length : 0;
    return { ok: true, version: transcript.version, taskId: row.taskId, root: row.root as AiContext["root"], path: row.path, pendingCommand, stepCount: row.taskId ? stepCount : 0, messages: transcript.messages };
  } catch {
    await db.delete(schema.aiAgentContext).where(eq(schema.aiAgentContext.id, 1));
    return EMPTY_AI_CONTEXT;
  }
}

const AI_BASH_TOOL = { type: "function", function: { name: "bash", description: "Run one bash command in the sandbox. Commands that write, modify, move or delete files or data pause for user confirmation and may be rejected; other commands run automatically. Set done=true with an empty command when the task is complete.", parameters: { type: "object", properties: { command: { type: "string", description: "The bash command to run; empty when the task is done." }, explanation: { type: "string", description: "Short explanation for this step." }, done: { type: "boolean", description: "Whether the task is complete." } }, required: ["command", "explanation", "done"], additionalProperties: false } } };

async function restoreAiTask(db: Db, taskId: string): Promise<AiTaskState | undefined> {
  const [row] = await db.select().from(schema.aiAgentContext).where(eq(schema.aiAgentContext.id, 1)).limit(1);
  if (row?.taskId !== taskId || !row.stateJson) return undefined;
  try {
    const restored = JSON.parse(row.stateJson) as AiTaskState;
    if (!Array.isArray(restored.messages) || !Array.isArray(restored.steps)) return undefined;
    // The token hash is not trusted across restarts; a fresh token is issued on demand.
    const state: AiTaskState = { ...restored, pendingTokenHash: null, emptyRetries: restored.emptyRetries ?? 0, requestRetries: restored.requestRetries ?? 0, steps: restored.steps.slice(-AI_TASK_MAX_STEPS).map(clipStep), stepCount: restored.stepCount ?? restored.steps.length, updatedAt: Date.now() };
    aiTasks.set(taskId, state);
    return state;
  } catch {
    await db.delete(schema.aiAgentContext).where(eq(schema.aiAgentContext.id, 1));
    return undefined;
  }
}

// Network failures, rate limits and server errors are worth retrying; a bad key,
// a wrong model or unparseable output is not.
function isTransientAiError(error: unknown): boolean {
  if (error instanceof AiEmptyOutputError) return true;
  if (!(error instanceof AiRequestError)) return false;
  const { phase, status } = error.diagnostic;
  return phase === "request" || (phase === "http" && status !== null && (status === 429 || status >= 500));
}

async function requestNextAiCommand(config: typeof schema.aiProviderConfig.$inferSelect, messages: AiTaskMessage[], timeoutMs: number, includeTools = true): Promise<{ command: string; explanation: string; done: boolean }> {
  // Retries drop the tool declaration so models whose proxy mangles tool arguments
  // are pushed back onto the plain JSON text path.
  const payload: Record<string, unknown> = { model: config.model, temperature: 0.1, messages };
  if (includeTools) payload.tools = [AI_BASH_TOOL];
  const response = await aiFetch(config, "/chat/completions", { method: "POST", body: JSON.stringify(payload) }, timeoutMs);
  const raw = await response.text();
  const requestUrl = requirePublicBaseUrl(config.baseUrl) + "/chat/completions";
  if (!response.ok) {
    const snippet = raw.slice(0, 800);
    throw new AiRequestError(`模型接口返回 HTTP ${response.status}`, aiDiagnostic("http", requestUrl, config.model, `服务端拒绝了这次对话请求（HTTP ${response.status}）。常见原因：模型名不可用、该模型不支持对话接口、余额或额度不足、API Key 没有该模型权限。`, { status: response.status, responseSnippet: snippet }));
  }
  let body: { choices?: Array<{ message?: unknown }> };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new AiRequestError("模型接口返回的不是合法 JSON", aiDiagnostic("response-json", requestUrl, config.model, "接口返回了非 JSON 内容，可能是中转站错误页或网关拦截页。", { status: response.status, responseSnippet: raw.slice(0, 800) }));
  }
  const messageCommand = extractAiMessageCommand(body.choices?.[0]?.message);
  let content = messageCommand?.text ?? "";
  if (messageCommand && messageCommand.source !== "content" && content) {
    try { JSON.parse(content); } catch { content = JSON.stringify({ command: content, explanation: "Tool call returned a raw command.", done: false }); }
  }
  if (content.trim() === "{}") {
    throw new AiEmptyOutputError("模型工具调用没有提供参数", aiDiagnostic("model-json", requestUrl, config.model, `模型调用了 ${messageCommand?.toolName || "工具"}，但 arguments 是空对象，没有 command 字段。`, { status: response.status, responseSnippet: raw.slice(0, 800), contentSnippet: content.slice(0, 800) }));
  }
  if (!content) {
    throw new AiEmptyOutputError("模型没有返回内容", aiDiagnostic("model-json", requestUrl, config.model, "接口调用成功，但 choices[0].message.content 为空。可能是模型名不对、被内容策略拦截，或返回了非标准的流式结构。", { status: response.status, responseSnippet: raw.slice(0, 800) }));
  }
  try {
    const parsed = parseAiCommandContent(content);
    if (!parsed.command && !parsed.done) {
      throw new AiEmptyOutputError("模型没有返回可执行命令", aiDiagnostic("model-json", requestUrl, config.model, "模型返回了 JSON，但 command 为空且 done=false。", { status: response.status, responseSnippet: raw.slice(0, 800), contentSnippet: content.slice(0, 800) }));
    }
    return parsed;
  } catch (error) {
    if (error instanceof AiEmptyOutputError) throw error;
    throw new AiRequestError(error instanceof Error ? error.message : "模型输出无法解析", aiDiagnostic("model-json", requestUrl, config.model, "模型没有按要求返回 JSON，也无法从代码块中提取命令。可以在模型配置里换一个指令遵循能力更强的模型。", { status: response.status, responseSnippet: raw.slice(0, 800), contentSnippet: content.slice(0, 800) }));
  }
}

export const Actions = {
  migratePrivateWorkspace: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean(), message: z.string(), migrated: z.boolean(), done: z.boolean(), path: z.string() }),
    privileged: [privileged.materializePrivateWorkspace],
    async handler(ctx) {
      const status = await ctx.executePrivileged(privileged.materializePrivateWorkspace, { entries: [], final: false });
      // Done once (marker on disk): never read the legacy rows or blobs again.
      if (!status.ok || status.done) return status;
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.workspaceItems);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const pathFor = (row: Row): string | null => {
        const parts = [row.name];
        let parentId = row.parentId;
        const seen = new Set<number>([row.id]);
        while (parentId !== null) {
          if (seen.has(parentId)) return null;
          seen.add(parentId);
          const parent = byId.get(parentId);
          if (!parent || parent.kind !== "folder") return null;
          parts.unshift(parent.name);
          parentId = parent.parentId;
        }
        return parts.join("/");
      };
      const failed = (message: string) => ({ ok: false, message, migrated: false, done: false, path: status.path });
      const items: Array<{ row: Row; path: string }> = [];
      for (const row of rows) {
        const path = pathFor(row);
        if (!path) return failed("旧私有数据包含无效层级，迁移已停止且未删除旧数据。");
        items.push({ row, path });
      }
      // Folders first, then files, sent in batches that stay under the contract
      // limits. Files already on disk are skipped, so an interrupted run resumes.
      items.sort((a, b) => Number(a.row.kind === "file") - Number(b.row.kind === "file"));
      let batch: Array<{ path: string; kind: "folder" | "file"; dataBase64: string | null }> = [];
      let batchChars = 0;
      for (const { row, path } of items) {
        let dataBase64: string | null = null;
        if (row.kind === "file") {
          if (!row.blobKey) return failed(`旧文件“${row.name}”缺少内容，迁移已停止且未删除旧数据。`);
          const url = await ctx.blobs.getUrl(row.blobKey, { expiresInSeconds: 120 });
          const response = await fetch(url);
          if (!response.ok) return failed(`旧文件“${row.name}”读取失败，迁移已停止且未删除旧数据。`);
          dataBase64 = encodeBase64(new Uint8Array(await response.arrayBuffer()));
          if (dataBase64.length > PRIVATE_MIGRATION_BATCH_CHARS) return failed(`旧文件“${row.name}”超过 12 MB，无法迁移；旧数据仍保留。`);
        }
        if (batch.length && (batch.length >= 1000 || batchChars + (dataBase64?.length ?? 0) > PRIVATE_MIGRATION_BATCH_CHARS)) {
          const result = await ctx.executePrivileged(privileged.materializePrivateWorkspace, { entries: batch, final: false });
          if (!result.ok) return result;
          batch = [];
          batchChars = 0;
        }
        batch.push({ path, kind: row.kind, dataBase64 });
        batchChars += dataBase64?.length ?? 0;
      }
      const result = await ctx.executePrivileged(privileged.materializePrivateWorkspace, { entries: batch, final: true });
      return result.ok ? { ...result, migrated: items.length > 0, message: items.length ? `已把 ${items.length} 个原有项目迁移到真实目录。` : result.message } : result;
    },
  }),

  listHostDirectory: defineAction({
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), showSensitive: z.boolean().default(false) }),
    response: z.object({
      ok: z.boolean(), message: z.string(), root: z.enum(["system", "workspace", "build", "private"]), path: z.string(), absolutePath: z.string(), locationLabel: z.string(),
      entries: z.array(z.object({ name: z.string(), path: z.string(), kind: z.enum(["folder", "file", "link"]), targetKind: z.enum(["folder", "file", "other", "broken"]).nullable(), size: z.number(), modifiedAt: z.string(), writable: z.boolean(), removable: z.boolean() })),
      breadcrumbs: z.array(z.object({ name: z.string(), path: z.string() })), truncated: z.boolean(), writable: z.boolean(), userIdentity: z.string(),
    }),
    privileged: [privileged.listHostDirectory],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.listHostDirectory, args); },
  }),

  listHostImages: defineAction({
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), showSensitive: z.boolean().default(false) }),
    response: z.object({
      ok: z.boolean(), message: z.string(),
      entries: z.array(z.object({ name: z.string(), path: z.string(), kind: z.enum(["folder", "file", "link"]), targetKind: z.enum(["folder", "file", "other", "broken"]).nullable(), size: z.number(), modifiedAt: z.string(), writable: z.boolean(), removable: z.boolean() })),
    }),
    privileged: [privileged.listHostImages],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.listHostImages, args); },
  }),

  readHostFileChunk: defineAction({
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), offset: z.number().int().min(0), limit: z.number().int().min(1024).max(524288), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), name: z.string().nullable(), mode: z.enum(["text", "hex"]).nullable(), content: z.string().nullable(), offset: z.number().int(), nextOffset: z.number().int(), totalSize: z.number().int(), eof: z.boolean(), editable: z.boolean(), writable: z.boolean() }),
    privileged: [privileged.readHostFileChunk],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.readHostFileChunk, args); },
  }),

  readHostDownloadChunk: defineAction({
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), offset: z.number().int().min(0), limit: z.number().int().min(1024).max(524288), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), name: z.string().nullable(), dataBase64: z.string().nullable(), nextOffset: z.number().int(), totalSize: z.number().int(), eof: z.boolean() }),
    privileged: [privileged.readHostDownloadChunk],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.readHostDownloadChunk, args); },
  }),

  getHostImagePreview: defineAction({
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), name: z.string().nullable(), mimeType: z.string().nullable(), dataBase64: z.string().nullable(), size: z.number().int(), tooLarge: z.boolean() }),
    privileged: [privileged.getHostImagePreview],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.getHostImagePreview, args); },
  }),

  writeHostTextFile: defineAction({
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), content: z.string().max(8_000_000), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    privileged: [privileged.writeHostTextFile],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.writeHostTextFile, args); },
  }),

  createHostFile: defineAction({
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), directory: z.string().max(2000), name: z.string().max(255), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), path: z.string().nullable() }),
    privileged: [privileged.createHostFile],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.createHostFile, args); },
  }),

  createHostDirectory: defineAction({
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), directory: z.string().max(2000), name: z.string().max(255), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), path: z.string().nullable() }),
    privileged: [privileged.createHostDirectory],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.createHostDirectory, args); },
  }),

  deleteHostEntry: defineAction({
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    privileged: [privileged.deleteHostEntry],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.deleteHostEntry, args); },
  }),

  moveHostEntry: defineAction({
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), targetDirectory: z.string().max(2000), newName: z.string().max(255), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), path: z.string().nullable() }),
    privileged: [privileged.moveHostEntry],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.moveHostEntry, args); },
  }),

  uploadHostFile: defineAction({
    request: z.object({ root: z.enum(["system", "workspace", "build", "private"]), directory: z.string().max(2000), name: z.string().max(255), dataBase64: z.string().max(16_000_000), showSensitive: z.boolean().default(false) }),
    response: z.object({ ok: z.boolean(), message: z.string(), path: z.string().nullable() }),
    privileged: [privileged.uploadHostFile],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.uploadHostFile, args); },
  }),

  getAiProviderConfig: defineAction({
    request: z.object({}),
    response: z.object({ configured: z.boolean(), baseUrl: z.string(), model: z.string(), hasApiKey: z.boolean(), apiKeyHint: z.string(), updatedAt: z.string().nullable() }),
    async handler(ctx) {
      // The key itself never leaves the server; the page only gets a masked hint.
      const config = await readAiConfig(ctx.db<typeof schema>());
      return { configured: Boolean(config), baseUrl: config?.baseUrl ?? "https://api.openai.com", model: config?.model ?? "", hasApiKey: Boolean(config?.apiKey), apiKeyHint: maskApiKey(config?.apiKey ?? ""), updatedAt: config?.updatedAt.toISOString() ?? null };
    },
  }),

  getAiContext: defineAction({
    request: z.object({}),
    response: aiContextSchema,
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      await ensureTables(db);
      return readAiContext(db);
    },
  }),

  // The page owns only the chat transcript and the working location. Task id,
  // pending command and task state belong to runAiTask; a page never writes them,
  // so a stale page cannot resurrect a finished task or hide a pending command.
  saveAiContext: defineAction({
    request: z.object({ version: z.number().int().min(0), root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), messages: AI_CONTEXT_MESSAGES }),
    response: z.object({ ok: z.boolean(), version: z.number().int(), context: aiContextSchema.nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureTables(db);
      const [row] = await db.select().from(schema.aiAgentContext).where(eq(schema.aiAgentContext.id, 1)).limit(1);
      let current = 0;
      try { current = row ? parseTranscript(row.messagesJson).version : 0; } catch { /* an unreadable transcript is replaced */ }
      // Another page (another device) saved since this page last loaded: hand it the
      // newer context instead of overwriting it.
      if (args.version !== current) return { ok: false, version: current, context: await readAiContext(db) };
      const version = current + 1;
      const messagesJson = JSON.stringify({ version, messages: args.messages });
      if (!row) {
        if (!args.messages.length) return { ok: true, version: current, context: null };
        await db.insert(schema.aiAgentContext).values({ id: 1, taskId: null, root: args.root, path: args.path, pendingCommand: "", messagesJson, updatedAt: new Date() }).onConflictDoNothing();
      } else {
        await db.update(schema.aiAgentContext).set({ root: args.root, path: args.path, messagesJson, updatedAt: new Date() }).where(eq(schema.aiAgentContext.id, 1));
      }
      return { ok: true, version, context: null };
    },
  }),

  clearAiContext: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      await ensureTables(db);
      const [row] = await db.select({ taskId: schema.aiAgentContext.taskId }).from(schema.aiAgentContext).where(eq(schema.aiAgentContext.id, 1)).limit(1);
      if (row?.taskId) aiTasks.delete(row.taskId);
      // There is one shared context, so every task still running belongs to it.
      for (const taskId of aiTasksInFlight) {
        clearedAiTasks.add(taskId);
        aiTasks.delete(taskId);
      }
      await db.delete(schema.aiAgentContext).where(eq(schema.aiAgentContext.id, 1));
      return { ok: true };
    },
  }),

  saveAiProviderConfig: defineAction({
    request: z.object({ baseUrl: z.string().url().max(500), apiKey: z.string().max(500), model: z.string().min(1).max(200) }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      let baseUrl: string;
      try { baseUrl = requirePublicBaseUrl(args.baseUrl); } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "模型地址无效。" };
      }
      const db = ctx.db<typeof schema>();
      // An empty key keeps the saved one, since the page never receives it.
      const apiKey = args.apiKey.trim() || savedKeyFor(await readAiConfig(db), baseUrl);
      if (!apiKey) return { ok: false, message: "请填写 API Key（更换了 API 地址时需要重新填写）。" };
      const now = new Date();
      await db.insert(schema.aiProviderConfig).values({ id: 1, baseUrl, apiKey, model: args.model, updatedAt: now }).onConflictDoUpdate({ target: schema.aiProviderConfig.id, set: { baseUrl, apiKey, model: args.model, updatedAt: now } });
      return { ok: true, message: "AI 配置已保存到服务器。" };
    },
  }),

  listAiModels: defineAction({
    request: z.object({ baseUrl: z.string().url().max(500), apiKey: z.string().max(500) }),
    response: z.object({ ok: z.boolean(), message: z.string(), models: z.array(z.string()) }),
    async handler(ctx, args) {
      let baseUrl: string;
      try {
        baseUrl = requirePublicBaseUrl(args.baseUrl);
        await assertPublicResolution(baseUrl);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "模型地址无效。", models: [] };
      }
      const apiKey = args.apiKey.trim() || savedKeyFor(await readAiConfig(ctx.db<typeof schema>()), baseUrl);
      if (!apiKey) return { ok: false, message: "请填写 API Key（更换了 API 地址时需要重新填写）。", models: [] };
      const signal = AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal, redirect: "error" });
        const raw = await response.text();
        if (!response.ok) return { ok: false, message: `模型列表读取失败（HTTP ${response.status}）：${raw.slice(0, 300)}`, models: [] };
        let body: { data?: Array<{ id?: string }> };
        try { body = JSON.parse(raw) as typeof body; } catch { return { ok: false, message: `模型列表接口返回的不是 JSON：${raw.slice(0, 300)}`, models: [] }; }
        const models = (body.data ?? []).map((item) => item.id ?? "").filter(Boolean).sort();
        return { ok: true, message: `已读取 ${models.length} 个模型。`, models };
      } catch (error) {
        return { ok: false, message: signal.aborted ? `模型接口超过 ${AI_REQUEST_TIMEOUT_MS / 1000} 秒未响应，已中止。` : `无法连接模型服务：${error instanceof Error ? error.message : "未知错误"}`, models: [] };
      }
    },
  }),

  runAiTask: defineAction({
    // knownSteps: how many of this task's steps the page already has; only later
    // steps come back, and stepCount is the new total.
    request: z.object({ taskId: z.string().uuid().nullable(), prompt: z.string().max(4000).default(""), reject: z.boolean().default(false), root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), confirmToken: z.string().max(128).nullable().default(null), knownSteps: z.number().int().min(0).default(0) }),
    response: z.object({ ok: z.boolean(), taskId: z.string(), status: z.enum(["running", "waiting_confirmation", "completed", "failed"]), message: z.string(), steps: z.array(AI_CONTEXT_STEP), stepCount: z.number().int(), pendingCommand: z.string().nullable(), confirmToken: z.string().nullable(), diagnostic: z.object({ phase: z.string(), url: z.string(), status: z.number().int().nullable(), model: z.string(), detail: z.string(), responseSnippet: z.string(), contentSnippet: z.string() }).nullable() }),
    privileged: [privileged.executeShell],
    async handler(ctx, args) {
      // One call performs at most one model turn or one command. A multi-step
      // agent loop inside a single request would exceed the platform gateway
      // timeout ("Gateway request timed out"), so the client re-invokes this action
      // with the same taskId until the task completes.
      pruneAiTasks();
      const taskId = args.taskId ?? crypto.randomUUID();
      let state: AiTaskState | undefined = aiTasks.get(taskId);
      type Status = "running" | "waiting_confirmation" | "completed" | "failed";
      const reply = (status: Status, message: string, extra: { pendingCommand?: string | null; confirmToken?: string | null; diagnostic?: AiDiagnostic | null; ok?: boolean } = {}) => ({ ok: extra.ok ?? status !== "failed", taskId, status, message, steps: state ? stepsSince(state, args.knownSteps) : [], stepCount: state?.stepCount ?? args.knownSteps, pendingCommand: extra.pendingCommand ?? null, confirmToken: extra.confirmToken ?? null, diagnostic: extra.diagnostic ?? null });
      if (aiTasksInFlight.has(taskId)) return reply("running", "任务正在执行，请等待当前步骤完成。", { ok: false, pendingCommand: state?.pendingCommand || null });
      aiTasksInFlight.add(taskId);
      const db = ctx.db<typeof schema>();
      try {
        const config = await readAiConfig(db);
        if (!config) return reply("failed", "请先配置 AI 服务。");
        const prompt = args.prompt.trim();
        if (!state && args.taskId) state = await restoreAiTask(db, args.taskId);
        if (!state) {
          if (args.taskId) return reply("failed", "任务不存在或已过期，请重新发起。");
          if (!prompt) return reply("failed", "请先描述要完成的任务。");
          state = { root: args.root, path: args.path, cwd: null, runAsRoot: true, pendingCommand: "", pendingTokenHash: null, pendingAutoRun: false, emptyRetries: 0, requestRetries: 0, steps: [], stepCount: 0, updatedAt: Date.now(), messages: [{ role: "system", content: "你是一个沙盒终端 Agent，拥有 root 权限。每次只返回 JSON：{command:string, explanation:string, done:boolean}。一次只生成一条 bash 命令。会写入、修改、移动或删除文件和数据的命令会暂停等待用户确认，用户可能拒绝；其他命令自动执行。任务完成时 command 为空且 done=true。只输出 JSON，不要 Markdown。" }, { role: "user", content: `任务：${prompt}\n根类型：${args.root}\n相对路径：${args.path || "/"}` }] };
          aiTasks.set(taskId, state);
          pruneAiTasks();
        } else if (args.reject || prompt) {
          // A rejection, or a message typed while a command waits for confirmation,
          // replaces that command with the user's feedback. A queued auto-run command
          // was never shown to the user, so it stays queued and is not "rejected".
          if (state.pendingCommand && !state.pendingAutoRun) {
            pushAiMessage(state, { role: "user", content: `用户拒绝执行命令：${state.pendingCommand}${prompt ? "" : "\n请换一种不需要该操作的方式继续，或在无法继续时结束任务。"}` });
            state.pendingCommand = "";
            state.pendingTokenHash = null;
            state.pendingAutoRun = false;
          }
          if (prompt) pushAiMessage(state, { role: "user", content: `用户补充要求：${prompt}` });
        }
        const task = state;
        task.updatedAt = Date.now();
        try {
          // Each call does exactly one thing: run the queued command, or ask the model
          // for the next one. Keeping the two apart caps a request at the model timeout
          // or the shell timeout instead of their sum.
          if (task.pendingCommand) {
            const isAutoRun = task.pendingAutoRun;
            if (!isAutoRun) {
              const confirmed = Boolean(args.confirmToken && task.pendingTokenHash && constantTimeEqual(digestToken(args.confirmToken), task.pendingTokenHash));
              if (!confirmed) {
                // A fresh single-use token for the current pending command; any earlier token stops working.
                const token = randomToken();
                task.pendingTokenHash = digestToken(token);
                return reply("waiting_confirmation", "这一步需要用户确认后才能执行。", { pendingCommand: task.pendingCommand, confirmToken: token });
              }
            }
            const queuedCommand = task.pendingCommand;
            task.pendingCommand = "";
            task.pendingTokenHash = null;
            task.pendingAutoRun = false;
            pushAiMessage(task, { role: "user", content: isAutoRun ? `执行命令：${queuedCommand}` : `用户已确认执行待执行命令：${queuedCommand}` });
            const result = await ctx.executePrivileged(privileged.executeShell, { command: queuedCommand, root: task.root, path: task.path, cwd: task.cwd, runAsRoot: task.runAsRoot });
            task.cwd = result.cwd;
            const step = recordStep(task, { command: queuedCommand, stdout: result.stdout, stderr: result.stderr, cwd: result.cwd, exitCode: result.exitCode, requiresConfirmation: !isAutoRun });
            pushAiMessage(task, { role: "user", content: `命令：${queuedCommand}\n退出码：${result.exitCode ?? "未知"}\nstdout：${step.stdout}\nstderr：${step.stderr}` });
            if (result.exitCode !== 0) pushAiMessage(task, { role: "user", content: "这条命令执行失败。请分析终端错误，自动修正命令并继续任务，不要等待用户重复提交。" });
            return reply("running", "命令已执行，继续下一步。");
          }
          let next: { command: string; explanation: string; done: boolean };
          try {
            next = await requestNextAiCommand(config, task.messages, AI_AGENT_REQUEST_TIMEOUT_MS, task.emptyRetries === 0);
          } catch (error) {
            if (task.requestRetries < 2 && isTransientAiError(error)) {
              task.requestRetries += 1;
              if (error instanceof AiEmptyOutputError) {
                // Only the model saw an empty answer, so only then does it get a correction.
                task.emptyRetries += 1;
                pushAiMessage(task, { role: "user", content: "上一次回复没有可执行内容。请只输出一个 JSON 对象：{\"command\":\"...\",\"explanation\":\"...\",\"done\":false}，不要使用工具调用，不要留空参数。" });
              }
              return reply("running", `模型请求失败，已自动重试（${task.requestRetries}/2）。`);
            }
            throw error;
          }
          task.requestRetries = 0;
          task.emptyRetries = 0;
          if (next.done && !next.command) { aiTasks.delete(taskId); return reply("completed", next.explanation || "任务已完成。"); }
          if (!next.command) throw new Error("模型没有返回可执行命令，且未标记任务完成。");
          if (next.command.length > SHELL_COMMAND_MAX_CHARS) {
            // The shell contract would reject it after the user confirmed it; ask for
            // shorter commands instead of queueing one that can never run.
            pushAiMessage(task, { role: "assistant", content: JSON.stringify({ command: `${next.command.slice(0, 200)}…`, explanation: next.explanation, done: false }) });
            pushAiMessage(task, { role: "user", content: `上一条命令有 ${next.command.length} 个字符，超过单条命令 ${SHELL_COMMAND_MAX_CHARS} 字符的上限，没有执行。请拆成多条较短的命令，写大文件时分段追加写入。` });
            return reply("running", `模型给出的命令超过 ${SHELL_COMMAND_MAX_CHARS} 字符，已要求拆分后重试。`);
          }
          // done=true with a command: run the command first rather than dropping it.
          const assessment = assessCommand(next.command);
          pushAiMessage(task, { role: "assistant", content: JSON.stringify({ ...next, done: false }) });
          task.pendingCommand = next.command;
          if (assessment.requiresConfirmation) {
            const token = randomToken();
            task.pendingTokenHash = digestToken(token);
            task.pendingAutoRun = false;
            return reply("waiting_confirmation", next.explanation ? `${next.explanation}（需要确认：${assessment.reason}）` : `这一步需要确认：${assessment.reason}`, { pendingCommand: next.command, confirmToken: token });
          }
          task.pendingTokenHash = null;
          task.pendingAutoRun = true;
          return reply("running", next.explanation || "准备执行命令。", { pendingCommand: next.command });
        } catch (error) {
          aiTasks.delete(taskId);
          return reply("failed", `AI Agent 执行失败：${error instanceof Error ? error.message : "未知错误"}`, { diagnostic: describeAiError(error) });
        } finally {
          task.updatedAt = Date.now();
          await persistAiTaskState(db, taskId, task, !aiTasks.has(taskId));
        }
      } finally {
        aiTasksInFlight.delete(taskId);
        // A call that restored or created the task after the clear must not leave it in memory either.
        if (clearedAiTasks.delete(taskId)) aiTasks.delete(taskId);
      }
    },
  }),

  executeShell: defineAction({
    request: z.object({ command: z.string().min(1).max(SHELL_COMMAND_MAX_CHARS), root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), cwd: z.string().max(2000).nullable().default(null) }),
    response: z.object({ ok: z.boolean(), stdout: z.string(), stderr: z.string(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), cwd: z.string(), durationMs: z.number().int() }),
    privileged: [privileged.executeShell],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.executeShell, args); },
  }),

  getSystemSnapshot: defineAction({
    request: z.object({}),
    response: z.object({
      sampledAt: z.string(), platform: z.string(), hostname: z.string(), kernelVersion: z.string(), uptimeSec: z.number(), serviceUptimeSec: z.number(), bootedAt: z.string(), serviceStartedAt: z.string(), serviceRestartCount: z.number().int().positive(), previousServiceStartedAt: z.string().nullable(), cpuPercent: z.number(), cpuCores: z.array(z.object({ name: z.string(), percent: z.number() })), loadAverage: z.array(z.number()).length(3),
      memory: z.object({ total: z.number(), used: z.number(), cached: z.number(), buffers: z.number(), available: z.number(), percent: z.number() }),
      mounts: z.array(z.object({ path: z.string(), total: z.number(), used: z.number(), available: z.number(), percent: z.number() })),
      disks: z.array(z.object({ name: z.string(), readPerSec: z.number(), writePerSec: z.number() })),
      network: z.object({ rxPerSec: z.number(), txPerSec: z.number(), interfaces: z.array(z.object({ name: z.string(), rxPerSec: z.number(), txPerSec: z.number() })) }),
      processCount: z.number().int(),
      processesByCpu: z.array(z.object({ pid: z.number().int(), name: z.string(), cpuPercent: z.number(), memoryBytes: z.number(), status: z.string() })),
      processesByMemory: z.array(z.object({ pid: z.number().int(), name: z.string(), cpuPercent: z.number(), memoryBytes: z.number(), status: z.string() })),
    }),
    privileged: [privileged.readSystemSnapshot],
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const record = await loadRestartRecord(db);
      const snapshot = await ctx.executePrivileged(privileged.readSystemSnapshot, {});
      return {
        ...snapshot,
        serviceUptimeSec: Math.max(0, (Date.now() - record.currentStartedAt.getTime()) / 1000),
        serviceStartedAt: record.currentStartedAt.toISOString(),
        serviceRestartCount: record.restartCount,
        previousServiceStartedAt: record.previousStartedAt?.toISOString() ?? null,
      };
    },
  }),

  scanHomeDirectories: defineAction({
    request: z.object({ offset: z.number().int().min(0) }),
    response: z.object({ ok: z.boolean(), message: z.string(), item: z.object({ name: z.string(), path: z.string(), size: z.number(), timedOut: z.boolean() }).nullable(), nextOffset: z.number().int(), total: z.number().int(), done: z.boolean() }),
    privileged: [privileged.scanHomeDirectories],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.scanHomeDirectories, args); },
  }),
} satisfies ActionsModule;
