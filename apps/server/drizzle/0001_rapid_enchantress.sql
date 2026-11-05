CREATE TABLE `access_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`rights_json` text
);
--> statement-breakpoint
CREATE TABLE `agent` (
	`id` text PRIMARY KEY NOT NULL,
	`workstation_id` text NOT NULL,
	`template_id` text,
	`name` text NOT NULL,
	`role` text,
	`model_json` text,
	`prompt` text,
	`tools_json` text,
	`budget_json` text,
	`is_steward` integer DEFAULT 0 NOT NULL,
	`status` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workstation_id`) REFERENCES `workstation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`workstation_id` text,
	`task_id` text,
	`type` text,
	`name` text,
	`ref` text,
	`meta_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workstation_id`) REFERENCES `workstation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `block` (
	`id` text PRIMARY KEY NOT NULL,
	`workstation_id` text NOT NULL,
	`panel_id` text,
	`panel_type` text,
	`entity_type` text,
	`name` text,
	`config_json` text,
	`sort` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workstation_id`) REFERENCES `workstation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `entity` (
	`id` text PRIMARY KEY NOT NULL,
	`workstation_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`data_json` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_type` text,
	`created_by_id` text,
	`created_at` text NOT NULL,
	`updated_at` text,
	FOREIGN KEY (`workstation_id`) REFERENCES `workstation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_entity_ws_type` ON `entity` (`workstation_id`,`entity_type`);--> statement-breakpoint
CREATE TABLE `entity_version` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`version` integer NOT NULL,
	`data_json` text,
	`author_type` text,
	`author_id` text,
	`reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entity`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_version_entity` ON `entity_version` (`entity_id`,`version`);--> statement-breakpoint
CREATE TABLE `event_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_type` text,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`payload_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbox_item` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`kind` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`severity` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`sender_type` text,
	`sender_id` text,
	`kind` text,
	`content` text,
	`meta_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_msg_thread` ON `message` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `plugin_install` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`version` text,
	`source` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`target_type` text,
	`entity_id` text,
	`base_version` integer,
	`patch_json` text,
	`code_ref_json` text,
	`reason` text,
	`author_type` text,
	`author_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by_type` text,
	`decided_by_id` text,
	`decided_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `review_comment` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`author_type` text,
	`author_id` text,
	`path` text,
	`line` integer,
	`body` text,
	`resolved` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `run` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`task_id` text,
	`status` text,
	`provider` text,
	`model` text,
	`fallback_from` text,
	`stop_reason` text,
	`started_at` text,
	`ended_at` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost` integer,
	`trace_json` text,
	`error` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_run_agent` ON `run` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `thread` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text,
	`scope_id` text,
	`kind` text,
	`mode` text,
	`title` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `thread_member` (
	`thread_id` text NOT NULL,
	`participant_type` text NOT NULL,
	`participant_id` text NOT NULL,
	`role` text,
	PRIMARY KEY(`thread_id`, `participant_type`, `participant_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE no action
);
