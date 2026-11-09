import { describe, expect, it } from "vitest";
import {
	isPublicApiRequest,
	isSameOriginRequest,
} from "#/server/api-boundaries";

const orderId = "26071306234512345678";
const telegramBotId = "11111111-1111-4111-8111-111111111111";

describe("signed and checkout public API boundaries", () => {
	it("only exposes the exact provider and Telegram webhook shapes", () => {
		expect(publicRequest("/api/providers/alipay/notify", "POST")).toBe(true);
		expect(publicRequest("/api/providers/alipay/notify", "GET")).toBe(false);
		expect(publicRequest("/api/providers/okpay/notify", "POST")).toBe(true);
		expect(publicRequest("/api/providers/okpay/notify", "GET")).toBe(false);
		expect(
			publicRequest(`/api/providers/alchemy/${telegramBotId}`, "POST"),
		).toBe(true);
		expect(
			publicRequest(`/api/providers/alchemy/${telegramBotId}`, "GET"),
		).toBe(false);
		expect(publicRequest("/api/providers/alchemy/not-a-uuid", "POST")).toBe(
			false,
		);
		expect(
			publicRequest(`/api/telegram/${telegramBotId}/webhook`, "POST"),
		).toBe(true);
		expect(publicRequest(`/api/telegram/${telegramBotId}/webhook`, "GET")).toBe(
			false,
		);
		expect(publicRequest("/api/telegram/not-a-uuid/webhook", "POST")).toBe(
			false,
		);
		expect(publicRequest("/api/providers/okpay/admin", "POST")).toBe(false);
	});

	it("exposes only POST for the exact checkout review route", () => {
		expect(publicRequest(`/api/checkout/${orderId}/review`, "POST")).toBe(true);
		expect(publicRequest(`/api/checkout/${orderId}/review`, "GET")).toBe(false);
		expect(publicRequest(`/api/checkout/${orderId}/evidence`, "POST")).toBe(
			false,
		);
	});

	it("exposes only GET for public site assets", () => {
		for (const path of ["/api/site-logo", "/api/site-background"]) {
			expect(publicRequest(path, "GET"), path).toBe(true);
			expect(publicRequest(path, "POST"), path).toBe(false);
		}
	});

	it("fails closed for unknown and lookalike API routes", () => {
		for (const path of [
			"/api/unknown",
			"/api/site-logo/extra",
			"/api/providers/alipay/notify/extra",
			"/api/providers/okpay/notify/extra",
			`/api/providers/alchemy/${telegramBotId}/extra`,
			`/api/telegram/${telegramBotId}/webhook/extra`,
		])
			expect(publicRequest(path, "POST"), path).toBe(false);
	});

	it("requires an exact same-origin Origin header for review uploads", () => {
		expect(sameOrigin("https://pay.example")).toBe(true);
		expect(sameOrigin("https://attacker.example")).toBe(false);
		expect(sameOrigin("https://sub.pay.example")).toBe(false);
		expect(sameOrigin()).toBe(false);
	});
});

function publicRequest(path: string, method: string) {
	return isPublicApiRequest(
		new Request(`https://pay.example${path}`, { method }),
	);
}

function sameOrigin(origin?: string) {
	return isSameOriginRequest(
		new Request(`https://pay.example/api/checkout/${orderId}/review`, {
			method: "POST",
			headers: origin ? { Origin: origin } : undefined,
		}),
	);
}
