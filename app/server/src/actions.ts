import { defineAction, z, type ActionsModule, type SpaceDb } from "@hatch/space-sdk";
import { AI_AGENT_REQUEST_TIMEOUT_MS, AI_REQUEST_TIMEOUT_MS, AiRequestError, type AiDiagnostic, constantTimeEqual, describeAiError, digestToken, extractAiMessageCommand, parseAiCommandContent, randomToken, requirePublicBaseUrl } from "./aiSecurity";
import { and, eq, sql } from "drizzle-orm";
import { privileged } from "@space/privileged";
import { assessCommand } from "./commandPolicy";
import * as schema from "./schema";

type Db = SpaceDb<typeof schema>;
type Row = typeof schema.workspaceItems.$inferSelect;
type RestartRecord = typeof schema.serviceRestartRecord.$inferSelect;

const SERVICE_STARTED_AT = new Date();
const SERVICE_STARTED_AT_MS = SERVICE_STARTED_AT.getTime();
const SERVICE_INSTANCE_ID = crypto.randomUUID();
let restartRecordPromise: Promise<RestartRecord> | null = null;

async function loadRestartRecord(db: Db): Promise<RestartRecord> {
  if (restartRecordPromise) return restartRecordPromise;
  restartRecordPromise = (async () => {
    // The migration normally creates this table. Keeping the guard here makes
    // startup self-healing if the database is restored without migration state.
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS service_restart_record (
        id integer PRIMARY KEY NOT NULL,
        restart_count integer NOT NULL DEFAULT 0,
        previous_started_at integer,
        current_started_at integer NOT NULL,
        instance_id text NOT NULL,
        updated_at integer NOT NULL
      )
    `);
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

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 32_768, bytes.byteLength)));
  }
  return btoa(binary);
}

async function readAiConfig(db: Db): Promise<typeof schema.aiProviderConfig.$inferSelect | null> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS ai_provider_config (
      id integer PRIMARY KEY NOT NULL,
      base_url text NOT NULL,
      api_key text NOT NULL,
      model text NOT NULL,
      updated_at integer NOT NULL
    )
  `);
  const [config] = await db.select().from(schema.aiProviderConfig).where(eq(schema.aiProviderConfig.id, 1)).limit(1);
  return config ?? null;
}

function aiDiagnostic(phase: AiDiagnostic["phase"], url: string, model: string, detail: string, extra?: { status?: number | null; responseSnippet?: string; contentSnippet?: string }): AiDiagnostic {
  return { phase, url, model, detail, status: extra?.status ?? null, responseSnippet: extra?.responseSnippet ?? "", contentSnippet: extra?.contentSnippet ?? "" };
}

async function aiFetch(config: typeof schema.aiProviderConfig.$inferSelect, path: string, init?: RequestInit, timeoutMs = AI_REQUEST_TIMEOUT_MS): Promise<Response> {
  const baseUrl = requirePublicBaseUrl(config.baseUrl);
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "error",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (error) {
    const reason = controller.signal.aborted ? `请求超过 ${timeoutMs / 1000} 秒未响应，已中止` : error instanceof Error ? error.message : "未知网络错误";
    throw new AiRequestError(`模型请求失败：${reason}`, aiDiagnostic("request", url, config.model, reason));
  } finally {
    clearTimeout(timer);
  }
}

type AiTaskMessage = { role: "system" | "user" | "assistant"; content: string };
type AiTaskStep = { command: string; stdout: string; stderr: string; cwd: string; exitCode: number | null; requiresConfirmation: boolean };
type AiTaskState = {
  configId: number;
  owner: string;
  root: "system" | "workspace" | "build" | "private";
  path: string;
  cwd: string | null;
  runAsRoot: boolean;
  messages: AiTaskMessage[];
  pendingCommand: string;
  pendingTokenHash: string | null;
  pendingAutoRun: boolean;
  steps: AiTaskStep[];
  busy: boolean;
  updatedAt: number;
};
const aiTasks = new Map<string, AiTaskState>();
const AI_TASK_TTL_MS = 30 * 60 * 1000;
const AI_TASK_MAX_TASKS = 100;
const AI_MESSAGE_MAX_CHARS = 120_000;


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
    const removableIndex = state.messages.findIndex((item, index) => index > 0 && item.role !== "system");
    if (removableIndex < 0) break;
    total -= state.messages[removableIndex]?.content.length ?? 0;
    state.messages.splice(removableIndex, 1);
  }
}

