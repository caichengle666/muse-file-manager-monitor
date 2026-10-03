CREATE TABLE IF NOT EXISTS `ai_provider_config` (
  `id` integer PRIMARY KEY NOT NULL,
  `base_url` text NOT NULL,
  `api_key` text NOT NULL,
  `model` text NOT NULL,
  `updated_at` integer NOT NULL
);
