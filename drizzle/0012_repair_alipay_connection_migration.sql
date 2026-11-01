DROP TRIGGER IF EXISTS `receiving_method_locks_reconcile_after_delete`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `payment_ingresses_repaired` (
	`id` text PRIMARY KEY NOT NULL,
	`rail_code` text,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`transport` text DEFAULT 'http' NOT NULL,
	`endpoint` text,
	`api_key` text,
	`provider` text,
	`network` text,
	`external_network` text,
	`external_source_id` text,
	`config_encrypted` text,
	`provider_environment` text DEFAULT 'production' NOT NULL,
	`provider_product` text DEFAULT 'website' NOT NULL,
	`mode` text,
	`desired_addresses_hash` text,
	`reconcile_required_at` integer,
	`last_reconciled_at` integer,
	`last_event_at` integer,
	`priority` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`last_latency_ms` integer,
	`last_checked_at` integer,
	`last_error_code` text,
	`timeout_ms` integer,
	`block_lookback` integer,
	`log_block_range` integer,
	`max_scan_transactions` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`rail_code`) REFERENCES `payment_rails`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_ingresses_shape_check" CHECK((`type` = 'provider_webhook'
				AND `rail_code` IS NULL
				AND `provider` IS NOT NULL
				AND `network` IS NOT NULL
				AND `external_network` IS NOT NULL
				AND `external_source_id` IS NOT NULL
				AND `config_encrypted` IS NOT NULL
				AND `mode` IS NOT NULL
				AND `transport` = 'webhook')
			OR (`type` != 'provider_webhook'
				AND `rail_code` IS NOT NULL
				AND `provider` IS NULL
				AND `network` IS NULL
				AND `external_network` IS NULL
				AND `external_source_id` IS NULL
				AND `config_encrypted` IS NULL
				AND `mode` IS NULL
				AND `transport` != 'webhook')),
	CONSTRAINT "payment_ingresses_provider_enabled_check" CHECK(type != 'provider' OR enabled = 1),
	CONSTRAINT "payment_ingresses_alipay_route_check" CHECK(`rail_code` != 'alipay' OR (`provider_environment` IN ('production', 'sandbox') AND `provider_product` IN ('website', 'face_to_face')))
);--> statement-breakpoint
INSERT INTO `payment_ingresses_repaired`("id", "rail_code", "name", "type", "transport", "endpoint", "api_key", "provider", "network", "external_network", "external_source_id", "config_encrypted", "provider_environment", "provider_product", "mode", "desired_addresses_hash", "reconcile_required_at", "last_reconciled_at", "last_event_at", "priority", "enabled", "health_status", "last_latency_ms", "last_checked_at", "last_error_code", "timeout_ms", "block_lookback", "log_block_range", "max_scan_transactions", "created_at", "updated_at") SELECT "id", "rail_code", "name", "type", "transport", "endpoint", "api_key", "provider", "network", "external_network", "external_source_id", "config_encrypted", "provider_environment", "provider_product", "mode", "desired_addresses_hash", "reconcile_required_at", "last_reconciled_at", "last_event_at", "priority", "enabled", "health_status", "last_latency_ms", "last_checked_at", "last_error_code", "timeout_ms", "block_lookback", "log_block_range", "max_scan_transactions", "created_at", "updated_at" FROM `payment_ingresses`;--> statement-breakpoint
DROP TABLE `payment_ingresses`;--> statement-breakpoint
ALTER TABLE `payment_ingresses_repaired` RENAME TO `payment_ingresses`;--> statement-breakpoint
DROP TABLE IF EXISTS `__new_payment_ingresses`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `payment_ingresses_alipay_route_idx` ON `payment_ingresses` (`rail_code`,`provider_environment`,`provider_product`,`enabled`,`priority`) WHERE "payment_ingresses"."rail_code" = 'alipay';--> statement-breakpoint
CREATE INDEX `payment_ingresses_rail_priority_idx` ON `payment_ingresses` (`rail_code`,`enabled`,`priority`);--> statement-breakpoint
CREATE INDEX `payment_ingresses_health_due_idx` ON `payment_ingresses` ("last_checked_at" IS NOT NULL,`last_checked_at`,`priority`,`id`) WHERE "payment_ingresses"."enabled" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `payment_ingresses_provider_network_uidx` ON `payment_ingresses` (`provider`,`network`) WHERE "payment_ingresses"."type" = 'provider_webhook';--> statement-breakpoint
CREATE UNIQUE INDEX `payment_ingresses_external_uidx` ON `payment_ingresses` (`provider`,`external_source_id`) WHERE "payment_ingresses"."type" = 'provider_webhook';--> statement-breakpoint
CREATE INDEX `payment_ingresses_reconcile_idx` ON `payment_ingresses` (`reconcile_required_at`,`id`);--> statement-breakpoint
CREATE TRIGGER `receiving_method_locks_reconcile_after_delete`
AFTER DELETE ON `receiving_method_locks`
BEGIN
	UPDATE `payment_ingresses`
	SET `reconcile_required_at` = COALESCE(`reconcile_required_at`, unixepoch() * 1000),
		`updated_at` = unixepoch() * 1000
	WHERE `type` = 'provider_webhook' AND `enabled` = 1 AND EXISTS (
		SELECT 1 FROM `receiving_methods` method
		WHERE method.`id` = OLD.`receiving_method_id` AND method.`enabled` = 0
		AND method.`rail_code` = `payment_ingresses`.`network`
	);
END;
