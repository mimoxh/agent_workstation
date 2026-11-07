ALTER TABLE `proposal` ADD `workstation_id` text;--> statement-breakpoint
ALTER TABLE `run` ADD `thread_id` text;--> statement-breakpoint
ALTER TABLE `task` ADD `takeover_from` text;--> statement-breakpoint
ALTER TABLE `thread` ADD `state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `thread` ADD `turn_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `thread` SET `mode` = 'moderated' WHERE `kind` = 'discussion';
