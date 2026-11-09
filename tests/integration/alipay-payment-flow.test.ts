import { createSign, generateKeyPairSync } from "node:crypto";
import { Miniflare } from "miniflare";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { reviewAdminAlipayOrder } from "#/features/orders/server/admin-actions";
import { handleAlipayNotification } from "#/features/payments/server/alipay-notification";
import { loadAlipayProviderForOrder } from "#/features/payments/server/alipay-provider";
import { recordProviderPayment } from "#/features/payments/server/provider-payment";
import { AlipayError } from "#/integrations/payment-rails/alipay";
import { encryptSecret } from "#/lib/secrets";
import { enqueueInitialAlipayPoll } from "#/server/queue/alipay-polling";
import { handlePaymentScan } from "#/server/queue/payment-scan";
import { applyMigrations } from "./migrations";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const appId = "2014072300007148";
const configSecret = "alipay-integration-config-secret";
const orderId = "order-alipay-1";
const paymentQueueSend = vi.fn().mockResolvedValue(undefined);

describe("Alipay D1 payment flow", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let env: Env;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "alipay-payment-flow" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		env = {
			DB: db,
			PAYMENT_QUEUE: { send: paymentQueueSend },
			WEBHOOK_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
		} as unknown as Env;
	});

	afterAll(async () => miniflare.dispose());

	beforeEach(async () => {
		paymentQueueSend.mockClear();
		await seed(db);
	});

	it("settles a valid notification once and ignores a repeat", async () => {
		vi.stubGlobal("fetch", vi.fn().mockImplementation(queryResponse));
		const first = await handleAlipayNotification(
			notification("request-1"),
			env,
		);
		const repeated = await handleAlipayNotification(
			notification("request-2"),
			env,
		);
		expect(first.status).toBe(200);
		expect(repeated.status).toBe(200);
		const state = await db
			.prepare(
				`SELECT o.status, o.received_amount_units,
				 (SELECT COUNT(*) FROM provider_payments WHERE order_id = o.id) AS payments,
				 (SELECT COUNT(*) FROM webhook_events WHERE order_id = o.id) AS events,
				 (SELECT COUNT(*) FROM webhook_deliveries WHERE order_id = o.id) AS deliveries
				 FROM orders o WHERE o.id = ?`,
			)
			.bind(orderId)
			.first();
		expect(state).toEqual({
			status: "paid",
			received_amount_units: "101",
			payments: 1,
			events: 1,
			deliveries: 1,
		});
	});

	it("settles a missed Alipay callback through scheduled status polling", async () => {
		const fetchMock = vi.fn().mockImplementation(queryResponse);
		vi.stubGlobal("fetch", fetchMock);
		const ack = vi.fn();
		const retry = vi.fn();
		const message = {
			id: "alipay-poll-1",
			timestamp: new Date(),
			attempts: 1,
			body: {
				kind: "payment.scan",
				version: 1,
				orderId,
				receivingMethodId: "receiving-alipay",
			},
			ack,
			retry,
		} as unknown as Parameters<typeof handlePaymentScan>[0];

		await handlePaymentScan(message, env);
		expect(ack).toHaveBeenCalledOnce();
		expect(retry).not.toHaveBeenCalled();

		const duplicateAck = vi.fn();
		await handlePaymentScan(
			{
				...message,
				id: "alipay-poll-duplicate",
				ack: duplicateAck,
			},
			env,
		);
		expect(duplicateAck).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledOnce();

		await expect(
			db
				.prepare(
					`SELECT o.status, o.received_amount_units,
					 (SELECT COUNT(*) FROM provider_payments WHERE order_id = o.id) AS payments,
					 (SELECT COUNT(*) FROM webhook_events WHERE order_id = o.id) AS events
					 FROM orders o WHERE o.id = ?`,
				)
				.bind(orderId)
				.first(),
		).resolves.toEqual({
			status: "paid",
			received_amount_units: "101",
			payments: 1,
			events: 1,
		});
	});

	it("reviews and settles a paid historical Alipay order", async () => {
		vi.stubGlobal("fetch", vi.fn().mockImplementation(queryResponse));
		await db
			.prepare("UPDATE orders SET status = 'expired' WHERE id = ?")
			.bind(orderId)
			.run();
		const now = Date.now();
		await db
			.prepare(
				"INSERT OR IGNORE INTO users (id, name, email, email_verified, enabled, created_at, updated_at) VALUES ('admin', 'Admin', 'admin@example.test', 1, 1, ?, ?)",
			)
			.bind(now, now)
			.run();
		const result = await reviewAdminAlipayOrder(
			env,
			orderId,
			{ actorUserId: "admin", requestId: "review-1", ipAddress: null },
			async () => {
				const provider = await loadAlipayProviderForOrder(db, orderId);
				if (!provider) throw new Error("Missing Alipay test provider");
				return provider.queryPaymentWithDiagnostics(orderId);
			},
		);

		expect(result).toMatchObject({
			outcome: "success",
			response: { tradeStatus: "TRADE_SUCCESS", totalAmount: "1.01" },
			localStatus: "paid",
			settlement: { duplicate: false, status: "paid" },
		});
		expect(JSON.stringify(result)).not.toContain("buyer_logon_id");
		await expect(
			db
				.prepare("SELECT status FROM orders WHERE id = ?")
				.bind(orderId)
				.first(),
		).resolves.toEqual({ status: "paid" });
		await expect(
			db
				.prepare(
					"SELECT action, actor_user_id FROM audit_logs WHERE target_id = ? AND action = 'order.alipay_query_reviewed'",
				)
				.bind(orderId)
				.first(),
		).resolves.toEqual({
			action: "order.alipay_query_reviewed",
			actor_user_id: "admin",
		});
	});

	it("returns transport diagnostics in manual Alipay review results", async () => {
		const now = Date.now();
		await db
			.prepare(
				"INSERT OR IGNORE INTO users (id, name, email, email_verified, enabled, created_at, updated_at) VALUES ('admin', 'Admin', 'admin@example.test', 1, 1, ?, ?)",
			)
			.bind(now, now)
			.run();

		const result = await reviewAdminAlipayOrder(
			env,
			orderId,
			{ actorUserId: "admin", requestId: "review-error", ipAddress: null },
			async () => {
				throw new AlipayError(
					"Alipay gateway request failed",
					"network",
					"ALIPAY_GATEWAY_FETCH_FAILED",
					{
						operation: "alipay.trade.query",
						endpointHost: "openapi.alipay.com",
						durationMs: 17,
						errorName: "TypeError",
						causeName: "Error",
						transportCode: "EAI_AGAIN",
						transportMessage: "Temporary DNS resolution error",
					},
				);
			},
		);

		expect(result).toMatchObject({
			outcome: "error",
			response: null,
			error: {
				kind: "network",
				code: "ALIPAY_GATEWAY_FETCH_FAILED",
				operation: "alipay.trade.query",
				endpointHost: "openapi.alipay.com",
				transportCode: "EAI_AGAIN",
				transportMessage: "Temporary DNS resolution error",
			},
		});
	});

	it("starts Alipay polling fifteen seconds after order creation", async () => {
		await enqueueInitialAlipayPoll(db, env.PAYMENT_QUEUE, {
			orderId,
			paymentNetwork: "alipay",
			receivingMethodId: "receiving-alipay",
		});

		expect(paymentQueueSend).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "payment.scan",
				orderId,
				alipayPolling: true,
			}),
			{ delaySeconds: 15 },
		);
		await expect(
			db
				.prepare("SELECT last_payment_scan_at FROM orders WHERE id = ?")
				.bind(orderId)
				.first(),
		).resolves.toMatchObject({ last_payment_scan_at: expect.any(Number) });
	});

	it("retries scheduled Alipay queries when the gateway is unavailable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("gateway unavailable")),
		);
		const ack = vi.fn();
		const retry = vi.fn();
		await handlePaymentScan(
			{
				id: "alipay-poll-failure",
				timestamp: new Date(),
				attempts: 1,
				body: {
					kind: "payment.scan",
					version: 1,
					orderId,
					receivingMethodId: "receiving-alipay",
				},
				ack,
				retry,
			} as unknown as Parameters<typeof handlePaymentScan>[0],
			env,
		);
		expect(ack).not.toHaveBeenCalled();
		expect(retry).toHaveBeenCalledOnce();
		await expect(
			db
				.prepare(
					"SELECT after FROM audit_logs WHERE action = 'payment.scan_failed' AND target_id = ? ORDER BY created_at DESC LIMIT 1",
				)
				.bind(orderId)
				.first<{ after: string }>(),
		).resolves.toMatchObject({
			after: expect.stringContaining("ALIPAY_GATEWAY_FETCH_FAILED"),
		});
		await expect(
			db
				.prepare("SELECT status FROM orders WHERE id = ?")
				.bind(orderId)
				.first(),
		).resolves.toEqual({ status: "pending" });
	});

	it("uses fifteen-second and sixty-second polling intervals", async () => {
		const fetchMock = vi.fn().mockImplementation(
			() =>
				new Response(
					JSON.stringify(
						signedQueryResponse({
							code: "10000",
							msg: "Success",
							out_trade_no: orderId,
							trade_no: "2026103122000000000001",
							trade_status: "WAIT_BUYER_PAY",
						}),
					),
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const retry = vi.fn();
		const ack = vi.fn();
		const message = {
			id: "alipay-poll-pending-1",
			timestamp: new Date(),
			attempts: 1,
			body: {
				kind: "payment.scan",
				version: 1,
				orderId,
				receivingMethodId: "receiving-alipay",
				alipayPolling: true,
			},
			ack,
			retry,
		} as unknown as Parameters<typeof handlePaymentScan>[0];

		await handlePaymentScan(message, env);
		expect(paymentQueueSend).toHaveBeenCalledWith(
			expect.objectContaining({ alipayPolling: true }),
			{ delaySeconds: 15 },
		);
		expect(retry).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledOnce();

		await db
			.prepare("UPDATE orders SET created_at = ? WHERE id = ?")
			.bind(Date.now() - 5 * 60_000, orderId)
			.run();
		paymentQueueSend.mockClear();
		const finalRetry = vi.fn();
		const finalAck = vi.fn();
		await handlePaymentScan(
			{
				...message,
				id: "alipay-poll-pending-final",
				attempts: 4,
				retry: finalRetry,
				ack: finalAck,
			},
			env,
		);
		expect(finalRetry).not.toHaveBeenCalled();
		expect(finalAck).toHaveBeenCalledOnce();
		expect(paymentQueueSend).toHaveBeenCalledWith(
			expect.objectContaining({ alipayPolling: true }),
			{ delaySeconds: 60 },
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("acks queued Alipay polls after the fifteen-minute window", async () => {
		const createdBeforeWindow = Date.now() - 16 * 60_000;
		await db
			.prepare(
				"UPDATE orders SET status = 'expired', created_at = ? WHERE id = ?",
			)
			.bind(createdBeforeWindow, orderId)
			.run();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const ack = vi.fn();
		const retry = vi.fn();

		await handlePaymentScan(
			{
				id: "alipay-poll-past-cutoff",
				timestamp: new Date(),
				attempts: 1,
				body: {
					kind: "payment.scan",
					version: 1,
					orderId,
					receivingMethodId: "receiving-alipay",
				},
				ack,
				retry,
			} as unknown as Parameters<typeof handlePaymentScan>[0],
			env,
		);

		expect(ack).toHaveBeenCalledOnce();
		expect(retry).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a tampered notification before querying", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const callback = signedNotification();
		const response = await handleAlipayNotification(
			formRequest({ ...callback, total_amount: "9.99" }, "tampered"),
			env,
		);
		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
		await expect(
			db
				.prepare(
					"SELECT signature_status, response_status FROM inbound_webhook_receipts WHERE external_request_id = 'tampered'",
				)
				.first(),
		).resolves.toEqual({ signature_status: "invalid", response_status: 401 });
	});

	it("does not settle when the callback and active query disagree", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify(
							signedQueryResponse({
								code: "10000",
								msg: "Success",
								out_trade_no: orderId,
								trade_no: "2026103122000000000002",
								trade_status: "TRADE_SUCCESS",
								total_amount: "1.01",
							}),
						),
					),
			),
		);
		const response = await handleAlipayNotification(
			notification("mismatch"),
			env,
		);
		expect(response.status).toBe(422);
		await expect(
			db
				.prepare("SELECT status FROM orders WHERE id = ?")
				.bind(orderId)
				.first(),
		).resolves.toEqual({ status: "pending" });
	});

	it("records a provider payment idempotently", async () => {
		const payment = {
			providerTradeId: "2026103122000000000001",
			amountMinor: "101",
			currency: "CNY",
			currencyDecimals: 2,
			status: "succeeded" as const,
		};
		await expect(
			recordProviderPayment(env, orderId, "alipay", payment),
		).resolves.toEqual({ duplicate: false, status: "paid" });
		await expect(
			recordProviderPayment(env, orderId, "alipay", payment),
		).resolves.toEqual({ duplicate: true, status: "paid" });
	});
});

