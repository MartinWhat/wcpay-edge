import { describe, expect, it } from "vitest";
import { queueMessageKind } from "#/server/queue";

describe("Cloudflare Queue message routing", () => {
	it("routes by the versioned message shape instead of a deployment queue name", () => {
		expect(
			queueMessageKind({
				kind: "webhook.delivery",
				version: 1,
				deliveryId: "d",
				eventId: "e",
				attempt: 1,
			}),
		).toBe("webhook");
		expect(
			queueMessageKind({
				kind: "payment.scan",
				version: 1,
				receivingMethodId: "method",
				orderId: "order",
				alipayPolling: true,
			}),
		).toBe("payment");
	});

	it.each([
		null,
		{},
		{ deliveryId: "d", eventId: "e" },
		{
			kind: "webhook.delivery",
			version: 2,
			deliveryId: "d",
			eventId: "e",
			attempt: 1,
		},
		{
			kind: "payment.scan",
			version: 1,
			deliveryId: "d",
			eventId: "e",
			attempt: 1,
		},
		{
			kind: "payment.scan",
			version: 1,
			receivingMethodId: "method",
			orderId: "order",
			alipayPolling: false,
		},
		{ channelId: "channel", orderId: "order" },
		{ channelId: "channel", orderId: "order", address: 1 },
		{
			kind: "webhook.delivery",
			version: 1,
			deliveryId: "d",
			eventId: "e",
			attempt: 0,
		},
		{
			kind: "webhook.delivery",
			version: 1,
			deliveryId: "",
			eventId: "e",
			attempt: 1,
		},
		{
			kind: "payment.scan",
			version: 1,
			receivingMethodId: "method",
			orderId: "order",
			address: "address",
		},
	])("rejects malformed Queue payload %#", (message) => {
		expect(queueMessageKind(message)).toBe("invalid");
	});
});
