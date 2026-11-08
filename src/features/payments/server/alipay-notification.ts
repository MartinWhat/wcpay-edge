import { z } from "zod";
import { loadAlipayProviderForOrder } from "#/features/payments/server/alipay-provider";
import { recordProviderPayment } from "#/features/payments/server/provider-payment";
import {
	claimInboundWebhookRateLimit,
	recordInboundWebhookReceipt,
} from "#/features/webhooks/server/inbound-receipts";
import { json, withRequestId } from "#/server/http";
import {
	RequestBodyTooLargeError,
	readLimitedRequestBytes,
} from "#/server/request-body";

const maximumBodyBytes = 64 * 1024;
const notificationSchema = z.record(z.string(), z.string());

export async function handleAlipayNotification(request: Request, env: Env) {
	const startedAt = Date.now();
	const rate = await claimInboundWebhookRateLimit(
		env.DB,
		"alipay.notify",
		request,
	);
	if (!rate.allowed) return errorResponse(request, "rate_limited", 429);
	const finish = async (
		response: Response,
		signatureStatus: "valid" | "invalid" | "unknown",
		errorCode?: string,
	) => {
		await recordInboundWebhookReceipt(env.DB, {
			endpointCode: "alipay.notify",
			request,
			startedAt,
			responseStatus: response.status,
			signatureStatus,
			rate,
			...(errorCode ? { errorCode } : {}),
		});
		return response;
	};
	let input: z.infer<typeof notificationSchema>;
	try {
		const bytes = await readLimitedRequestBytes(request, maximumBodyBytes);
		const contentType = request.headers.get("content-type") ?? "";
		const formData = await new Response(bytes.buffer, {
			headers: { "content-type": contentType },
		}).formData();
		const parsed: Record<string, string> = {};
		for (const [key, value] of formData) {
			if (typeof value !== "string")
				return finish(
					errorResponse(request, "invalid_notification", 400),
					"unknown",
					"invalid_notification",
				);
			parsed[key] = value;
		}
		const validated = notificationSchema.safeParse(parsed);
		if (!validated.success)
			return finish(
				errorResponse(request, "invalid_notification", 400),
				"unknown",
				"invalid_notification",
			);
		input = validated.data;
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError)
			return finish(
				errorResponse(request, "payload_too_large", 413),
				"unknown",
				"payload_too_large",
			);
		return finish(
			errorResponse(request, "invalid_notification", 400),
			"unknown",
			"invalid_notification",
		);
	}
	const orderId = input.out_trade_no?.trim();
	if (!orderId)
		return finish(
			errorResponse(request, "invalid_notification", 400),
			"unknown",
			"invalid_notification",
		);
	let provider: Awaited<ReturnType<typeof loadAlipayProviderForOrder>>;
	try {
		provider = await loadAlipayProviderForOrder(env.DB, orderId);
	} catch {
		return finish(
			errorResponse(request, "provider_configuration_invalid", 503),
			"unknown",
			"provider_configuration_invalid",
		);
	}
	if (!provider)
		return finish(
			errorResponse(request, "invalid_signature", 401),
			"unknown",
			"order_not_found",
		);
	if (!provider.verifyNotification(input))
		return finish(
			errorResponse(request, "invalid_signature", 401),
			"invalid",
			"invalid_signature",
		);
	const providerOrderId = `${orderId}`;
	const queried = await provider.queryPayment(providerOrderId);
	if (queried?.status !== "succeeded")
		return finish(
			errorResponse(request, "payment_pending", 409),
			"valid",
			"payment_pending",
		);
	const notified = provider.parseNotification(input);
	if (
		notified.providerTradeId !== queried.providerTradeId ||
		notified.amountMinor !== queried.amountMinor ||
		notified.currency !== queried.currency
	)
		return finish(
			errorResponse(request, "payment_mismatch", 422),
			"valid",
			"payment_mismatch",
		);
	await recordProviderPayment(env, orderId, "alipay", queried);
	return finish(new Response("success", { status: 200 }), "valid");
}

function errorResponse(request: Request, error: string, status: number) {
	return withRequestId(request, json({ error }, { status }));
}
