import { z } from "zod";
import { recordProviderPayment } from "#/features/payments/server/provider-payment";
import {
	claimInboundWebhookRateLimit,
	recordInboundWebhookReceipt,
} from "#/features/webhooks/server/inbound-receipts";
import { AlipayProvider } from "#/integrations/payment-rails/alipay";
import { decryptSecret } from "#/lib/secrets";
import { json, withRequestId } from "#/server/http";
import {
	RequestBodyTooLargeError,
	readLimitedRequestBytes,
} from "#/server/request-body";
import { loadRuntimeConfig } from "#/server/runtime-config";

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
	const row = await env.DB.prepare(
		`SELECT credential.config_encrypted
		 FROM orders o
		 JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 JOIN payment_ingresses connection ON connection.id = ops.connection_id
		 LEFT JOIN payment_ingress_credentials credential
		   ON credential.payment_ingress_id = connection.id
		 WHERE o.id = ? AND ops.rail_code = 'alipay' LIMIT 1`,
	)
		.bind(orderId)
		.first<{ config_encrypted: string | null }>();
	if (!row?.config_encrypted)
		return finish(
			errorResponse(request, "invalid_signature", 401),
			"unknown",
			"order_not_found",
		);
	const runtime = await loadRuntimeConfig(env.DB);
	let provider: AlipayProvider;
	try {
		provider = await AlipayProvider.create(
			JSON.parse(
				await decryptSecret(
					row.config_encrypted,
					runtime.integrationConfigSecret,
				),
			),
		);
	} catch {
		return finish(
			errorResponse(request, "provider_configuration_invalid", 503),
			"unknown",
			"provider_configuration_invalid",
		);
	}
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
