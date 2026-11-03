DROP INDEX `receiving_methods_rail_target_uidx`;--> statement-breakpoint
CREATE UNIQUE INDEX `receiving_methods_rail_target_uidx`
	ON `receiving_methods` (
		`rail_code`,
		`normalized_target_value`,
		(CASE
			WHEN `rail_code` = 'alipay' THEN
				COALESCE(json_extract(`target_metadata`, '$.product'), 'website')
			ELSE ''
		END)
	);
