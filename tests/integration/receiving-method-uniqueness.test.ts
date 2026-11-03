import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrations";

describe("receiving method target uniqueness", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "receiving-method-uniqueness" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('alipay', 'Alipay', 'fiat', 'alipay', 1, 1), ('test-rail', 'Test rail', 'wallet', 'test', 1, 1)",
			)
			.run();
	});

	afterAll(async () => {
		await miniflare.dispose();
	});

	it("allows one receiving method per Alipay product for an App ID", async () => {
		const insert = db.prepare(
			`INSERT INTO receiving_methods
			 (id, name, rail_code, target_type, target_value,
			  normalized_target_value, target_metadata, enabled, created_at, updated_at)
			 VALUES (?, ?, 'alipay', 'provider', 'sandbox-app-id',
			  'sandbox-app-id', ?, 1, 1, 1)`,
		);

		await insert
			.bind("website-method", "Alipay website", '{"product":"website"}')
			.run();
		await insert
			.bind(
				"face-to-face-method",
				"Alipay face-to-face",
				'{"product":"face_to_face"}',
			)
			.run();

		await expect(
			insert
				.bind("duplicate-website-method", "Duplicate", '{"product":"website"}')
				.run(),
		).rejects.toThrow(/UNIQUE constraint failed/);
	});

	it("keeps duplicate targets disallowed for other rails", async () => {
		const insert = db.prepare(
			`INSERT INTO receiving_methods
			 (id, name, rail_code, target_type, target_value,
			  normalized_target_value, enabled, created_at, updated_at)
			 VALUES (?, 'Test wallet', 'test-rail', 'account', 'same-target',
			  'same-target', 1, 1, 1)`,
		);

		await insert.bind("wallet-method").run();
		await expect(insert.bind("duplicate-wallet-method").run()).rejects.toThrow(
			/UNIQUE constraint failed/,
		);
	});
});
