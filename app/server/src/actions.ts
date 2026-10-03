import { defineAction, z, type ActionsModule, type SpaceDb } from "@hatch/space-sdk";
import { and, eq, sql } from "drizzle-orm";
import { privileged } from "@space/privileged";
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

function normalizeAiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function isDestructiveCommand(command: string): boolean {
  return /(^|[;&|]\s*)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|kill|pkill|dd|truncate|sed\s+-i|perl\s+-i|python(?:3)?\s+-c|npm\s+(?:install|uninstall)|bun\s+(?:add|remove)|apt(?:-get)?\s+(?:install|remove)|git\s+(?:reset|clean|checkout|restore)|>\s*|>>\s*)/i.test(command);
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

async function aiFetch(config: typeof schema.aiProviderConfig.$inferSelect, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${normalizeAiBaseUrl(config.baseUrl)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

type AiTaskMessage = { role: "system" | "user" | "assistant"; content: string };
type AiTaskState = { configId: number; root: "system" | "workspace" | "build" | "private"; path: string; cwd: string | null; runAsRoot: boolean; messages: AiTaskMessage[]; pendingCommand: string; steps: Array<{ command: string; stdout: string; stderr: string; cwd: string; exitCode: number | null; requiresConfirmation: boolean }> };
const aiTasks = new Map<string, AiTaskState>();

async function requestNextAiCommand(config: typeof schema.aiProviderConfig.$inferSelect, messages: AiTaskMessage[]): Promise<{ command: string; explanation: string; done: boolean }> {
  const response = await aiFetch(config, "/chat/completions", { method: "POST", body: JSON.stringify({ model: config.model, temperature: 0.1, messages }) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`模型接口 ${response.status}: ${raw.slice(0, 500)}`);
  const body = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content ?? "{}";
  const normalized = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = JSON.parse(normalized) as { command?: string; explanation?: string; done?: boolean };
  return { command: String(parsed.command ?? "").trim(), explanation: String(parsed.explanation ?? ""), done: Boolean(parsed.done) };
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
    response: z.object({ configured: z.boolean(), baseUrl: z.string(), model: z.string(), apiKeySet: z.boolean(), updatedAt: z.string().nullable() }),
    async handler(ctx) {
      const config = await readAiConfig(ctx.db<typeof schema>());
      return { configured: Boolean(config), baseUrl: config?.baseUrl ?? "https://api.openai.com", model: config?.model ?? "", apiKeySet: Boolean(config?.apiKey), updatedAt: config?.updatedAt.toISOString() ?? null };
    },
  }),

  saveAiProviderConfig: defineAction({
    request: z.object({ baseUrl: z.string().url().max(500), apiKey: z.string().max(500), model: z.string().min(1).max(200) }),
    response: z.object({ ok: z.boolean(), message: z.string(), models: z.array(z.string()) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const now = new Date();
      await db.insert(schema.aiProviderConfig).values({ id: 1, baseUrl: args.baseUrl, apiKey: args.apiKey, model: args.model, updatedAt: now }).onConflictDoUpdate({ target: schema.aiProviderConfig.id, set: { baseUrl: args.baseUrl, apiKey: args.apiKey, model: args.model, updatedAt: now } });
      return { ok: true, message: "AI 配置已保存到服务器。", models: [] };
    },
  }),

  listAiModels: defineAction({
    request: z.object({ baseUrl: z.string().url().max(500), apiKey: z.string().max(500) }),
    response: z.object({ ok: z.boolean(), message: z.string(), models: z.array(z.string()) }),
    async handler(_ctx, args) {
      try {
        const response = await fetch(`${normalizeAiBaseUrl(args.baseUrl)}/models`, { headers: { Authorization: `Bearer ${args.apiKey}` } });
        const body = await response.json() as { data?: Array<{ id?: string }> };
        const models = (body.data ?? []).map((item) => item.id ?? "").filter(Boolean).sort();
        return { ok: response.ok, message: response.ok ? `已读取 ${models.length} 个模型。` : "模型列表读取失败。", models };
      } catch { return { ok: false, message: "无法连接模型服务，请检查地址和网络。", models: [] }; }
    },
  }),

  runAiTask: defineAction({
    request: z.object({ taskId: z.string().uuid().nullable(), prompt: z.string().min(1).max(4000), root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), approvePending: z.boolean().default(false), maxSteps: z.number().int().min(1).max(30).default(20) }),
    response: z.object({ ok: z.boolean(), taskId: z.string(), status: z.enum(["running", "waiting_confirmation", "completed", "failed"]), message: z.string(), steps: z.array(z.object({ command: z.string(), stdout: z.string(), stderr: z.string(), cwd: z.string(), exitCode: z.number().int().nullable(), requiresConfirmation: z.boolean() })), pendingCommand: z.string().nullable() }),
    privileged: [privileged.executeShell],
    async handler(ctx, args) {
      const config = await readAiConfig(ctx.db<typeof schema>());
      if (!config) return { ok: false, taskId: args.taskId ?? crypto.randomUUID(), status: "failed" as const, message: "请先配置 AI 服务。", steps: [], pendingCommand: null };
      const taskId = args.taskId ?? crypto.randomUUID();
      let state = args.taskId ? aiTasks.get(args.taskId) : undefined;
      if (!state) {
        state = { configId: config.id, root: args.root, path: args.path, cwd: null, runAsRoot: true, pendingCommand: "", steps: [], messages: [{ role: "system", content: "你是一个沙盒终端 Agent。每次只返回 JSON：{command:string, explanation:string, done:boolean}。一次只生成一条 bash 命令。读取、搜索、检查、测试命令可以自动执行；修改、删除、移动、安装、权限变更命令会暂停等待用户确认。任务完成时 command 为空且 done=true。" }, { role: "user", content: `任务：${args.prompt}\n根类型：${args.root}\n相对路径：${args.path || "/"}` }] };
        aiTasks.set(taskId, state);
      }
      try {
        if (state.pendingCommand) {
          if (!args.approvePending) return { ok: true, taskId, status: "waiting_confirmation" as const, message: "等待确认后继续。", steps: state.steps, pendingCommand: state.pendingCommand };
          const confirmedCommand = state.pendingCommand;
          state.messages.push({ role: "user", content: `用户已确认执行待执行命令：${confirmedCommand}` });
          state.pendingCommand = "";
          const result = await ctx.executePrivileged(privileged.executeShell, { command: confirmedCommand, root: state.root, path: state.path, cwd: state.cwd, runAsRoot: state.runAsRoot });
          state.cwd = result.cwd;
          state.steps.push({ command: confirmedCommand, stdout: result.stdout, stderr: result.stderr, cwd: result.cwd, exitCode: result.exitCode, requiresConfirmation: true });
          state.messages.push({ role: "user", content: `命令：${confirmedCommand}\n退出码：${result.exitCode ?? "未知"}\nstdout：${result.stdout.slice(0, 12000)}\nstderr：${result.stderr.slice(0, 12000)}` });
        }
        for (let step = 0; step < args.maxSteps; step += 1) {
          const next = await requestNextAiCommand(config, state.messages);
          if (next.done || !next.command) { aiTasks.delete(taskId); return { ok: true, taskId, status: "completed" as const, message: next.explanation || "任务已完成。", steps: state.steps, pendingCommand: null }; }
          const requiresConfirmation = isDestructiveCommand(next.command);
          state.messages.push({ role: "assistant", content: JSON.stringify(next) });
          if (requiresConfirmation) {
            state.pendingCommand = next.command;
            return { ok: true, taskId, status: "waiting_confirmation" as const, message: next.explanation || "这一步需要确认。", steps: state.steps, pendingCommand: next.command };
          }
          const result = await ctx.executePrivileged(privileged.executeShell, { command: next.command, root: state.root, path: state.path, cwd: state.cwd, runAsRoot: state.runAsRoot });
          state.cwd = result.cwd;
          state.steps.push({ command: next.command, stdout: result.stdout, stderr: result.stderr, cwd: result.cwd, exitCode: result.exitCode, requiresConfirmation: false });
          state.messages.push({ role: "user", content: `命令：${next.command}\n退出码：${result.exitCode ?? "未知"}\nstdout：${result.stdout.slice(0, 12000)}\nstderr：${result.stderr.slice(0, 12000)}` });
        }
        return { ok: true, taskId, status: "running" as const, message: "已达到本轮步数上限，可继续运行任务。", steps: state.steps, pendingCommand: null };
      } catch (error) { aiTasks.delete(taskId); return { ok: false, taskId, status: "failed" as const, message: `AI Agent 执行失败：${error instanceof Error ? error.message : "未知错误"}`, steps: state.steps, pendingCommand: null }; }
    },
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
        const body = response.ok ? JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> } : null;
        const content = body?.choices?.[0]?.message?.content ?? "";
        const normalized = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        const parsed = JSON.parse(normalized || "{}");
        const command = String(parsed.command ?? "").trim();
        if (!response.ok || !command) return { ok: false, message: "模型没有返回可执行命令。", command: "", explanation: "", requiresConfirmation: false };
        return { ok: true, message: "命令已生成。", command, explanation: String(parsed.explanation ?? ""), requiresConfirmation: isDestructiveCommand(command) };
      } catch (error) { return { ok: false, message: `AI 请求失败：${error instanceof Error ? error.message : "未知错误"}`, command: "", explanation: "", requiresConfirmation: false }; }
    },
  }),

  executeShell: defineAction({
    request: z.object({ command: z.string().min(1).max(4000), root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000), cwd: z.string().max(2000).nullable().default(null) }),
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
