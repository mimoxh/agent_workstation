CREATE TABLE `video_render` (
	`id` text PRIMARY KEY NOT NULL,
	`workstation_id` text NOT NULL,
	`video_id` text NOT NULL,
	`video_version` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`settings_json` text NOT NULL,
	`output_artifact_id` text,
	`srt_artifact_id` text,
	`error` text,
	`started_at` text,
	`finished_at` text,
	`created_by_type` text,
	`created_by_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workstation_id`) REFERENCES `workstation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_video_render_video` ON `video_render` (`video_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_video_render_ws` ON `video_render` (`workstation_id`,`created_at`);