function notification(requestId: string) {
	return formRequest(signedNotification(), requestId);
}

function formRequest(input: Record<string, string>, requestId: string) {
	return new Request("https://edge.example/api/providers/alipay/notify", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"x-request-id": requestId,
		},
		body: new URLSearchParams(input).toString(),
	});
}

function signedNotification() {
	const input: Record<string, string> = {
		app_id: appId,
		out_trade_no: orderId,
		trade_no: "2026103122000000000001",
		trade_status: "TRADE_SUCCESS",
		total_amount: "1.01",
		sign_type: "RSA2",
	};
	return {
		...input,
		sign: createSign("RSA-SHA256")
			.update(
				Object.keys(input)
					.sort()
					.map((key) => `${key}=${input[key]}`)
					.join("&"),
				"utf8",
			)
			.sign(privateKey, "base64"),
	};
}

function queryResponse() {
	return new Response(
		JSON.stringify(
			signedQueryResponse({
				code: "10000",
				msg: "Success",
				out_trade_no: orderId,
				trade_no: "2026103122000000000001",
				trade_status: "TRADE_SUCCESS",
				total_amount: "1.01",
				buyer_logon_id: "buyer@example.test",
			}),
		),
	);
}

function signedQueryResponse(data: Record<string, string>) {
	return {
		alipay_trade_query_response: data,
		sign: createSign("RSA-SHA256")
			.update(JSON.stringify(data), "utf8")
			.sign(privateKey, "base64"),
	};
}

