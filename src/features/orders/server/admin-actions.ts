import { type OrderStatus, orderStatuses } from "#/features/orders/schema";
import { cancelOrderAtomically } from "#/features/orders/server/cancel";
import {
	assertTransition,
	InvalidOrderTransitionError,
} from "#/features/orders/state-machine";
import {
	emitOrderStatusEvent,
	prepareOrderStatusEvent,
} from "#/features/payments/server/order-status-event";
import type { PaymentRuntime } from "#/features/payments/server/payment-events";
import { recordProviderPayment } from "#/features/payments/server/provider-payment";
import type { PaymentScanMessage } from "#/features/payments/types";
import {
	AlipayError,
	type AlipayQueryInspection,
} from "#/integrations/payment-rails/alipay";
import { DomainError } from "#/lib/domain-error";

export interface AdminOrderActionContext {
	actorUserId: string;
	requestId: string | null;
	ipAddress: string | null;
}

type MutableOrder = {
	status: string;
	version: number;
};

function statusOf(value: string): OrderStatus {
	if (!orderStatuses.includes(value as OrderStatus)) {
		throw new Error(`Unknown order status: ${value}`);
	}
	return value as OrderStatus;
}

export async function queueAdminPaymentCheck(
	env: Pick<Env, "DB" | "PAYMENT_QUEUE">,
	orderId: string,
	context: AdminOrderActionContext,
) {
	const order = await env.DB.prepare(
		`SELECT o.status, ops.receiving_method_id
		 FROM orders o
		 JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 WHERE o.id = ? LIMIT 1`,
	)
		.bind(orderId)
		.first<{
			status: string;
			receiving_method_id: string;
		}>();
	if (!order)
		throw new DomainError(
			"order_payment_target_not_found",
			404,
			"Order or payment target not found",
		);
	if (!["pending", "confirming", "partially_paid"].includes(order.status)) {
		throw new DomainError("order_status_conflict", 409, "Order is not active");
	}
	const message: PaymentScanMessage = {
		kind: "payment.scan",
		version: 1,
		orderId,
		receivingMethodId: order.receiving_method_id,
	};
	await env.PAYMENT_QUEUE.send(message);
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO audit_logs
		 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
		 VALUES (?, ?, 'order.payment_check_requested', 'order', ?, ?, ?, ?, ?)`,
	)
		.bind(
			crypto.randomUUID(),
			context.actorUserId,
			orderId,
			context.requestId,
			context.ipAddress,
			JSON.stringify({ queue: "payment", status: order.status }),
			now,
		)
		.run();
	return { queued: true };
}

export async function reviewAdminAlipayOrder(
	env: Pick<Env, "DB"> & { WEBHOOK_QUEUE?: Env["WEBHOOK_QUEUE"] },
	orderId: string,
	context: AdminOrderActionContext,
	queryProvider: () => Promise<AlipayQueryInspection>,
) {
	const order = await env.DB.prepare(
		"SELECT o.status, o.is_test, ops.rail_code, ops.rail_kind " +
			"FROM orders o JOIN order_payment_snapshots ops ON ops.order_id = o.id " +
			"WHERE o.id = ? LIMIT 1",
	)
		.bind(orderId)
		.first<{
			status: string;
			is_test: number;
			rail_code: string;
			rail_kind: string;
		}>();
	if (
		!order ||
		order.is_test === 1 ||
		order.rail_code !== "alipay" ||
		order.rail_kind !== "fiat"
	)
		throw new DomainError(
			"order_payment_target_not_found",
			404,
			"Alipay order not found",
		);

	const currentStatus = statusOf(order.status);
	let inspection: AlipayQueryInspection | null = null;
	let queryError: ReturnType<typeof summarizeAlipayError> | null = null;
	try {
		inspection = await queryProvider();
	} catch (error) {
		queryError = summarizeAlipayError(error);
	}
	const now = Date.now();
	await env.DB.prepare(
		"INSERT INTO audit_logs " +
			"(id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at) " +
			"VALUES (?, ?, 'order.alipay_query_reviewed', 'order', ?, ?, ?, ?, ?)",
	)
		.bind(
			crypto.randomUUID(),
			context.actorUserId,
			orderId,
			context.requestId,
			context.ipAddress,
			JSON.stringify({
				provider: "alipay",
				outcome: inspection?.outcome ?? "error",
				gatewayCode: inspection?.response.code,
				gatewaySubCode: inspection?.response.subCode,
				tradeStatus: inspection?.response.tradeStatus,
				errorCode: queryError?.code,
			}),
			now,
		)
		.run();

	let settlement: { duplicate: boolean; status: OrderStatus } | null = null;
	let reconciliationError: string | null = null;
	if (inspection?.payment?.status === "succeeded") {
		if (!env.WEBHOOK_QUEUE) {
			reconciliationError = "order_webhook_queue_unavailable";
		} else {
			try {
				settlement = await recordProviderPayment(
					{ DB: env.DB, WEBHOOK_QUEUE: env.WEBHOOK_QUEUE },
					orderId,
					"alipay",
					inspection.payment,
				);
			} catch (error) {
				reconciliationError =
					error instanceof DomainError
						? error.code
						: "PAYMENT_RECONCILIATION_FAILED";
			}
		}
	}
	return {
		outcome: inspection?.outcome ?? "error",
		response: inspection?.response ?? null,
		error: queryError,
		localStatus: settlement?.status ?? currentStatus,
		settlement,
		reconciliationError,
	};
}

function summarizeAlipayError(error: unknown) {
	if (error instanceof AlipayError)
		return { kind: error.kind, code: error.code, ...error.diagnostics };
	return { kind: "provider" as const, code: "ALIPAY_UNEXPECTED_ERROR" };
}

export async function cancelOrderAsAdmin(
	env: PaymentRuntime,
	orderId: string,
	context: AdminOrderActionContext,
) {
	const order = await loadMutableOrder(env.DB, orderId);
	if (order.status === "cancelled") {
		await emitOrderStatusEvent(
			env,
			orderId,
			"cancelled",
			`${orderId}:cancelled`,
		);
		return { status: "cancelled" as const, changed: false };
	}
	const status = statusOf(order.status);
	assertAdminTransition(status, "cancelled", "merchant_cancelled");
	const event = await prepareOrderStatusEvent(
		env,
		orderId,
		"cancelled",
		`${orderId}:cancelled`,
	);
	const changed = await cancelOrderAtomically(
		env.DB,
		orderId,
		{
			status,
			version: order.version,
		},
		Date.now(),
		{ ...context, action: "order.cancelled_by_admin" },
		event.statements,
	);
	if (!changed) throw orderStatusConflict();
	await event.dispatch();
	return { status: "cancelled" as const, changed: true };
}

export async function recordExternalRefund(
	env: PaymentRuntime,
	input: { orderId: string; reference: string; note: string },
	context: AdminOrderActionContext,
) {
	const order = await loadMutableOrder(env.DB, input.orderId);
	if (order.status === "refunded") {
		await emitOrderStatusEvent(
			env,
			input.orderId,
			"refunded",
			`${input.orderId}:refunded`,
		);
		return { status: "refunded" as const, changed: false };
	}
	const status = statusOf(order.status);
	assertAdminTransition(status, "refunded", "admin_refund");
	const now = Date.now();
	const auditId = crypto.randomUUID();
	const event = await prepareOrderStatusEvent(
		env,
		input.orderId,
		"refunded",
		`${input.orderId}:refunded`,
	);
	try {
		await env.DB.batch([
			env.DB.prepare(
				`UPDATE orders SET status = 'refunded', version = version + 1, updated_at = ?
			 WHERE id = ? AND version = ? AND status = ?`,
			).bind(now, input.orderId, order.version, status),
			env.DB.prepare(
				"SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('order refund conflict', '$') END",
			),
			env.DB.prepare(
				`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, before, after, created_at)
			 SELECT ?, ?, 'order.external_refund_recorded', 'order', ?, ?, ?, ?, ?, ?
			 WHERE EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'refunded' AND version = ?)`,
			).bind(
				auditId,
				context.actorUserId,
				input.orderId,
				context.requestId,
				context.ipAddress,
				JSON.stringify({ status }),
				JSON.stringify({
					status: "refunded",
					reference: input.reference,
					note: input.note,
				}),
				now,
				input.orderId,
				order.version + 1,
			),
			...event.statements,
		]);
	} catch (error) {
		const current = await loadMutableOrder(env.DB, input.orderId);
		if (current.status !== order.status || current.version !== order.version)
			throw orderStatusConflict();
		throw error;
	}
	await event.dispatch();
	return { status: "refunded" as const, changed: true };
}

export async function resendOrderNotification(
	env: PaymentRuntime,
	orderId: string,
	context: AdminOrderActionContext,
) {
	const order = await env.DB.prepare(
		"SELECT status, notify_url FROM orders WHERE id = ? LIMIT 1",
	)
		.bind(orderId)
		.first<{ status: OrderStatus; notify_url: string | null }>();
	if (!order) throw new DomainError("order_not_found", 404, "Order not found");
	if (!order.notify_url)
		throw new DomainError(
			"order_notification_missing",
			409,
			"Order does not have a notification destination",
		);
	await emitOrderStatusEvent(
		env,
		orderId,
		order.status,
		`manual:${orderId}:${crypto.randomUUID()}`,
	);
	await env.DB.prepare(
		`INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id,
		 request_id, ip_address, created_at) VALUES (?, ?, 'order.notification_resent', 'order', ?, ?, ?, ?)`,
	)
		.bind(
			crypto.randomUUID(),
			context.actorUserId,
			orderId,
			context.requestId,
			context.ipAddress,
			Date.now(),
		)
		.run();
	return { queued: true };
}

async function loadMutableOrder(db: D1Database, orderId: string) {
	const order = await db
		.prepare("SELECT status, version FROM orders WHERE id = ? LIMIT 1")
		.bind(orderId)
		.first<MutableOrder>();
	if (!order) throw new DomainError("order_not_found", 404, "Order not found");
	return order;
}

function assertAdminTransition(
	from: OrderStatus,
	to: OrderStatus,
	reason: "merchant_cancelled" | "admin_refund",
) {
	try {
		assertTransition(from, to, reason);
	} catch (error) {
		if (error instanceof InvalidOrderTransitionError)
			throw orderStatusConflict();
		throw error;
	}
}

function orderStatusConflict() {
	return new DomainError(
		"order_status_conflict",
		409,
		"Order status changed or does not allow this operation",
	);
}
