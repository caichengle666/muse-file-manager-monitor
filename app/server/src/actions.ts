import { defineAction, z, type ActionsModule, type SpaceDb } from "@hatch/space-sdk";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { privileged } from "@space/privileged";
import * as schema from "./schema";

const parentIdSchema = z.number().int().positive().nullable().default(null);
const itemKindSchema = z.enum(["folder", "file"]);
const itemSchema = z.object({
  id: z.number().int(),
  parentId: z.number().int().nullable(),
  name: z.string(),
  kind: itemKindSchema,
  mimeType: z.string().nullable(),
  size: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const mutationResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  id: z.number().int().nullable(),
});

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

function validName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name === "." || name === ".." || name.length > 120) return null;
  if (/[\\/\u0000-\u001f]/.test(name)) return null;
  return name;
}

function serialize(row: Row) {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    kind: row.kind,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function siblingExists(db: Db, parentId: number | null, name: string, exceptId?: number) {
  const rows = await db
    .select()
    .from(schema.workspaceItems)
    .where(parentId === null ? isNull(schema.workspaceItems.parentId) : eq(schema.workspaceItems.parentId, parentId));
  return rows.some((row) => row.name.toLocaleLowerCase() === name.toLocaleLowerCase() && row.id !== exceptId);
}

async function parentIsFolder(db: Db, parentId: number | null): Promise<boolean> {
  if (parentId === null) return true;
  const rows = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, parentId)).limit(1);
  return rows[0]?.kind === "folder";
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 32_768, bytes.byteLength)));
  }
  return btoa(binary);
}

