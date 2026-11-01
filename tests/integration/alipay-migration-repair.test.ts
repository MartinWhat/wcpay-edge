import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { applyMigrations, migrationStatements } from "./migrations";

describe("Alipay connection migration repair", () => {
	it("restores a database left incomplete by the released migration", async () => {
		const runtime = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "alipay-migration-repair" },
		});
		try {
			const db = await runtime.getD1Database("DB");
			await applyMigrations(db, 10);
			await db
				.prepare(
					"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('alipay', 'Alipay', 'fiat', 'alipay', 1, 1)",
				)
				.run();
			await db
				.prepare(
					"INSERT INTO payment_ingresses (id, rail_code, name, type, transport, endpoint, enabled, created_at, updated_at) VALUES ('alipay-production', 'alipay', 'Alipay production', 'provider', 'http', 'https://openapi.alipay.com', 1, 1, 1)",
				)
				.run();

			const broken = await readFile(
				new URL("../../drizzle/0011_low_phil_sheldon.sql", import.meta.url),
				"utf8",
			);
			for (const statement of migrationStatements(broken).slice(0, 5))
				await db.prepare(statement).run();

			const repair = await readFile(
				new URL(
					"../../drizzle/0012_repair_alipay_connection_migration.sql",
					import.meta.url,
				),
				"utf8",
			);
			for (const statement of migrationStatements(repair))
				await db.prepare(statement).run();

			expect(
				await db
					.prepare(
						"SELECT rail_code, provider_environment, provider_product FROM payment_ingresses WHERE id = 'alipay-production'",
					)
					.first(),
			).toEqual({
				rail_code: "alipay",
				provider_environment: "production",
				provider_product: "website",
			});
			expect(
				await db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__new_payment_ingresses'",
					)
					.first(),
			).toBeNull();
			expect(
				await db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'receiving_method_locks_reconcile_after_delete'",
					)
					.first(),
			).not.toBeNull();
			expect(
				(await db.prepare("PRAGMA foreign_key_check").all()).results,
			).toEqual([]);
		} finally {
			await runtime.dispose();
		}
	});

	it("leaves a freshly migrated database valid and idempotent", async () => {
		const runtime = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "alipay-migration-current" },
		});
		try {
			const db = await runtime.getD1Database("DB");
			await applyMigrations(db);
			expect(
				(
					(await db.prepare("PRAGMA table_info(payment_ingresses)").all()) as {
						results: Array<{ name: string }>;
					}
				).results.map(({ name }) => name),
			).toEqual(
				expect.arrayContaining(["provider_environment", "provider_product"]),
			);
			expect(
				(await db.prepare("PRAGMA foreign_key_check").all()).results,
			).toEqual([]);
			await db
				.prepare(
					"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('test-rail', 'Test', 'fiat', 'alipay', 1, 1)",
				)
				.run();
			await db
				.prepare(
					"INSERT INTO payment_ingresses (id, rail_code, name, type, transport, enabled, created_at, updated_at) VALUES ('test-connection', 'test-rail', 'Test', 'provider', 'http', 1, 1, 1)",
				)
				.run();
		} finally {
			await runtime.dispose();
		}
	});
});
