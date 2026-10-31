import { generateKeyPairSync } from "node:crypto";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOrder } from "#/features/orders/server/create";
import { encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const appId = "2014072300007148";
const secret = "alipay-order-creation-secret";

describe("Alipay order creation", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "alipay-order-creation" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => {
		vi.unstubAllGlobals();
		await miniflare.dispose();
	});

	it("keeps CNY minor units without an exchange quote and stores the signed payment URL", async () => {
		const order = await createOrder(
			db,
			{
				externalOrderId: "alipay-order-001",
				amount: "1.01",
				currency: "CNY",
				paymentAsset: "CNY",
				paymentNetwork: "alipay",
			},
			"https://pay.example.test",
		);
		expect(order).toMatchObject({
			amount: "1.01",
			currency: "CNY",
			paymentAmount: "1.01",
			paymentAsset: "CNY",
			paymentNetwork: "alipay",
		});
		const stored = await db
			.prepare("SELECT provider_order_id, payment_url FROM orders WHERE id = ?")
			.bind(order.orderId)
			.first<{ provider_order_id: string; payment_url: string }>();
		expect(stored?.provider_order_id).toBe(order.orderId);
		expect(stored?.payment_url).toContain(
			"https://openapi.alipay.com/gateway.do?",
		);
		expect(new URL(stored?.payment_url ?? "").searchParams.get("method")).toBe(
			"alipay.trade.page.pay",
		);
		expect(
			new URL(stored?.payment_url ?? "").searchParams.get("biz_content"),
		).toContain('"total_amount":"1.01"');
	});

	it("rejects non-CNY Alipay orders at the input boundary", async () => {
		await expect(
			createOrder(
				db,
				{
					externalOrderId: "alipay-order-usd",
					amount: "1.01",
					currency: "USD",
					paymentAsset: "CNY",
					paymentNetwork: "alipay",
				},
				"https://pay.example.test",
			),
		).rejects.toMatchObject({ code: "currency_not_supported" });
	});
});

async function seed(db: D1Database) {
	const now = Date.now();
	const encrypted = await encryptSecret(
		JSON.stringify({
			appId,
			privateKey,
			alipayPublicKey: publicKey,
			keyType: "PKCS8",
			endpoint: "https://openapi.alipay.com",
			timeoutMs: 8000,
		}),
		secret,
	);
	await db.batch([
		db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.integration_config_secret', ?, 1, ?, ?)",
			)
			.bind(JSON.stringify(secret), now, now),
		db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.better_auth_url', ?, 0, ?, ?)",
			)
			.bind(JSON.stringify("https://pay.example.test"), now, now),
		db
			.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('alipay', 'Alipay', 'fiat', 'alipay', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, default_confirmations, created_at, updated_at) VALUES ('alipay-cny', 'alipay', 'CNY', 'CNY', 'fiat', 2, 1, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, enabled, health_status, created_at, updated_at) VALUES ('connection-alipay', 'alipay', 'Alipay', 'provider', 'https://openapi.alipay.com', 1, 'unknown', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingress_credentials (payment_ingress_id, config_encrypted, created_at, updated_at) VALUES ('connection-alipay', ?, ?, ?)",
			)
			.bind(encrypted, now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('receiving-alipay', 'Alipay account', 'alipay', 'provider', ?, ?, 1, ?, ?)",
			)
			.bind(appId, appId, now, now),
		db.prepare(
			"DELETE FROM receiving_method_assets WHERE receiving_method_id = 'receiving-alipay'",
		),
		db
			.prepare(
				"INSERT INTO receiving_method_assets (id, receiving_method_id, payment_asset_id, created_at, updated_at) VALUES ('link-alipay', 'receiving-alipay', 'alipay-cny', ?, ?)",
			)
			.bind(now, now),
	]);
}
