import type { OrderStatus } from "#/features/orders/schema";
import { assertTransition } from "#/features/orders/state-machine";
import {
	dispatchPaymentNotifications,
	matchingWebhookEndpoints,
	type PaymentRuntime,
	paymentWebhookInstance,
} from "#/features/payments/server/payment-events";
import type { ProviderPayment } from "#/integrations/payment-rails/types";
import { DomainError } from "#/lib/domain-error";

export async function recordProviderPayment(
	env: PaymentRuntime,
	orderId: string,
	railCode: string,
	payment: ProviderPayment,
): Promise<{ duplicate: boolean; status: OrderStatus }> {
	const stored = await env.DB.prepare(
		`SELECT o.status, o.external_order_id, o.amount_minor, o.currency,
		 o.currency_decimals, o.provider_order_id
		 FROM orders o
		 JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 WHERE o.id = ? AND ops.rail_code = ? LIMIT 1`,
	)
		.bind(orderId, railCode)
		.first<{
			status: OrderStatus;
			external_order_id: string;
			amount_minor: string;
			currency: string;
			currency_decimals: number;
			provider_order_id: string | null;
		}>();
	if (!stored)
		throw new DomainError(
			"payment_order_not_found",
			404,
			"Payment order not found",
		);
	if (stored.provider_order_id !== null && stored.provider_order_id !== orderId)
		throw new DomainError(
			"payment_provider_order_mismatch",
			422,
			"Provider order does not match the local order",
		);
	if (
		payment.currency !== stored.currency ||
		payment.currencyDecimals !== stored.currency_decimals
	)
		throw new DomainError(
			"payment_currency_mismatch",
			422,
			"Provider currency does not match the order",
		);
	const expectedMinor = BigInt(stored.amount_minor);
	const paidMinor = BigInt(payment.amountMinor);
	if (paidMinor < expectedMinor)
		return { duplicate: false, status: stored.status };
	const nextStatus: OrderStatus =
		paidMinor === expectedMinor ? "paid" : "overpaid";
	if (
		stored.status !== nextStatus &&
		!isSameSettlement(stored.status, nextStatus)
	) {
		assertTransition(stored.status, nextStatus, "payment_detected");
	}
	const now = Date.now();
	const eventId = crypto.randomUUID();
	const eventType = `order.${nextStatus}`;
	const deduplicationKey = `${railCode}:${payment.providerTradeId}:${nextStatus}`;
	const payload = {
		event: eventType,
		eventId,
		createdAt: new Date(now).toISOString(),
		instance: await paymentWebhookInstance(env.DB),
		orderId,
		externalOrderId: stored.external_order_id,
		status: nextStatus,
		amount: decimalAmount(stored.amount_minor, stored.currency_decimals),
		currency: stored.currency,
		payment: {
			amount: decimalAmount(payment.amountMinor, payment.currencyDecimals),
			asset: payment.currency,
			network: railCode,
			receivedAmountUnits: payment.amountMinor,
		},
		transaction: null,
	};
	const endpoints = await matchingWebhookEndpoints(env.DB, orderId);
	const deliveries = endpoints.map((endpoint) => ({
		id: crypto.randomUUID(),
		endpoint,
	}));
	const statements: D1PreparedStatement[] = [
		env.DB.prepare(
			`INSERT OR IGNORE INTO provider_payments
			 (id, order_id, rail_code, provider_trade_id, amount_minor, currency,
			  currency_decimals, status, observed_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			crypto.randomUUID(),
			orderId,
			railCode,
			payment.providerTradeId,
			payment.amountMinor,
			payment.currency,
			payment.currencyDecimals,
			payment.status,
			now,
			now,
			now,
		),
		env.DB.prepare(
			`UPDATE orders SET status = ?, paid_at = COALESCE(paid_at, ?),
			 received_amount_units = CASE WHEN ? >= CAST(amount_minor AS INTEGER)
			   THEN ? ELSE received_amount_units END,
			 version = version + 1, updated_at = ?
			 WHERE id = ? AND status = ?`,
		).bind(
			nextStatus,
			now,
			paidMinor.toString(),
			payment.amountMinor,
			now,
			orderId,
			stored.status,
		),
		env.DB.prepare(
			`INSERT OR IGNORE INTO webhook_events
			 (id, order_id, type, deduplication_key, payload, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			eventId,
			orderId,
			eventType,
			deduplicationKey,
			JSON.stringify(payload),
			now,
			now,
		),
		...deliveries.map(({ id, endpoint }) =>
			env.DB.prepare(
				`INSERT INTO webhook_deliveries
				 (id, event_id, order_id, api_key_id, status, attempt_count,
				  created_at, updated_at)
				 SELECT ?, ?, ?, ?, 'queued', 0, ?, ?
				 WHERE EXISTS (SELECT 1 FROM webhook_events WHERE id = ?)`,
			).bind(id, eventId, orderId, endpoint.api_key_id, now, now, eventId),
		),
		env.DB.prepare(
			`INSERT INTO audit_logs
			 (id, action, target_type, target_id, after, created_at)
			 VALUES (?, 'payment.provider_settled', 'order', ?, ?, ?)`,
		).bind(
			crypto.randomUUID(),
			orderId,
			JSON.stringify({
				provider: railCode,
				amountMinor: payment.amountMinor,
				currency: payment.currency,
				status: nextStatus,
			}),
			now,
		),
	];
	const results = await env.DB.batch(statements);
	const inserted = (results[0]?.meta.changes ?? 0) === 1;
	if (!inserted) return { duplicate: true, status: stored.status };
	await dispatchPaymentNotifications(
		env,
		eventId,
		payload,
		deliveries,
		eventType,
	);
	return { duplicate: false, status: nextStatus };
}

function isSameSettlement(from: OrderStatus, to: OrderStatus) {
	return (
		(from === "paid" && to === "overpaid") ||
		(from === "overpaid" && to === "paid")
	);
}

function decimalAmount(minor: string, decimals: number) {
	const scale = 10n ** BigInt(decimals);
	const value = BigInt(minor);
	return `${value / scale}.${(value % scale).toString().padStart(decimals, "0")}`;
}