async function availableCopyName(db: Db, parentId: number | null, original: string): Promise<string> {
  if (!(await siblingExists(db, parentId, original))) return original;
  const dot = original.lastIndexOf(".");
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : "";
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${stem} 副本${index === 1 ? "" : ` ${index}`}${ext}`;
    if (!(await siblingExists(db, parentId, candidate))) return candidate;
  }
  return `${stem} 副本 ${Date.now()}${ext}`;
}

export const Actions = {
  browseFolder: defineAction({
    request: z.object({ parentId: parentIdSchema }),
    response: z.object({ items: z.array(itemSchema), breadcrumbs: z.array(z.object({ id: z.number().int().nullable(), name: z.string() })) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.workspaceItems)
        .where(args.parentId === null ? isNull(schema.workspaceItems.parentId) : eq(schema.workspaceItems.parentId, args.parentId))
        .orderBy(asc(schema.workspaceItems.kind), asc(schema.workspaceItems.name));

      const breadcrumbs: Array<{ id: number | null; name: string }> = [{ id: null, name: "工作区" }];
      if (args.parentId !== null) {
        const all = await db.select().from(schema.workspaceItems);
        const byId = new Map(all.map((row) => [row.id, row]));
        const chain: Row[] = [];
        let cursor = byId.get(args.parentId);
        const seen = new Set<number>();
        while (cursor && !seen.has(cursor.id)) {
          seen.add(cursor.id);
          chain.unshift(cursor);
          cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
        }
        for (const folder of chain) breadcrumbs.push({ id: folder.id, name: folder.name });
      }
      return { items: rows.map(serialize), breadcrumbs };
    },
  }),

  createFolder: defineAction({
    request: z.object({ parentId: parentIdSchema, name: z.string() }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const name = validName(args.name);
      if (!name) return { ok: false, message: "名称不能为空，且不能包含斜杠或控制字符。", id: null };
      if (!(await parentIsFolder(db, args.parentId))) return { ok: false, message: "目标文件夹不存在。", id: null };
      if (await siblingExists(db, args.parentId, name)) return { ok: false, message: "此位置已有同名项目。", id: null };
      const [created] = await db.insert(schema.workspaceItems).values({ parentId: args.parentId, name, kind: "folder" }).returning({ id: schema.workspaceItems.id });
      ctx.invalidateQueries();
      return { ok: true, message: "文件夹已创建。", id: created?.id ?? null };
    },
  }),

  createTextFile: defineAction({
    request: z.object({ parentId: parentIdSchema, name: z.string(), content: z.string().max(1_000_000) }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const name = validName(args.name);
      if (!name) return { ok: false, message: "文件名无效。", id: null };
      if (!(await parentIsFolder(db, args.parentId))) return { ok: false, message: "目标文件夹不存在。", id: null };
      if (await siblingExists(db, args.parentId, name)) return { ok: false, message: "此位置已有同名项目。", id: null };
      const bytes = new TextEncoder().encode(args.content);
      const blobKey = `workspace/${crypto.randomUUID()}`;
      await ctx.blobs.put(blobKey, bytes, { contentType: "text/plain;charset=utf-8" });
      const [created] = await db.insert(schema.workspaceItems).values({ parentId: args.parentId, name, kind: "file", blobKey, mimeType: "text/plain", size: bytes.byteLength }).returning({ id: schema.workspaceItems.id });
      ctx.invalidateQueries();
      return { ok: true, message: "文本文件已创建。", id: created?.id ?? null };
    },
  }),

  uploadFile: defineAction({
    request: z.object({ parentId: parentIdSchema, name: z.string(), mimeType: z.string().max(200), dataBase64: z.string().max(8_000_000) }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const name = validName(args.name);
      if (!name) return { ok: false, message: "文件名无效。", id: null };
      if (!(await parentIsFolder(db, args.parentId))) return { ok: false, message: "目标文件夹不存在。", id: null };
      if (await siblingExists(db, args.parentId, name)) return { ok: false, message: "此位置已有同名项目。", id: null };
      let bytes: Uint8Array;
      try { bytes = decodeBase64(args.dataBase64); } catch { return { ok: false, message: "文件内容无法读取。", id: null }; }
      if (bytes.byteLength > 5_000_000) return { ok: false, message: "单个文件不能超过 5 MB。", id: null };
      const blobKey = `workspace/${crypto.randomUUID()}`;
      const mimeType = args.mimeType || "application/octet-stream";
      await ctx.blobs.put(blobKey, bytes, { contentType: mimeType });
      const [created] = await db.insert(schema.workspaceItems).values({ parentId: args.parentId, name, kind: "file", blobKey, mimeType, size: bytes.byteLength }).returning({ id: schema.workspaceItems.id });
      ctx.invalidateQueries();
      return { ok: true, message: "文件已上传。", id: created?.id ?? null };
    },
  }),

  renameItem: defineAction({
    request: z.object({ id: z.number().int().positive(), name: z.string() }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [item] = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, args.id)).limit(1);
      if (!item) return { ok: false, message: "项目不存在。", id: null };
      const name = validName(args.name);
      if (!name) return { ok: false, message: "名称无效。", id: null };
      if (await siblingExists(db, item.parentId, name, item.id)) return { ok: false, message: "此位置已有同名项目。", id: null };
      await db.update(schema.workspaceItems).set({ name, updatedAt: new Date() }).where(eq(schema.workspaceItems.id, item.id));
      ctx.invalidateQueries();
      return { ok: true, message: "名称已更新。", id: item.id };
    },
  }),

  moveItem: defineAction({
    request: z.object({ id: z.number().int().positive(), parentId: parentIdSchema }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const all = await db.select().from(schema.workspaceItems);
      const item = all.find((row) => row.id === args.id);
      if (!item) return { ok: false, message: "项目不存在。", id: null };
      if (!(await parentIsFolder(db, args.parentId))) return { ok: false, message: "目标文件夹不存在。", id: null };
      if (item.id === args.parentId) return { ok: false, message: "不能移动到自身。", id: null };
      if (item.kind === "folder" && args.parentId !== null) {
        const byId = new Map(all.map((row) => [row.id, row]));
        let cursor = byId.get(args.parentId);
        while (cursor) {
          if (cursor.id === item.id) return { ok: false, message: "不能移动到自己的子文件夹。", id: null };
          cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
        }
      }
      if (await siblingExists(db, args.parentId, item.name, item.id)) return { ok: false, message: "目标位置已有同名项目。", id: null };
      await db.update(schema.workspaceItems).set({ parentId: args.parentId, updatedAt: new Date() }).where(eq(schema.workspaceItems.id, item.id));
      ctx.invalidateQueries();
      return { ok: true, message: "项目已移动。", id: item.id };
    },
  }),

  copyItem: defineAction({
    request: z.object({ id: z.number().int().positive(), parentId: parentIdSchema }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const all = await db.select().from(schema.workspaceItems);
      const root = all.find((row) => row.id === args.id);
      if (!root) return { ok: false, message: "项目不存在。", id: null };
      if (!(await parentIsFolder(db, args.parentId))) return { ok: false, message: "目标文件夹不存在。", id: null };
      const rootName = await availableCopyName(db, args.parentId, root.name);
      const copyBranch = async (source: Row, parentId: number | null, name: string): Promise<number> => {
        const [inserted] = await db.insert(schema.workspaceItems).values({ parentId, name, kind: source.kind, blobKey: source.blobKey, mimeType: source.mimeType, size: source.size }).returning({ id: schema.workspaceItems.id });
        if (!inserted) throw new Error("copy failed");
        if (source.kind === "folder") {
          const children = all.filter((row) => row.parentId === source.id);
          for (const child of children) await copyBranch(child, inserted.id, child.name);
        }
        return inserted.id;
      };
      const newId = await copyBranch(root, args.parentId, rootName);
      ctx.invalidateQueries();
      return { ok: true, message: "副本已创建。", id: newId };
    },
  }),

  deleteItem: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const all = await db.select().from(schema.workspaceItems);
      const root = all.find((row) => row.id === args.id);
      if (!root) return { ok: false, message: "项目不存在。", id: null };
      const ids = new Set<number>([root.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of all) {
          if (row.parentId !== null && ids.has(row.parentId) && !ids.has(row.id)) { ids.add(row.id); changed = true; }
        }
      }
      const removing = all.filter((row) => ids.has(row.id));
      await db.delete(schema.workspaceItems).where(inArray(schema.workspaceItems.id, [...ids]));
      const remaining = all.filter((row) => !ids.has(row.id));
      const blobKeys = new Set(removing.map((row) => row.blobKey).filter((key): key is string => Boolean(key)));
      for (const key of blobKeys) {
        if (!remaining.some((row) => row.blobKey === key)) await ctx.blobs.delete(key);
      }
      ctx.invalidateQueries();
      return { ok: true, message: root.kind === "folder" ? "文件夹及其中内容已删除。" : "文件已删除。", id: root.id };
    },
  }),

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

  updateTextFile: defineAction({
    request: z.object({ id: z.number().int().positive(), content: z.string().max(1_000_000) }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [item] = await db.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, args.id), eq(schema.workspaceItems.kind, "file"))).limit(1);
      if (!item?.blobKey) return { ok: false, message: "文件内容不可用。", id: null };
      const mime = item.mimeType?.toLowerCase() ?? "";
      const textName = /(?:^|\.)(?:txt|md|json|jsonl|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|xml|svg|ya?ml|toml|ini|conf|cfg|properties|sql|log|csv|tsv|sh|bash|zsh|fish|py|rb|php|java|go|rs|c|h|cpp|hpp|vue|svelte)$/i.test(item.name);
      if (!(mime.startsWith("text/") || mime.includes("json") || mime.includes("javascript") || mime.includes("xml") || textName)) {
        return { ok: false, message: "这个文件不是可编辑的文本格式。", id: item.id };
      }
      const bytes = new TextEncoder().encode(args.content);
      const nextBlobKey = `workspace/${crypto.randomUUID()}`;
      let committed = false;
      try {
        await ctx.blobs.put(nextBlobKey, bytes, { contentType: item.mimeType ?? "text/plain;charset=utf-8" });
        await db.update(schema.workspaceItems).set({ blobKey: nextBlobKey, size: bytes.byteLength, updatedAt: new Date() }).where(eq(schema.workspaceItems.id, item.id));
        committed = true;
      } finally {
        if (!committed) {
          try { await ctx.blobs.delete(nextBlobKey); } catch { /* best-effort cleanup */ }
        }
      }
      try { await ctx.blobs.delete(item.blobKey); } catch { /* periodic cleanup removes an unreferenced old blob */ }
      ctx.invalidateQueries();
      return { ok: true, message: "文件已保存。", id: item.id };
    },
  }),

  cleanupOrphanBlobs: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean(), message: z.string(), removed: z.number().int() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select({ blobKey: schema.workspaceItems.blobKey }).from(schema.workspaceItems);
      const referenced = new Set(rows.map((row) => row.blobKey).filter((key): key is string => Boolean(key)));
      const blobs = await ctx.blobs.list("workspace/");
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      let removed = 0;
      for (const blob of blobs) {
        if (referenced.has(blob.key) || blob.updatedAtMs >= cutoff) continue;
        const latestRows = await db.select({ blobKey: schema.workspaceItems.blobKey }).from(schema.workspaceItems);
        if (latestRows.some((row) => row.blobKey === blob.key)) continue;
        await ctx.blobs.delete(blob.key);
        removed += 1;
      }
      return { ok: true, message: removed ? `已清理 ${removed} 个孤立文件块。` : "没有发现孤立文件块。", removed };
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

  executeShell: defineAction({
    request: z.object({ command: z.string().min(1).max(4000), root: z.enum(["system", "workspace", "build", "private"]), path: z.string().max(2000) }),
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
