CREATE TABLE IF NOT EXISTS `service_restart_record` (
  `id` integer PRIMARY KEY NOT NULL,
  `restart_count` integer NOT NULL DEFAULT 0,
  `previous_started_at` integer,
  `current_started_at` integer NOT NULL,
  `instance_id` text NOT NULL,
  `updated_at` integer NOT NULL
);
