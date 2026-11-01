import type { CreateOrderInput } from "#/features/orders/schema";
import { OrderServiceError } from "#/features/orders/server/create";
import type { ApiOrder } from "#/features/orders/server/query";
import {
	AlipayError,
	AlipayProvider,
} from "#/integrations/payment-rails/alipay";
import { decryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";

export async function initializeAlipayOrder(
	db: D1Database,
	order: ApiOrder,
	input: CreateOrderInput,
	failure: { deleteOrder: boolean },
) {
	if (order.currency !== "CNY")
		throw new OrderServiceError(
			"currency_not_supported",
			"Alipay orders must use CNY",
			422,
		);
	const connection = await db
		.prepare(
			`SELECT credential.config_encrypted, ops.target_value, connection.provider_product
			 FROM order_payment_snapshots ops
			 JOIN payment_ingresses connection ON connection.id = ops.connection_id
			 LEFT JOIN payment_ingress_credentials credential
			   ON credential.payment_ingress_id = connection.id
			 WHERE ops.order_id = ? AND ops.rail_code = 'alipay' LIMIT 1`,
		)
		.bind(order.orderId)
		.first<{
			config_encrypted: string | null;
			target_value: string;
			provider_product: "website" | "face_to_face";
		}>();
	if (!connection?.config_encrypted)
		throw new OrderServiceError(
			"provider_configuration_missing",
			"Alipay channel credentials are missing",
			503,
		);
	try {
		const runtime = await loadRuntimeConfig(db);
		const clear = await decryptSecret(
			connection.config_encrypted,
			runtime.integrationConfigSecret,
		);
		const provider = await AlipayProvider.create(JSON.parse(clear));
		if (!runtime.betterAuthUrl)
			throw new OrderServiceError(
				"provider_configuration_missing",
				"Instance origin is unavailable for Alipay callback",
				503,
			);
		const hosted = await provider.createHostedPayment({
			orderId: order.orderId,
			amountMinor: minorFromDecimal(order.amount, order.currency),
			currency: order.currency,
			currencyDecimals: 2,
			description: input.description ?? input.externalOrderId ?? order.orderId,
			notifyUrl: new URL(
				"/api/providers/alipay/notify",
				runtime.betterAuthUrl,
			).toString(),
			...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
			product: connection.provider_product,
		});
		const updates = [
			db
				.prepare(
					`UPDATE orders SET provider_order_id = ?, payment_url = ?, updated_at = ?
				 WHERE id = ? AND status = 'pending'`,
				)
				.bind(
					hosted.providerOrderId,
					hosted.paymentUrl ?? hosted.qrCode ?? null,
					Date.now(),
					order.orderId,
				),
		];
		const updated = await db.batch(updates);
		if (updated[0]?.meta.changes !== 1)
			throw new OrderServiceError(
				"order_not_payable",
				"The order is no longer payable",
				409,
			);
	} catch (error) {
		const failed =
			error instanceof OrderServiceError
				? error
				: new OrderServiceError(
						"provider_unavailable",
						error instanceof AlipayError
							? "Alipay could not create the hosted payment"
							: "Alipay payment initialization failed",
						502,
					);
		await rollbackAlipayOrder(db, order.orderId, failure.deleteOrder, failed);
		throw failed;
	}
}

async function rollbackAlipayOrder(
	db: D1Database,
	orderId: string,
	deleteOrder: boolean,
	failure: OrderServiceError,
) {
	const now = Date.now();
	await db.batch([
		db
			.prepare("DELETE FROM receiving_method_locks WHERE order_id = ?")
			.bind(orderId),
		db
			.prepare(
				`DELETE FROM order_payment_snapshots WHERE order_id = ?
				 AND NOT EXISTS (SELECT 1 FROM provider_payments WHERE order_id = ?)`,
			)
			.bind(orderId, orderId),
		deleteOrder
			? db
					.prepare(
						`DELETE FROM orders WHERE id = ? AND status = 'pending'
						 AND NOT EXISTS (SELECT 1 FROM order_payment_snapshots WHERE order_id = ?)`,
					)
					.bind(orderId, orderId)
			: db
					.prepare(
						`UPDATE orders SET payment_asset_id = NULL, provider_order_id = NULL,
						 payment_url = NULL, version = version + 1, updated_at = ?
						 WHERE id = ? AND status = 'pending'
						 AND NOT EXISTS (SELECT 1 FROM order_payment_snapshots WHERE order_id = ?)`,
					)
					.bind(now, orderId, orderId),
		db
			.prepare(
				`INSERT INTO audit_logs
				 (id, action, target_type, target_id, after, created_at)
				 VALUES (?, 'order.hosted_payment_failed', 'order', ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				orderId,
				JSON.stringify({
					provider: "alipay",
					code: failure.code,
					rolledBack: deleteOrder ? "order" : "selection",
				}),
				now,
			),
	]);
}

function minorFromDecimal(value: string, currency: string) {
	if (currency !== "CNY" || !/^\d+(?:\.\d{1,2})?$/.test(value))
		throw new OrderServiceError(
			"currency_not_supported",
			"Alipay order amount is invalid",
			422,
		);
	const [whole = "", fraction = ""] = value.split(".");
	return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))).toString();
}
