import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrder } from "#/features/orders/server/create";
import { getOrder } from "#/features/orders/server/query";
import { applyMigrations } from "./migrations";

describe("merchant order service on D1", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-order-service" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("creates an awaiting-selection order when no receiving method is specified", async () => {
		const created = await createOrder(
			db,
			{
				externalOrderId: "awaiting-payment-method",
				amount: "25.00",
				currency: "USD",
				expiresInMs: 900_000,
			},
			"https://pay.example.test/payments/gmpay/v1/order/create-transaction",
		);
		expect(created).toMatchObject({
			externalOrderId: "awaiting-payment-method",
			status: "pending",
			amount: "25.00",
			currency: "USD",
		});
		expect(created.receivingMethodId).toBeUndefined();
		expect(created.paymentAmount).toBeUndefined();
		const stored = await db
			.prepare("SELECT payment_asset_id FROM orders WHERE id = ?")
			.bind(created.orderId)
			.first<Record<string, string | null>>();
		expect(stored).toEqual({ payment_asset_id: null });
		await expect(
			createOrder(
				db,
				{
					externalOrderId: "awaiting-payment-method",
					amount: "25.00",
					currency: "USD",
				},
				"https://pay.example.test",
			),
		).rejects.toMatchObject({
			code: "external_order_exists",
			status: 409,
		});
		await expect(
			getOrder(
				db,
				{ id: created.orderId },
				"https://pay.example.test/payments/gmpay/v1/order/create-transaction",
			),
		).resolves.toMatchObject({ orderId: created.orderId, status: "pending" });
	});

	it("marks test orders and rejects merchant payment callbacks", async () => {
		const created = await createOrder(
			db,
			{
				externalOrderId: "admin-test-order",
				amount: "25.00",
				currency: "USD",
			},
			"https://pay.example.test",
			{ isTest: true },
		);
		const stored = await db
			.prepare(
				`SELECT is_test, api_key_id, notify_url, payment_asset_id,
				 (SELECT COUNT(*) FROM order_payment_snapshots WHERE order_id = orders.id) AS snapshots
				 FROM orders WHERE id = ?`,
			)
			.bind(created.orderId)
			.first();
		expect(stored).toEqual({
			is_test: 1,
			api_key_id: null,
			notify_url: null,
			payment_asset_id: null,
			snapshots: 0,
		});

		await expect(
			createOrder(
				db,
				{
					externalOrderId: "admin-test-order-with-callback",
					amount: "25.00",
					currency: "USD",
					notifyUrl: "https://merchant.example/notify",
				},
				"https://pay.example.test",
				{ isTest: true },
			),
		).rejects.toMatchObject({
			code: "test_order_payment_not_allowed",
			status: 422,
		});
	});

	it("creates a target lock and snapshot, and queries the order", async () => {
		const created = await createOrder(
			db,
			{
				externalOrderId: "checkout-1001",
				amount: "12.340000",
				currency: "USD",
				paymentAsset: "USDT",
				paymentNetwork: "tron",
				expiresInMs: 900_000,
				description: "Integration order",
				metadata: { cart: "1001" },
			},
			"https://pay.example.test/payments/gmpay/v1/order/create-transaction",
		);
		expect(created).toMatchObject({
			externalOrderId: "checkout-1001",
			status: "pending",
			paymentAmount: "12.34",
			paymentAsset: "USDT",
			paymentNetwork: "tron",
			receiveAddress: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj",
		});
		expect(created.checkoutUrl).toBe(
			`https://pay.example.test/checkout/${created.orderId}`,
		);
		const own = await getOrder(
			db,
			{ id: created.orderId },
			"https://pay.example.test/payments/gmpay/v1/order/create-transaction",
		);
		expect(own).toMatchObject({
			orderId: created.orderId,
			receiveAddress: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj",
		});
		const allocation = await db
			.prepare(
				`SELECT ops.receiving_method_id, ops.target_value, ptl.released_at
				 FROM order_payment_snapshots ops
				 JOIN receiving_method_locks ptl ON ptl.order_id = ops.order_id
				 WHERE ops.order_id = ?`,
			)
			.bind(created.orderId)
			.first<{
				receiving_method_id: string;
				target_value: string;
				released_at: number | null;
			}>();
		expect(allocation).toEqual({
			receiving_method_id: "asset",
			target_value: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj",
			released_at: null,
		});
	});

	it("rejects a duplicate external order ID", async () => {
		await expect(
			createOrder(
				db,
				{
					externalOrderId: "checkout-1001",
					amount: "1.000000",
					currency: "USD",
					paymentAsset: "USDT",
					paymentNetwork: "tron",
					expiresInMs: 900_000,
				},
				"https://pay.example.test/payments/gmpay/v1/order/create-transaction",
			),
		).rejects.toMatchObject({
			code: "external_order_exists",
			status: 409,
		});
	});

	it("allows the same external order ID for different API credentials", async () => {
		const input = {
			externalOrderId: "credential-scoped-order",
			amount: "1.00",
			currency: "USD",
		};
		await expect(
			createOrder(db, input, "https://pay.example.test", {
				apiKeyId: "api-key-a",
			}),
		).resolves.toMatchObject({ externalOrderId: input.externalOrderId });
		await expect(
			createOrder(db, input, "https://pay.example.test", {
				apiKeyId: "api-key-b",
			}),
		).resolves.toMatchObject({ externalOrderId: input.externalOrderId });
		await expect(
			createOrder(db, input, "https://pay.example.test", {
				apiKeyId: "api-key-a",
			}),
		).rejects.toMatchObject({ code: "external_order_exists", status: 409 });
	});

	it("uses the newest valid exchange rate and rounds the payment amount up", async () => {
		const created = await createOrder(
			db,
			{
				externalOrderId: "rated-order",
				amount: "100.00",
				currency: "EUR",
				paymentAsset: "USDT",
				paymentNetwork: "tron",
				expiresInMs: 900_000,
			},
			"https://pay.example.test/payments/gmpay/v1/order/create-transaction",
		);
		expect(created.paymentAmount).toBe("33.3334");
	});

	it("enforces the configured maximum order expiry", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('orders.default_expiry_ms', '300000', 0, 0, 0)",
			),
			db.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('orders.max_expiry_ms', '600000', 0, 0, 0)",
			),
		]);
		await expect(
			createOrder(
				db,
				{
					externalOrderId: "expiry-too-long",
					amount: "1.00",
					currency: "USD",
					paymentAsset: "USDT",
					paymentNetwork: "tron",
					expiresInMs: 601_000,
				},
				"https://pay.example.test/payments/gmpay/v1/order/create-transaction",
			),
		).rejects.toMatchObject({ code: "expiry_exceeds_limit", status: 422 });
		await db
			.prepare(
				"DELETE FROM system_settings WHERE key IN ('orders.default_expiry_ms','orders.max_expiry_ms')",
			)
			.run();
	});

	it("uses the fixed order expiry in immediate release mode", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('orders.immediate_release_mode', 'true', 0, 0, 0)",
			),
			db.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('orders.fixed_expiry_ms', '120000', 0, 0, 0)",
			),
		]);
		const created = await createOrder(
			db,
			{
				externalOrderId: "fixed-expiry-order",
				amount: "1.00",
				currency: "USD",
				paymentAsset: "USDT",
				paymentNetwork: "tron",
				expiresInMs: 600_000,
			},
			"https://pay.example.test/payments/gmpay/v1/order/create-transaction",
		);
		const stored = await db
			.prepare(
				"SELECT expires_at - created_at AS lifetime FROM orders WHERE id = ?",
			)
			.bind(created.orderId)
			.first<{ lifetime: number }>();
		expect(stored?.lifetime).toBe(120_000);
		await db
			.prepare(
				"DELETE FROM system_settings WHERE key IN ('orders.immediate_release_mode','orders.fixed_expiry_ms')",
			)
			.run();
	});

	it("serializes concurrent allocation with visibly distinct amounts", async () => {
		const create = (externalOrderId: string) =>
			createOrder(
				db,
				{
					externalOrderId,
					amount: "2.000000",
					currency: "USD",
					paymentAsset: "USDT",
					paymentNetwork: "tron",
					expiresInMs: 900_000,
				},
				"https://pay.example.test/payments/gmpay/v1/order/create-transaction",
			);
		const outcomes = await Promise.allSettled([
			create("concurrent-a"),
			create("concurrent-b"),
		]);
		expect(
			outcomes.filter((outcome) => outcome.status === "fulfilled"),
		).toHaveLength(2);
		const reserved = await db
			.prepare(
				`SELECT COUNT(*) AS count FROM receiving_method_locks
				 WHERE expected_amount_units = '2000000' AND released_at IS NULL`,
			)
			.first<{ count: number }>();
		expect(reserved?.count).toBe(1);
		const locks = await db
			.prepare(
				`SELECT expected_amount_units FROM receiving_method_locks WHERE released_at IS NULL AND expected_amount_units IN ('2000000', '2000100') ORDER BY expected_amount_units`,
			)
			.all<{ expected_amount_units: string }>();
		expect(locks.results.map((lock) => lock.expected_amount_units)).toEqual([
			"2000000",
			"2000100",
		]);
	});
});

