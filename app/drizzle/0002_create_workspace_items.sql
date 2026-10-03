CREATE TABLE workspace_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
  blob_key TEXT,
  mime_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX workspace_items_parent_idx ON workspace_items(parent_id);
