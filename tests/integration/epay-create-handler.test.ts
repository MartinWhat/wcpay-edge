import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signEpayParameters } from "#/features/api-keys/server/gmpay-signature";
import {
	authenticateEpayInput,
	handleEpayCreateRequest,
	handleEpayQueryRequest,
} from "#/features/orders/server/epay-adapter";
import { encryptSecret } from "#/lib/secrets";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("EPay compatibility HTTP handler", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const pepper = "epay-create-handler-pepper";
	const secret = "merchant-secret";
	const pid = "100000000002";

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-epay-create-handler" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		const now = Date.now();
		const integrationSecret = "epay-integration-secret";
		const { privateKey, publicKey } = await import("node:crypto").then(
			({ generateKeyPairSync }) =>
				generateKeyPairSync("rsa", {
					modulusLength: 2048,
					publicKeyEncoding: { type: "spki", format: "pem" },
					privateKeyEncoding: { type: "pkcs8", format: "pem" },
				}),
		);
		const alipayConfig = await encryptSecret(
			JSON.stringify({
				appId: "2014072300007148",
				privateKey,
				alipayPublicKey: publicKey,
				keyType: "PKCS8",
				endpoint: "https://openapi.alipay.com",
				timeoutMs: 8000,
			}),
			integrationSecret,
		);
		await db.batch([
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.api_key_pepper', ?, 1, ?, ?)",
				)
				.bind(JSON.stringify(pepper), now, now),
			db
				.prepare(
					"INSERT INTO api_keys (id, name, pid, secret_encrypted, scopes, created_at, updated_at) VALUES ('key', 'EPay', ?, ?, '[\"orders:create\",\"orders:read\"]', ?, ?)",
				)
				.bind(pid, await encryptSecret(secret, pepper), now, now),
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.integration_config_secret', ?, 1, ?, ?)",
				)
				.bind(JSON.stringify(integrationSecret), now, now),
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.better_auth_url', ?, 0, ?, ?)",
				)
				.bind(JSON.stringify("https://pay.example"), now, now),
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
					"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, priority, enabled, health_status, created_at, updated_at) VALUES ('connection-alipay', 'alipay', 'Alipay', 'provider', 'https://openapi.alipay.com', 100, 1, 'unknown', ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT INTO payment_ingress_credentials (payment_ingress_id, config_encrypted, created_at, updated_at) VALUES ('connection-alipay', ?, ?, ?)",
				)
				.bind(alipayConfig, now, now),
			db
				.prepare(
					"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('receiving-alipay', 'Alipay account', 'alipay', 'provider', '2014072300007148', '2014072300007148', 1, ?, ?)",
				)
				.bind(now, now),
			db.prepare(
				"DELETE FROM receiving_method_assets WHERE receiving_method_id = 'receiving-alipay'",
			),
			db
				.prepare(
					"INSERT INTO receiving_method_assets (id, receiving_method_id, payment_asset_id, created_at, updated_at) VALUES ('link-alipay', 'receiving-alipay', 'alipay-cny', ?, ?)",
				)
				.bind(now, now),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("rejects a legacy-valid ambiguous signature before order creation", async () => {
		const parameters = {
			pid,
			money: "12.50",
			out_trade_no: "AMBIGUOUS-CALLBACK",
			name: "item",
			notify_url:
				"https://receiver.example/hook&notify_url=https://merchant.example/hook",
		};
		const canonical = Object.entries(parameters)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => `${key}=${value}`)
			.join("&");
		const sign = createHash("md5")
			.update(canonical + secret)
			.digest("hex");
		const response = await handleEpayCreateRequest(
			new Request("https://pay.example/submit.php", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ ...parameters, sign, sign_type: "MD5" }),
			}),
			{ DB: db } as Env,
		);
		expect(response.status).toBe(401);
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS count FROM orders WHERE external_order_id = 'AMBIGUOUS-CALLBACK'",
				)
				.first(),
		).toEqual({ count: 0 });
	});

	it.each([
		{
			name: "a malformed money value",
			overrides: { money: "abc" },
			code: 10004,
		},
		{ name: "a negative money value", overrides: { money: "-5" }, code: 10004 },
		{
			name: "a non-HTTPS notify_url",
			overrides: { notify_url: "http://merchant.example/notify" },
			code: 10009,
		},
	])(
		"rejects $name with a documented 400-class code",
		async ({ name, overrides, code }) => {
			const parameters = {
				pid,
				money: "12.50",
				out_trade_no: `EPAY-INVALID-${name.replaceAll(/\W+/g, "-")}`,
				notify_url: "https://merchant.example/notify",
				...overrides,
			};
			const response = await handleEpayCreateRequest(
				new Request("https://pay.example/submit.php", {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						...parameters,
						sign: signEpayParameters(parameters, secret),
						sign_type: "MD5",
					}),
				}),
				{ DB: db } as Env,
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ status_code: code });
			await expect(
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM orders WHERE external_order_id = ?",
					)
					.bind(parameters.out_trade_no)
					.first(),
			).resolves.toEqual({ count: 0 });
		},
	);

	it("rejects an oversized POST body before authentication", async () => {
		const response = await handleEpayCreateRequest(
			new Request(
				"https://pay.example/payments/epay/v1/order/create-transaction/submit.php",
				{
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						"content-length": String(64 * 1024 + 1),
					},
					body: "pid=invalid",
				},
			),
			{ DB: db } as Env,
		);

		expect(response.status).toBe(413);
	});

	it.each(["GET", "POST"] as const)(
		"adapts a signed %s request into the shared selectable order service",
		async (method) => {
			const counters = createDatastoreCounters();
			const countedDb = instrumentD1(db, counters);
			const parameters = {
				pid,
				money: "20.00",
				out_trade_no: `EPAY-${method}`,
				notify_url: "https://merchant.example/epay-notify",
				return_url: "https://merchant.example/return",
				type: "alipay",
				param: `context-${method.toLowerCase()}`,
				clientip: "203.0.113.10",
				device: "mobile",
			};
			const signed = {
				...parameters,
				sign: signEpayParameters(parameters, secret),
				sign_type: "MD5",
			};
			const encoded = new URLSearchParams(signed).toString();
			const request = new Request(
				`https://pay.example/payments/epay/v1/order/create-transaction/submit.php${
					method === "GET" ? `?${encoded}` : ""
				}`,
				{
					method,
					headers: {
						"x-request-id": `epay-${method.toLowerCase()}`,
						...(method === "POST"
							? { "content-type": "application/x-www-form-urlencoded" }
							: {}),
					},
					body: method === "POST" ? encoded : undefined,
				},
			);
			const response = await handleEpayCreateRequest(request, {
				DB: countedDb,
			} as Env);
			expect(response.status).toBe(200);
			expect(counters.d1Prepare).toBeGreaterThan(0);
			expect(counters.d1Batch).toBeGreaterThan(0);
			expect(response.headers.get("x-request-id")).toBe(
				`epay-${method.toLowerCase()}`,
			);
			const body = await response.json<{
				data: { trade_id: string; payment_url: string };
			}>();
			expect(body.data.payment_url).toBe(
				`https://pay.example/checkout/${body.data.trade_id}`,
			);
			const orderId = body.data.trade_id;
			const order = await db
				.prepare(
					"SELECT api_protocol, payment_asset_id, return_url, metadata FROM orders WHERE id = ?",
				)
				.bind(orderId)
				.first<{
					api_protocol: string;
					payment_asset_id: string | null;
					metadata: string;
					return_url: string;
				}>();
			expect(order?.api_protocol).toBe("epay");
			expect(order?.payment_asset_id).toBe("alipay-cny");
			expect(order?.return_url).toBe(
				`https://merchant.example/return?param=context-${method.toLowerCase()}`,
			);
			expect(JSON.parse(order?.metadata ?? "{}")).toEqual({
				integration: "epay",
				epayType: "alipay",
				epayParam: `context-${method.toLowerCase()}`,
			});
		},
	);

	it("returns Pro-compatible mapi data and returns param from order queries", async () => {
		const parameters = {
			pid,
			money: "30.00",
			out_trade_no: "EPAY-PRO-COMPAT",
			notify_url: "https://merchant.example/epay-notify",
			return_url: "https://merchant.example/return?source=plugin",
			type: "alipay",
			param: "opaque merchant context",
			clientip: "203.0.113.20",
			device: "pc",
		};
		const signed = {
			...parameters,
			sign: signEpayParameters(parameters, secret),
			sign_type: "MD5",
		};
		const createResponse = await handleEpayCreateRequest(
			new Request(
				"https://pay.example/payments/epay/v1/order/create-transaction/mapi.php",
				{
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams(signed),
				},
			),
			{ DB: db } as Env,
			undefined,
			"mapi",
		);
		expect(createResponse.status).toBe(200);
		const created = await createResponse.json<{
			code: number;
			trade_no: string;
			payurl: string;
			qrcode: string;
			img: string;
			param: string;
		}>();
		expect(created).toMatchObject({
			code: 1,
			payurl: `https://pay.example/checkout/${created.trade_no}`,
			qrcode: `https://pay.example/checkout/${created.trade_no}`,
			img: `https://pay.example/checkout/${created.trade_no}`,
			param: "opaque merchant context",
		});

		const queryParameters = {
			act: "order",
			pid,
			out_trade_no: parameters.out_trade_no,
		};
		const query = {
			...queryParameters,
			sign: signEpayParameters(queryParameters, secret),
			sign_type: "MD5",
		};
		const queryResponse = await handleEpayQueryRequest(
			new Request(
				`https://pay.example/payments/epay/v1/order/create-transaction/api.php?${new URLSearchParams(query)}`,
			),
			{ DB: db } as Env,
		);
		expect(queryResponse.status).toBe(200);
		expect(await queryResponse.json()).toMatchObject({
			code: 1,
			trade_no: created.trade_no,
			out_trade_no: "EPAY-PRO-COMPAT",
			type: "alipay",
			money: "30",
			status: 0,
			trade_status: "WAIT_BUYER_PAY",
			param: "opaque merchant context",
		});
	});

	it("rejects unsupported payment types at the input boundary", async () => {
		const counters = createDatastoreCounters();
		const response = await handleEpayCreateRequest(
			new Request(
				"https://pay.example/payments/epay/v1/order/create-transaction/submit.php?pid=merchant&money=1.00&out_trade_no=invalid&type=unsupported&notify_url=https%3A%2F%2Fmerchant.example%2Fnotify&sign=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			),
			{ DB: instrumentD1(db, counters) } as Env,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			status_code: 10009,
			message: "invalid parameters",
		});
		expect(counters).toEqual(createDatastoreCounters());
	});

	it("rejects disabled credentials and accepts them again after re-enabling", async () => {
		const parameters = {
			pid,
			money: "20.00",
			out_trade_no: "EPAY-ENABLED-STATE",
			notify_url: "https://merchant.example/epay-notify",
			type: "alipay",
		};
		const input = {
			...parameters,
			sign: signEpayParameters(parameters, secret),
			sign_type: "MD5" as const,
		};
		await db.prepare("UPDATE api_keys SET enabled = 0 WHERE id = 'key'").run();
		await expect(authenticateEpayInput(db, input)).resolves.toBeNull();
		await db.prepare("UPDATE api_keys SET enabled = 1 WHERE id = 'key'").run();
		await expect(authenticateEpayInput(db, input)).resolves.toMatchObject({
			apiKeyId: "key",
			pid,
		});
	});

	it("does not expose unknown database or provider failures", async () => {
		const parameters = {
			pid,
			money: "20.00",
			out_trade_no: "EPAY-UNKNOWN-FAILURE",
			notify_url: "https://merchant.example/epay-notify",
			type: "alipay",
		};
		const signed = {
			...parameters,
			sign: signEpayParameters(parameters, secret),
			sign_type: "MD5",
		};
		const response = await handleEpayCreateRequest(
			new Request(
				`https://pay.example/payments/epay/v1/order/create-transaction/submit.php?${new URLSearchParams(signed)}`,
			),
			{ DB: db } as Env,
			async () => {
				throw new Error("D1_ERROR: token=unsafe provider.internal");
			},
		);
		expect(response.status).toBe(500);
		const body = await response.json<{
			status_code: number;
			message: string;
		}>();
		expect(body).toMatchObject({ status_code: 500, message: "system error" });
		expect(JSON.stringify(body)).not.toContain("unsafe");
	});
});
