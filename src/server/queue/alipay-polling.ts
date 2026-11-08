import { ALIPAY_FAST_POLL_INTERVAL_SECONDS } from "#/features/payments/server/alipay-polling";
import type { PaymentScanMessage } from "#/features/payments/types";

type PaymentScanQueue = {
	send(
		message: PaymentScanMessage,
		options?: { delaySeconds?: number },
	): Promise<unknown>;
};

export async function enqueueInitialAlipayPoll(
	db: D1Database,
	queue: PaymentScanQueue | undefined,
	order: {
		orderId: string;
		paymentNetwork?: string;
		receivingMethodId?: string;
	},
) {
	if (!queue || order.paymentNetwork !== "alipay" || !order.receivingMethodId)
		return;
	const now = Date.now();
	try {
		await queue.send(
			{
				kind: "payment.scan",
				version: 1,
				orderId: order.orderId,
				receivingMethodId: order.receivingMethodId,
				alipayPolling: true,
			},
			{ delaySeconds: ALIPAY_FAST_POLL_INTERVAL_SECONDS },
		);
		await db
			.prepare(
				"UPDATE orders SET last_payment_scan_at = ? WHERE id = ? AND status = 'pending'",
			)
			.bind(now, order.orderId)
			.run();
	} catch {
		console.warn(
			JSON.stringify({ event: "alipay_initial_poll_enqueue_failed" }),
		);
	}
}
