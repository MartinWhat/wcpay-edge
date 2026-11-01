import { readdir, readFile } from "node:fs/promises";

export async function applyMigrations(database: D1Database, through?: number) {
	const directory = new URL("../../drizzle/", import.meta.url);
	const files = (await readdir(directory))
		.filter((name) => /^\d+_.+\.sql$/.test(name))
		.filter(
			(name) => through === undefined || Number(name.slice(0, 4)) <= through,
		)
		.sort();
	for (const file of files) {
		const migration = await readFile(new URL(file, directory), "utf8");
		for (const statement of migrationStatements(migration))
			await database.prepare(statement).run();
	}
	// Fixture convenience: a receiving target links every payment method on its rail.
	await database
		.prepare(`CREATE TRIGGER IF NOT EXISTS test_link_receiving_method_assets
		AFTER INSERT ON receiving_methods BEGIN
			INSERT OR IGNORE INTO receiving_method_assets
				(id, receiving_method_id, payment_asset_id, created_at, updated_at)
			SELECT lower(hex(randomblob(16))), NEW.id, asset.id, NEW.created_at, NEW.updated_at
			FROM payment_assets asset
			WHERE asset.rail_code = NEW.rail_code;
		END`)
		.run();
}

export function migrationStatements(migration: string) {
	return migration
		.split("--> statement-breakpoint")
		.map((value) => value.trim())
		.filter(Boolean);
}
