import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceItems = sqliteTable("workspace_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  parentId: integer("parent_id"),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["folder", "file"] }).notNull(),
  blobKey: text("blob_key"),
  mimeType: text("mime_type"),
  size: integer("size").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const serviceRestartRecord = sqliteTable("service_restart_record", {
  id: integer("id").primaryKey(),
  restartCount: integer("restart_count").notNull().default(0),
  previousStartedAt: integer("previous_started_at", { mode: "timestamp_ms" }),
  currentStartedAt: integer("current_started_at", { mode: "timestamp_ms" }).notNull(),
  instanceId: text("instance_id").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const aiProviderConfig = sqliteTable("ai_provider_config", {
  id: integer("id").primaryKey(),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  model: text("model").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
