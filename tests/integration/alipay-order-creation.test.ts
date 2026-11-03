import { createSign, generateKeyPairSync } from "node:crypto";
import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	listCheckoutPaymentOptions,
	selectCheckoutPaymentOption,
} from "#/features/checkout/server/payment-options";
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

	afterEach(() => vi.unstubAllGlobals());

	it("keeps CNY minor units without an exchange quote and stores the signed payment URL", async () => {
		await setReceivingMethodProduct(db, "website");
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

	it("routes sandbox face-to-face payments and stores QR separately from the target snapshot", async () => {
		await setReceivingMethodProduct(db, "face_to_face");
		await expect(
			createOrder(
				db,
				{
					externalOrderId: "alipay-sandbox-website-not-enabled",
					amount: "1.01",
					currency: "CNY",
					paymentAsset: "CNY",
					paymentNetwork: "alipay",
					alipayProduct: "website",
				},
				"https://pay.example.test",
			),
		).rejects.toMatchObject({ code: "receiving_method_not_found" });
		const qrCode = "https://qr.alipay.com/sandbox-face-to-face";
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const endpoint = new URL(String(input));
				expect(endpoint.origin).toBe(
					"https://openapi-sandbox.dl.alipaydev.com",
				);
				const requestBody = new URLSearchParams(String(init?.body));
				expect(requestBody.get("method")).toBe("alipay.trade.precreate");
				const bizContent = requestBody.get("biz_content");
				if (!bizContent) throw new Error("Alipay business content is missing");
				const requestData: unknown = JSON.parse(bizContent);
				if (
					!requestData ||
					typeof requestData !== "object" ||
					!("out_trade_no" in requestData) ||
					typeof requestData.out_trade_no !== "string"
				)
					throw new Error("Alipay order ID is missing");
				const data = {
					code: "10000",
					msg: "Success",
					out_trade_no: requestData.out_trade_no,
					qr_code: qrCode,
				};
				const signature = createSign("RSA-SHA256")
					.update(JSON.stringify(data))
					.sign(privateKey, "base64");
				return new Response(
					JSON.stringify({
						alipay_trade_precreate_response: data,
						sign: signature,
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const order = await createOrder(
			db,
			{
				externalOrderId: "alipay-sandbox-face-to-face-001",
				amount: "2.35",
				currency: "CNY",
				paymentAsset: "CNY",
				paymentNetwork: "alipay",
				alipayEnvironment: "sandbox",
				alipayProduct: "face_to_face",
			},
			"https://pay.example.test",
		);
		const stored = await db
			.prepare(
				"SELECT o.provider_order_id, o.payment_url, snapshot.connection_id, snapshot.target_value FROM orders o JOIN order_payment_snapshots snapshot ON snapshot.order_id = o.id AND snapshot.rail_code = 'alipay' WHERE o.id = ?",
			)
			.bind(order.orderId)
			.first<{
				provider_order_id: string | null;
				payment_url: string | null;
				connection_id: string;
				target_value: string;
			}>();

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(stored).toEqual({
			provider_order_id: order.orderId,
			payment_url: qrCode,
			connection_id: "connection-alipay-sandbox-face-to-face",
			target_value: appId,
		});
	});

	it("offers only the selected Alipay product and initializes that checkout route", async () => {
		await setReceivingMethodProduct(db, "face_to_face");
		const order = await createOrder(
			db,
			{
				externalOrderId: "alipay-checkout-select-001",
				amount: "2.35",
				currency: "CNY",
			},
			"https://pay.example.test",
		);
		const listed = await listCheckoutPaymentOptions(db, order.orderId);
		expect(listed?.options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					alipayEnvironment: "production",
					alipayProduct: "face_to_face",
				}),
				expect.objectContaining({
					alipayEnvironment: "sandbox",
					alipayProduct: "face_to_face",
				}),
			]),
		);
		expect(
			listed?.options.some((option) => option.alipayProduct === "website"),
		).toBe(false);
		await expect(
			selectCheckoutPaymentOption(db, {
				orderId: order.orderId,
				receivingMethodId: "receiving-alipay",
				paymentMethodId: "alipay-cny",
				alipayEnvironment: "sandbox",
				alipayProduct: "website",
			}),
		).rejects.toMatchObject({ code: "payment_option_unavailable" });

		const qrCode = "https://qr.alipay.com/checkout-sandbox-face-to-face";
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(new URL(String(input)).origin).toBe(
					"https://openapi-sandbox.dl.alipaydev.com",
				);
				const requestBody = new URLSearchParams(String(init?.body));
				expect(requestBody.get("method")).toBe("alipay.trade.precreate");
				const bizContent = requestBody.get("biz_content");
				if (!bizContent) throw new Error("Alipay business content is missing");
				const requestData: unknown = JSON.parse(bizContent);
				if (
					!requestData ||
					typeof requestData !== "object" ||
					!("out_trade_no" in requestData) ||
					typeof requestData.out_trade_no !== "string"
				)
					throw new Error("Alipay order ID is missing");
				const data = {
					code: "10000",
					msg: "Success",
					out_trade_no: requestData.out_trade_no,
					qr_code: qrCode,
				};
				const signature = createSign("RSA-SHA256")
					.update(JSON.stringify(data))
					.sign(privateKey, "base64");
				return new Response(
					JSON.stringify({
						alipay_trade_precreate_response: data,
						sign: signature,
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			selectCheckoutPaymentOption(db, {
				orderId: order.orderId,
				receivingMethodId: "receiving-alipay",
				paymentMethodId: "alipay-cny",
				alipayEnvironment: "sandbox",
				alipayProduct: "face_to_face",
			}),
		).resolves.toMatchObject({ asset: "CNY", network: "alipay" });

		const stored = await db
			.prepare(
				"SELECT o.provider_order_id, o.payment_url, snapshot.connection_id FROM orders o JOIN order_payment_snapshots snapshot ON snapshot.order_id = o.id AND snapshot.rail_code = 'alipay' WHERE o.id = ?",
			)
			.bind(order.orderId)
			.first<{
				provider_order_id: string | null;
				payment_url: string | null;
				connection_id: string;
			}>();
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(stored).toEqual({
			provider_order_id: order.orderId,
			payment_url: qrCode,
			connection_id: "connection-alipay-sandbox-face-to-face",
		});
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
	const sandboxEncrypted = await encryptSecret(
		JSON.stringify({
			appId,
			privateKey,
			alipayPublicKey: publicKey,
			keyType: "PKCS8",
			endpoint: "https://openapi-sandbox.dl.alipaydev.com",
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
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, priority, enabled, health_status, provider_environment, provider_product, created_at, updated_at) VALUES ('connection-alipay-sandbox-face-to-face', 'alipay', 'Alipay sandbox face-to-face', 'provider', 'https://openapi-sandbox.dl.alipaydev.com', 50, 1, 'unknown', 'sandbox', 'face_to_face', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingress_credentials (payment_ingress_id, config_encrypted, created_at, updated_at) VALUES ('connection-alipay-sandbox-face-to-face', ?, ?, ?)",
			)
			.bind(sandboxEncrypted, now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, priority, enabled, health_status, provider_environment, provider_product, created_at, updated_at) VALUES ('connection-alipay-production-face-to-face', 'alipay', 'Alipay production face-to-face', 'provider', 'https://openapi.alipay.com', 25, 1, 'unknown', 'production', 'face_to_face', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingress_credentials (payment_ingress_id, config_encrypted, created_at, updated_at) VALUES ('connection-alipay-production-face-to-face', ?, ?, ?)",
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

async function setReceivingMethodProduct(
	db: D1Database,
	product: "website" | "face_to_face",
) {
	await db
		.prepare("UPDATE receiving_methods SET target_metadata = ? WHERE id = ?")
		.bind(JSON.stringify({ appId, product }), "receiving-alipay")
		.run();
}
