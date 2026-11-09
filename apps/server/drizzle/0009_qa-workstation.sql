CREATE TABLE `qa_case_result` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`workstation_id` text NOT NULL,
	`suite_id` text NOT NULL,
	`case_key` text NOT NULL,
	`classname` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`failure_message` text,
	`failure_detail` text,
	`fingerprint` text,
	`commit_sha` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `qa_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workstation_id`) REFERENCES `workstation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_qa_case_key` ON `qa_case_result` (`workstation_id`,`case_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_qa_case_run` ON `qa_case_result` (`run_id`);--> statement-breakpoint
CREATE TABLE `qa_run` (
	`id` text PRIMARY KEY NOT NULL,
	`workstation_id` text NOT NULL,
	`suite_id` text NOT NULL,
	`suite_name` text NOT NULL,
	`config_json` text NOT NULL,
	`plan_id` text,
	`ref` text NOT NULL,
	`commit_sha` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger` text NOT NULL,
	`actor_type` text,
	`actor_id` text,
	`total` integer DEFAULT 0 NOT NULL,
	`passed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`errored` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`coverage_json` text,
	`output_artifact_id` text,
	`error` text,
	`env_error` integer DEFAULT 0 NOT NULL,
	`retry_of` text,
	`triage_json` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`workstation_id`) REFERENCES `workstation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_qa_run_ws` ON `qa_run` (`workstation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_qa_run_suite` ON `qa_run` (`workstation_id`,`suite_id`,`created_at`);