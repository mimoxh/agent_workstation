CREATE TABLE `knowledge_chunk` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`text` text NOT NULL,
	`token_count` integer,
	`anchor_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `knowledge_source`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_chunk_source` ON `knowledge_chunk` (`source_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `knowledge_source` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`uri` text,
	`mime` text,
	`sha256` text,
	`size` integer,
	`status` text,
	`meta_json` text,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE VIRTUAL TABLE `knowledge_fts` USING fts5(`text`, `chunk_id` UNINDEXED, tokenize = 'trigram');