async function requestNextAiCommand(config: typeof schema.aiProviderConfig.$inferSelect, messages: AiTaskMessage[], timeoutMs: number): Promise<{ command: string; explanation: string; done: boolean }> {
  const response = await aiFetch(config, "/chat/completions", { method: "POST", body: JSON.stringify({ model: config.model, temperature: 0.1, messages, tools: [{ type: "function", function: { name: "bash", description: "Run one bash command in the sandbox. Read-only commands run automatically; mutating, deleting, moving, installing or permission-changing commands pause for user confirmation. Set done=true with an empty command when the task is complete.", parameters: { type: "object", properties: { command: { type: "string", description: "The bash command to run; empty when the task is done." }, explanation: { type: "string", description: "Short explanation for this step." }, done: { type: "boolean", description: "Whether the task is complete." } }, required: ["command", "explanation", "done"], additionalProperties: false } } }] }) }, timeoutMs);
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
    throw new AiRequestError("模型工具调用没有提供参数", aiDiagnostic("model-json", requestUrl, config.model, `模型调用了 ${messageCommand?.toolName || "工具"}，但 arguments 是空对象，没有 command 字段。`, { status: response.status, responseSnippet: raw.slice(0, 800), contentSnippet: content.slice(0, 800) }));
  }
  if (!content) {
    throw new AiRequestError("模型没有返回内容", aiDiagnostic("model-json", requestUrl, config.model, "接口调用成功，但 choices[0].message.content 为空。可能是模型名不对、被内容策略拦截，或返回了非标准的流式结构。", { status: response.status, responseSnippet: raw.slice(0, 800) }));
  }
  try {
    return parseAiCommandContent(content);
  } catch (error) {
    throw new AiRequestError(error instanceof Error ? error.message : "模型输出无法解析", aiDiagnostic("model-json", requestUrl, config.model, "模型没有按要求返回 JSON，也无法从代码块中提取命令。可以在模型配置里换一个指令遵循能力更强的模型。", { status: response.status, responseSnippet: raw.slice(0, 800), contentSnippet: content.slice(0, 800) }));
  }
}

