import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AlipayProvider } from "#/integrations/payment-rails/alipay";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const config = {
	appId: "2014072300007148",
	privateKey,
	alipayPublicKey: publicKey,
	keyType: "PKCS8" as const,
	endpoint: "https://openapi.alipay.com",
	timeoutMs: 8000,
};

describe("AlipayProvider", () => {
	it("creates a signed website payment URL for CNY minor units", async () => {
		const provider = await AlipayProvider.create(config);
		const result = await provider.createHostedPayment({
			orderId: "order-001",
			amountMinor: "101",
			currency: "CNY",
			currencyDecimals: 2,
			description: "Test order",
			notifyUrl: "https://pay.example.test/api/providers/alipay/notify",
			returnUrl: "https://merchant.example.test/return",
		});
		if (!result.paymentUrl) throw new Error("Website payment URL is missing");
		const url = new URL(result.paymentUrl);
		expect(result.providerOrderId).toBe("order-001");
		expect(url.origin).toBe("https://openapi.alipay.com");
		expect(url.searchParams.get("method")).toBe("alipay.trade.page.pay");
		expect(url.searchParams.get("biz_content")).toContain(
			'"total_amount":"1.01"',
		);
		expect(url.searchParams.get("sign")).toMatch(/^[A-Za-z0-9+/]+=*$/);
	});

	it("verifies a valid callback and rejects a changed amount", async () => {
		const provider = await AlipayProvider.create(config);
		const callback = signedNotification({
			app_id: config.appId,
			out_trade_no: "order-001",
			trade_no: "2026103122000000000001",
			trade_status: "TRADE_SUCCESS",
			total_amount: "1.01",
			sign_type: "RSA2",
		});
		expect(provider.verifyNotification(callback)).toBe(true);
		expect(
			provider.verifyNotification({ ...callback, total_amount: "9.99" }),
		).toBe(false);
		expect(provider.parseNotification(callback)).toEqual({
			providerTradeId: "2026103122000000000001",
			amountMinor: "101",
			currency: "CNY",
			currencyDecimals: 2,
			status: "succeeded",
		});
	});

	it("queries the gateway through fetch and verifies the response signature", async () => {
		const response = signedQueryResponse(
			{
				code: "10000",
				msg: "Success",
				buyer_logon_id: "***@example.com",
				out_trade_no: "order-001",
				trade_no: "2026103122000000000001",
				trade_status: "TRADE_SUCCESS",
				total_amount: "1.01",
			},
			privateKey,
		);
		const fetcher = vi.fn(async () => new Response(JSON.stringify(response)));
		const provider = await AlipayProvider.create(config, fetcher);
		await expect(provider.queryPayment("order-001")).resolves.toEqual({
			providerTradeId: "2026103122000000000001",
			amountMinor: "101",
			currency: "CNY",
			currencyDecimals: 2,
			status: "succeeded",
		});
		expect(fetcher).toHaveBeenCalledWith(
			"https://openapi.alipay.com/gateway.do",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("method=alipay.trade.query"),
			}),
		);
	});

	it("leaves an unpaid transaction pending", async () => {
		const response = signedQueryResponse(
			{
				code: "10000",
				msg: "Success",
				out_trade_no: "order-001",
				trade_no: "2026103122000000000001",
				trade_status: "WAIT_BUYER_PAY",
			},
			privateKey,
		);
		const provider = await AlipayProvider.create(
			config,
			vi.fn(async () => new Response(JSON.stringify(response))),
		);
		await expect(provider.queryPayment("order-001")).resolves.toMatchObject({
			status: "pending",
		});
	});
	it("creates a signed face-to-face QR payment", async () => {
		const data = {
			code: "10000",
			msg: "Success",
			out_trade_no: "order-002",
			qr_code: "https://qr.alipay.com/test-code",
		};
		const response = {
			alipay_trade_precreate_response: data,
			sign: createSign("RSA-SHA256")
				.update(JSON.stringify(data), "utf8")
				.sign(privateKey, "base64"),
		};
		const fetcher = vi.fn(async () => new Response(JSON.stringify(response)));
		const provider = await AlipayProvider.create(config, fetcher);

		await expect(
			provider.createHostedPayment({
				orderId: "order-002",
				amountMinor: "101",
				currency: "CNY",
				currencyDecimals: 2,
				description: "Test order",
				notifyUrl: "https://pay.example.test/api/providers/alipay/notify",
				product: "face_to_face",
			}),
		).resolves.toEqual({
			providerOrderId: "order-002",
			qrCode: "https://qr.alipay.com/test-code",
		});
		expect(fetcher).toHaveBeenCalledWith(
			"https://openapi.alipay.com/gateway.do",
			expect.objectContaining({
				body: expect.stringContaining("method=alipay.trade.precreate"),
			}),
		);
	});
});

function signedNotification(input: Record<string, string>) {
	const signString = Object.keys(input)
		.sort()
		.map((key) => `${key}=${input[key]}`)
		.join("&");
	return {
		...input,
		sign: createSign("RSA-SHA256")
			.update(signString, "utf8")
			.sign(privateKey, "base64"),
	};
}

function signedQueryResponse(data: Record<string, string>, key: string) {
	return {
		alipay_trade_query_response: data,
		sign: createSign("RSA-SHA256")
			.update(JSON.stringify(data), "utf8")
			.sign(key, "base64"),
	};
}
