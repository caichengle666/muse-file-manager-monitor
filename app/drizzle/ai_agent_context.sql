CREATE TABLE IF NOT EXISTS `ai_agent_context` (
  `id` integer PRIMARY KEY NOT NULL,
  `task_id` text,
  `root` text NOT NULL,
  `path` text NOT NULL,
  `pending_command` text NOT NULL DEFAULT '',
  `confirm_token` text,
  `messages_json` text NOT NULL,
  `state_json` text,
  `updated_at` integer NOT NULL
);