export const Actions = {
  getFileAccess: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.boolean(), message: z.string(), url: z.string().nullable(), name: z.string().nullable(), mimeType: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [item] = await db.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, args.id), eq(schema.workspaceItems.kind, "file"))).limit(1);
      if (!item?.blobKey) return { ok: false, message: "文件内容不可用。", url: null, name: null, mimeType: null };
      const url = await ctx.blobs.getUrl(item.blobKey, { expiresInSeconds: 600 });
      return { ok: true, message: "文件已准备好。", url, name: item.name, mimeType: item.mimeType };
    },
  }),

  migratePrivateWorkspace: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean(), message: z.string(), migrated: z.boolean(), path: z.string() }),
    privileged: [privileged.materializePrivateWorkspace],
    async handler(ctx) {
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
      const entries: Array<{ path: string; kind: "folder" | "file"; dataBase64: string | null }> = [];
      for (const row of rows) {
        const path = pathFor(row);
        if (!path) return { ok: false, message: "旧私有数据包含无效层级，迁移已停止且未删除旧数据。", migrated: false, path: "" };
        let dataBase64: string | null = null;
        if (row.kind === "file") {
          if (!row.blobKey) return { ok: false, message: `旧文件“${row.name}”缺少内容，迁移已停止且未删除旧数据。`, migrated: false, path: "" };
          const url = await ctx.blobs.getUrl(row.blobKey, { expiresInSeconds: 120 });
          const response = await fetch(url);
          if (!response.ok) return { ok: false, message: `旧文件“${row.name}”读取失败，迁移已停止且未删除旧数据。`, migrated: false, path: "" };
          dataBase64 = encodeBase64(new Uint8Array(await response.arrayBuffer()));
        }
        entries.push({ path, kind: row.kind, dataBase64 });
      }
      return ctx.executePrivileged(privileged.materializePrivateWorkspace, { entries });
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
    response: z.object({ configured: z.boolean(), baseUrl: z.string(), model: z.string(), apiKey: z.string(), updatedAt: z.string().nullable() }),
    async handler(ctx) {
      const config = await readAiConfig(ctx.db<typeof schema>());
      return { configured: Boolean(config), baseUrl: config?.baseUrl ?? "https://api.openai.com", model: config?.model ?? "", apiKey: config?.apiKey ?? "", updatedAt: config?.updatedAt.toISOString() ?? null };
    },
  }),

  saveAiProviderConfig: defineAction({
    request: z.object({ baseUrl: z.string().url().max(500), apiKey: z.string().max(500), model: z.string().min(1).max(200) }),
    response: z.object({ ok: z.boolean(), message: z.string(), models: z.array(z.string()) }),
    async handler(ctx, args) {
      let baseUrl: string;
      try { baseUrl = requirePublicBaseUrl(args.baseUrl); } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "模型地址无效。", models: [] };
      }
      const db = ctx.db<typeof schema>();
      const now = new Date();
      await db.insert(schema.aiProviderConfig).values({ id: 1, baseUrl, apiKey: args.apiKey, model: args.model, updatedAt: now }).onConflictDoUpdate({ target: schema.aiProviderConfig.id, set: { baseUrl, apiKey: args.apiKey, model: args.model, updatedAt: now } });
      return { ok: true, message: "AI 配置已保存到服务器。", models: [] };
    },
  }),

  listAiModels: defineAction({
    request: z.object({ baseUrl: z.string().url().max(500), apiKey: z.string().max(500) }),
    response: z.object({ ok: z.boolean(), message: z.string(), models: z.array(z.string()) }),
    async handler(_ctx, args) {
      let baseUrl: string;
      try { baseUrl = requirePublicBaseUrl(args.baseUrl); } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "模型地址无效。", models: [] };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${args.apiKey}` }, signal: controller.signal, redirect: "error" });
        const body = await response.json() as { data?: Array<{ id?: string }> };
        const models = (body.data ?? []).map((item) => item.id ?? "").filter(Boolean).sort();
        return { ok: response.ok, message: response.ok ? `已读取 ${models.length} 个模型。` : "模型列表读取失败。", models };
      } catch (error) {
        return { ok: false, message: controller.signal.aborted ? `模型接口超过 ${AI_REQUEST_TIMEOUT_MS / 1000} 秒未响应，已中止。` : `无法连接模型服务：${error instanceof Error ? error.message : "未知错误"}`, models: [] };
      } finally { clearTimeout(timer); }
    },
  }),

  runAiTask: defineAction({
    request: z.object({ taskId: z.string().uuid().nullable(), prompt: z.string().min(1).max(4000), root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), confirmToken: z.string().max(128).nullable().default(null) }),
    response: z.object({ ok: z.boolean(), taskId: z.string(), status: z.enum(["running", "waiting_confirmation", "completed", "failed"]), message: z.string(), steps: z.array(z.object({ command: z.string(), stdout: z.string(), stderr: z.string(), cwd: z.string(), exitCode: z.number().int().nullable(), requiresConfirmation: z.boolean() })), pendingCommand: z.string().nullable(), confirmToken: z.string().nullable(), diagnostic: z.object({ phase: z.string(), url: z.string(), status: z.number().int().nullable(), model: z.string(), detail: z.string(), responseSnippet: z.string(), contentSnippet: z.string() }).nullable() }),
    privileged: [privileged.executeShell],
    async handler(ctx, args) {
      pruneAiTasks();
      // One call performs at most one model turn plus one command. A multi-step
      // agent loop inside a single request would exceed the platform gateway
      // timeout ("Gateway request timed out"), so the client re-invokes this action
      // with the same taskId until the task completes.
      const config = await readAiConfig(ctx.db<typeof schema>());
      if (!config) return { ok: false, taskId: args.taskId ?? crypto.randomUUID(), status: "failed" as const, message: "请先配置 AI 服务。", steps: [], pendingCommand: null, confirmToken: null, diagnostic: null };
      const owner = "default";
      const taskId = args.taskId ?? crypto.randomUUID();
      let state = args.taskId ? aiTasks.get(args.taskId) : undefined;
      if (state && (state.owner !== owner || state.configId !== config.id)) {
        return { ok: false, taskId, status: "failed" as const, message: "任务不存在、已过期，或模型配置已变更，请重新发起。", steps: [], pendingCommand: null, confirmToken: null, diagnostic: null };
      }
      if (state?.busy) return { ok: false, taskId, status: "running" as const, message: "任务正在执行，请等待当前步骤完成。", steps: state.steps, pendingCommand: state.pendingCommand || null, confirmToken: null, diagnostic: null };
      if (!state) {
        state = { configId: config.id, owner, root: args.root, path: args.path, cwd: null, runAsRoot: true, pendingCommand: "", pendingTokenHash: null, pendingAutoRun: false, steps: [], busy: false, updatedAt: Date.now(), messages: [{ role: "system", content: "你是一个沙盒终端 Agent，拥有 root 权限。每次只返回 JSON：{command:string, explanation:string, done:boolean}。一次只生成一条 bash 命令。只读、搜索、检查、测试命令可以自动执行；修改、删除、移动、安装、权限变更命令会暂停等待用户确认。任务完成时 command 为空且 done=true。只输出 JSON，不要 Markdown。" }, { role: "user", content: `任务：${args.prompt}\n根类型：${args.root}\n相对路径：${args.path || "/"}` }] };
        aiTasks.set(taskId, state);
        pruneAiTasks();
      }
      state.busy = true;
      state.updatedAt = Date.now();
      try {
        // Each call does exactly one thing: run the queued command, or ask the model
        // for the next one. Keeping the two apart caps a request at the model timeout
        // or the shell timeout instead of their sum, so the platform gateway does not
        // abort it with "Gateway request timed out".
        if (state.pendingCommand) {
          const isAutoRun = state.pendingAutoRun;
          if (!isAutoRun) {
            const providedHash = args.confirmToken ? digestToken(args.confirmToken) : "";
            if (!state.pendingTokenHash || !providedHash || !constantTimeEqual(providedHash, state.pendingTokenHash)) {
              return { ok: true, taskId, status: "waiting_confirmation" as const, message: "这一步需要用户确认后才能执行。", steps: state.steps, pendingCommand: state.pendingCommand, confirmToken: null, diagnostic: null };
            }
          }
          const queuedCommand = state.pendingCommand;
          state.pendingCommand = "";
          state.pendingTokenHash = null;
          state.pendingAutoRun = false;
          pushAiMessage(state, { role: "user", content: isAutoRun ? `执行命令：${queuedCommand}` : `用户已确认执行待执行命令：${queuedCommand}` });
          const result = await ctx.executePrivileged(privileged.executeShell, { command: queuedCommand, root: state.root, path: state.path, cwd: state.cwd, runAsRoot: state.runAsRoot });
          state.cwd = result.cwd;
          state.steps.push({ command: queuedCommand, stdout: result.stdout, stderr: result.stderr, cwd: result.cwd, exitCode: result.exitCode, requiresConfirmation: !isAutoRun });
          pushAiMessage(state, { role: "user", content: `命令：${queuedCommand}\n退出码：${result.exitCode ?? "未知"}\nstdout：${result.stdout.slice(0, 12000)}\nstderr：${result.stderr.slice(0, 12000)}` });
          return { ok: true, taskId, status: "running" as const, message: "命令已执行，继续下一步。", steps: state.steps, pendingCommand: null, confirmToken: null, diagnostic: null };
        }
        const next = await requestNextAiCommand(config, state.messages, AI_AGENT_REQUEST_TIMEOUT_MS);
        if (next.done) { aiTasks.delete(taskId); return { ok: true, taskId, status: "completed" as const, message: next.explanation || "任务已完成。", steps: state.steps, pendingCommand: null, confirmToken: null, diagnostic: null }; }
        if (!next.command) throw new Error("模型没有返回可执行命令，且未标记任务完成。");
        const assessment = assessCommand(next.command);
        pushAiMessage(state, { role: "assistant", content: JSON.stringify(next) });
        state.pendingCommand = next.command;
        if (assessment.requiresConfirmation) {
          const token = randomToken();
          state.pendingTokenHash = digestToken(token);
          state.pendingAutoRun = false;
          return { ok: true, taskId, status: "waiting_confirmation" as const, message: next.explanation || `这一步需要确认：${assessment.reason}`, steps: state.steps, pendingCommand: next.command, confirmToken: token, diagnostic: null };
        }
        state.pendingTokenHash = null;
        state.pendingAutoRun = true;
        return { ok: true, taskId, status: "running" as const, message: next.explanation || "准备执行命令。", steps: state.steps, pendingCommand: next.command, confirmToken: null, diagnostic: null };
      } catch (error) {
        aiTasks.delete(taskId);
        return { ok: false, taskId, status: "failed" as const, message: `AI Agent 执行失败：${error instanceof Error ? error.message : "未知错误"}`, steps: state.steps, pendingCommand: null, confirmToken: null, diagnostic: describeAiError(error) };
      } finally {
        state.busy = false;
        state.updatedAt = Date.now();
      }
    },
  }),

  executeShell: defineAction({
    request: z.object({ command: z.string().min(1).max(4000), root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), cwd: z.string().max(2000).nullable().default(null) }),
    response: z.object({ ok: z.boolean(), stdout: z.string(), stderr: z.string(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), cwd: z.string(), durationMs: z.number().int() }),
    privileged: [privileged.executeShell],
    async handler(ctx, args) { return ctx.executePrivileged(privileged.executeShell, args); },
  }),

  generateAiShellCommand: defineAction({
    request: z.object({ prompt: z.string().min(1).max(4000), root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000) }),
    response: z.object({ ok: z.boolean(), message: z.string(), command: z.string(), explanation: z.string(), requiresConfirmation: z.boolean() }),
    async handler(ctx, args) {
      const config = await readAiConfig(ctx.db<typeof schema>());
      if (!config) return { ok: false, message: "请先配置 AI 服务。", command: "", explanation: "", requiresConfirmation: false };
      try {
        const response = await aiFetch(config, "/chat/completions", { method: "POST", body: JSON.stringify({ model: config.model, temperature: 0.1, messages: [{ role: "system", content: "你是沙盒终端助手。只生成一条 bash 命令，不要执行。返回 JSON：{command:string, explanation:string}，不要 Markdown 代码块。当前工作区根类型和相对路径会由用户提供。优先使用只读命令；修改、删除、移动、安装、权限变更命令必须明确说明。" }, { role: "user", content: `目标：${args.prompt}\n工作区根类型：${args.root}\n相对路径：${args.path || "/"}` }] }) });
        const raw = await response.text();
        if (!response.ok) throw new Error(`模型接口 ${response.status}: ${raw.slice(0, 500)}`);
        const body = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
        const parsed = parseAiCommandContent(body.choices?.[0]?.message?.content ?? "");
        const command = parsed.command.trim();
        if (!command) return { ok: false, message: "模型没有返回可执行命令。", command: "", explanation: "", requiresConfirmation: false };
        return { ok: true, message: "命令已生成。", command, explanation: parsed.explanation, requiresConfirmation: assessCommand(command).requiresConfirmation };
      } catch (error) { return { ok: false, message: `AI 请求失败：${error instanceof Error ? error.message : "未知错误"}`, command: "", explanation: "", requiresConfirmation: false }; }
    },
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