async function seed(db: D1Database) {
	await db.batch([
		db.prepare("DELETE FROM webhook_deliveries"),
		db.prepare("DELETE FROM webhook_events"),
		db.prepare("DELETE FROM provider_payments"),
		db.prepare("DELETE FROM inbound_webhook_receipts"),
		db.prepare("DELETE FROM audit_logs"),
		db.prepare("DELETE FROM receiving_method_locks"),
		db.prepare("DELETE FROM order_payments"),
		db.prepare("DELETE FROM order_payment_snapshots"),
		db.prepare("DELETE FROM orders"),
		db.prepare("DELETE FROM receiving_method_assets"),
		db.prepare("DELETE FROM receiving_methods"),
		db.prepare("DELETE FROM payment_ingress_credentials"),
		db.prepare("DELETE FROM payment_ingresses"),
		db.prepare("DELETE FROM payment_assets"),
		db.prepare("DELETE FROM payment_rails"),
		db.prepare("DELETE FROM api_keys"),
		db.prepare("DELETE FROM system_settings"),
	]);
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
		configSecret,
	);
	await db.batch([
		db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.integration_config_secret', ?, 1, ?, ?)",
			)
			.bind(JSON.stringify(configSecret), now, now),
		db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.better_auth_url', ?, 0, ?, ?)",
			)
			.bind(JSON.stringify("https://edge.example"), now, now),
		db
			.prepare(
				"INSERT INTO api_keys (id, name, pid, secret_encrypted, scopes, enabled, created_at, updated_at) VALUES ('key', 'key', '100000000000', 'secret', '[]', 1, ?, ?)",
			)
			.bind(now, now),
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
		db
			.prepare(
				`INSERT INTO orders
				 (id, external_order_id, api_key_id, api_protocol, status, amount_minor,
				  currency, currency_decimals, payment_asset_id, provider_order_id,
				  received_amount_units, notify_url, expires_at, version, created_at, updated_at)
				 VALUES (?, 'external-alipay', 'key', 'gmpay', 'pending', '101',
				  'CNY', 2, 'alipay-cny', ?, '0',
				  'https://merchant.example.test/notify', ?, 0, ?, ?)`,
			)
			.bind(orderId, orderId, now + 900_000, now, now),
		db
			.prepare(
				`INSERT INTO order_payment_snapshots
				 (order_id, receiving_method_id, receiving_method_name, rail_code,
				  rail_kind, asset_id, asset_code, decimals, target_value,
				  connection_id, adapter, required_confirmations,
				  expected_amount_units, created_at)
				 VALUES (?, 'receiving-alipay', 'Alipay account', 'alipay', 'fiat',
				  'alipay-cny', 'CNY', 2, ?, 'connection-alipay', 'alipay', 1,
				  '101', ?)`,
			)
			.bind(orderId, appId, now),
	]);
}
