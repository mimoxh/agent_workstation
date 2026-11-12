CREATE TABLE `task_dependency` (
	`task_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_id`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_dep_on` ON `task_dependency` (`depends_on_id`);--> statement-breakpoint
ALTER TABLE `task` ADD `start_at` text;--> statement-breakpoint
ALTER TABLE `task` ADD `milestone_id` text;--> statement-breakpoint
ALTER TABLE `task` ADD `pending_assignee_id` text;