async function seed(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT INTO api_keys (id, name, pid, secret_encrypted, scopes, created_at, updated_at) VALUES ('api-key-a', 'API A', 'api_a', 'secret', '[]', ?, ?), ('api-key-b', 'API B', 'api_b', 'secret', '[]', ?, ?)",
			)
			.bind(now, now, now, now),
		db
			.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, contract_address, decimals, created_at, updated_at) VALUES ('asset', 'tron', 'USDT', 'USDT', 'token', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', 6, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, priority, enabled, health_status, created_at, updated_at) VALUES ('connection-tron', 'tron', 'TronGrid', 'rpc', 'https://api.trongrid.io', 1, 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 2, created_at = ?, updated_at = ? WHERE id = 'asset'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, sort_order, enabled, created_at, updated_at) VALUES ('asset', 'Primary USDT', 'tron', 'address', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', 1, 1, ?, ?)",
			)
			.bind(now, now),
		db.prepare(
			"UPDATE receiving_methods SET min_amount_minor = '1', max_amount_minor = '999999999999' WHERE id = 'asset'",
		),
		db
			.prepare(
				"INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at, created_at, updated_at) VALUES ('rate-usdt-eur', 'fiat', 'USDT', 'EUR', '3.000000', '3.000000', 'test', 0, ?, ?, ?, ?)",
			)
			.bind(now, now + 60_000, now, now),
	]);
}
