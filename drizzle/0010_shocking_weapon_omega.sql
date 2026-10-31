CREATE TABLE `provider_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`rail_code` text NOT NULL,
	`provider_trade_id` text NOT NULL,
	`amount_minor` text NOT NULL,
	`currency` text NOT NULL,
	`currency_decimals` integer NOT NULL,
	`status` text NOT NULL,
	`observed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rail_code`) REFERENCES `payment_rails`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_payments_rail_trade_uidx` ON `provider_payments` (`rail_code`,`provider_trade_id`);--> statement-breakpoint
CREATE INDEX `provider_payments_order_idx` ON `provider_payments` (`order_id`);