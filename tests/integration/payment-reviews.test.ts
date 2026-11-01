import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createPaymentReview,
	PaymentReviewError,
} from "#/features/payment-reviews/server/create";
import { resolvePaymentReview } from "#/features/payment-reviews/server/resolve";
import type {
	NormalizedTransaction,
	PaymentAdapter,
} from "#/integrations/chains/types";
import { applyMigrations } from "./migrations";

const orderId = "26071306394512345678";
const concurrentOrderId = "26071306394512345679";
const address = "T111111111111111111111111111111111";

describe("payment review flow", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let env: Env;
	const put = vi.fn().mockResolvedValue(undefined);
	const remove = vi.fn().mockResolvedValue(undefined);
	const bucket = { put, delete: remove } as unknown as R2Bucket;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "payment-reviews" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		env = {
			DB: db,
			FILES: bucket,
			WEBHOOK_QUEUE: { send: async () => undefined },
		} as unknown as Env;
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("rejects payment reviews for test orders before storing evidence", async () => {
		const testOrderId = "26071306394512345682";
		const now = Date.now();
		await db
			.prepare(
				`INSERT INTO orders
				 (id, external_order_id, status, amount_minor, currency, currency_decimals,
				  payment_asset_id, received_amount_units, is_test, expires_at, version, created_at, updated_at)
				 VALUES (?, 'test-review-order', 'pending', '1000', 'USD', 2, NULL, '0', 1, ?, 0, ?, ?)`,
			)
			.bind(testOrderId, now + 900_000, now, now)
			.run();
		put.mockClear();

		await expect(
			createPaymentReview(
				{
					orderId: testOrderId,
					description: "A test order cannot accept payment review evidence.",
					evidence: pngEvidence(),
				},
				{ db, bucket },
			),
		).rejects.toMatchObject({ code: "order_unavailable", status: 409 });
		expect(put).not.toHaveBeenCalled();
	});

	it("rejects content whose bytes do not match an allowed image", async () => {
		await expect(
			createPaymentReview(
				{
					orderId,
					description: "This is an invalid screenshot payload.",
					evidence: new TextEncoder().encode("<script>alert(1)</script>")
						.buffer,
					claimedContentType: "image/png",
				},
				{ db, bucket },
			),
		).rejects.toEqual(new PaymentReviewError("invalid_evidence", 422));
		expect(put).not.toHaveBeenCalled();
	});

	it("stores verified evidence and enforces one pending review per order", async () => {
		put.mockClear();
		remove.mockClear();
		const created = await createPaymentReview(
			{
				orderId,
				description: "Paid from my wallet but the checkout did not update.",
				transactionHash: "review-transaction-1",
				evidence: pngEvidence(),
				claimedContentType: "text/html",
			},
			{ db, bucket, requestId: "request-review", ipAddress: "192.0.2.1" },
		);
		expect(created.status).toBe("pending");
		expect(put).toHaveBeenCalledOnce();
		const [, , options] = put.mock.calls[0] as [
			string,
			ArrayBuffer,
			R2PutOptions,
		];
		expect(options.httpMetadata).toEqual({ contentType: "image/png" });
		const stored = await db
			.prepare(
				"SELECT status, evidence_content_type, evidence_size_bytes, evidence_sha256 FROM payment_reviews WHERE id = ?",
			)
			.bind(created.id)
			.first<Record<string, string | number>>();
		expect(stored).toMatchObject({
			status: "pending",
			evidence_content_type: "image/png",
			evidence_size_bytes: 33,
		});
		expect(String(stored?.evidence_sha256)).toMatch(/^[a-f0-9]{64}$/);

		await expect(
			createPaymentReview(
				{
					orderId,
					description: "A second pending review must not be accepted.",
					evidence: pngEvidence(),
				},
				{ db, bucket },
			),
		).rejects.toMatchObject({ code: "review_exists", status: 409 });
	});

	it("atomically accepts one concurrent pending review and cleans up the loser", async () => {
		put.mockClear();
		remove.mockClear();
		const create = () =>
			createPaymentReview(
				{
					orderId: concurrentOrderId,
					description: "Concurrent review submission with valid evidence.",
					evidence: pngEvidence(),
				},
				{ db, bucket },
			);
		const outcomes = await Promise.allSettled([create(), create()]);
		expect(
			outcomes.filter(({ status }) => status === "fulfilled"),
		).toHaveLength(1);
		expect(outcomes.find(({ status }) => status === "rejected")).toMatchObject({
			status: "rejected",
			reason: { code: "review_exists", status: 409 },
		});
		expect(put).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledOnce();
		const persisted = await db
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM payment_reviews WHERE order_id = ?) AS reviews,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'payment_review.created'
				  AND json_extract(after, '$.orderId') = ?) AS audits`,
			)
			.bind(concurrentOrderId, concurrentOrderId)
			.first<{ reviews: number; audits: number }>();
		expect(persisted).toEqual({ reviews: 1, audits: 1 });
		const review = await db
			.prepare(
				"SELECT id FROM payment_reviews WHERE order_id = ? AND status = 'pending' LIMIT 1",
			)
			.bind(concurrentOrderId)
			.first<{ id: string }>();
		await expect(
			resolvePaymentReview(
				env,
				{
					reviewId: review?.id ?? "",
					decision: "approve",
					note: "A transaction hash is required before approval.",
				},
				{ reviewerUserId: "reviewer" },
			),
		).rejects.toMatchObject({
			code: "payment_review_transaction_required",
			status: 422,
		});
	});

	it("records rejection, then verifies and approves a new review", async () => {
		const first = await db
			.prepare(
				"SELECT id FROM payment_reviews WHERE order_id = ? AND status = 'pending' LIMIT 1",
			)
			.bind(orderId)
			.first<{ id: string }>();
		expect(first).toBeTruthy();
		await expect(
			resolvePaymentReview(
				env,
				{
					reviewId: first?.id ?? "",
					decision: "reject",
					note: "The supplied transaction cannot be found.",
				},
				{ reviewerUserId: "reviewer" },
			),
		).resolves.toEqual({ status: "rejected", orderStatus: null });
		await expect(
			resolvePaymentReview(
				env,
				{
					reviewId: first?.id ?? "",
					decision: "reject",
					note: "A repeated decision must be rejected.",
				},
				{ reviewerUserId: "reviewer" },
			),
		).rejects.toMatchObject({
			code: "payment_review_already_resolved",
			status: 409,
		});

		const second = await createPaymentReview(
			{
				orderId,
				description: "Resubmitted with a transaction that can be verified.",
				transactionHash: "review-transaction-2",
				evidence: pngEvidence(),
			},
			{ db, bucket },
		);
		await expect(
			resolvePaymentReview(
				env,
				{
					reviewId: second.id,
					decision: "approve",
					note: "No payment adapter is currently available.",
				},
				{ reviewerUserId: "reviewer", adapterFactory: async () => [] },
			),
		).rejects.toMatchObject({
			code: "payment_review_transaction_unavailable",
			status: 503,
		});
		await expect(
			resolvePaymentReview(
				env,
				{
					reviewId: second.id,
					decision: "approve",
					note: "The transaction could not be found.",
				},
				{
					reviewerUserId: "reviewer",
					adapterFactory: async () => [
						{
							adapter: {
								...fakeAdapter(),
								getTransaction: async () => null,
							},
						},
					],
				},
			),
		).rejects.toMatchObject({
			code: "payment_review_transaction_not_found",
			status: 409,
		});
		await expect(
			resolvePaymentReview(
				env,
				{
					reviewId: second.id,
					decision: "approve",
					note: "The transaction does not match this order.",
				},
				{
					reviewerUserId: "reviewer",
					adapterFactory: async () => [
						{
							adapter: {
								...fakeAdapter(),
								validatePayment: () => false,
							},
						},
					],
				},
			),
		).rejects.toMatchObject({
			code: "payment_review_transaction_mismatch",
			status: 409,
		});
		await expect(
			resolvePaymentReview(
				env,
				{
					reviewId: second.id,
					decision: "approve",
					note: "Transaction verified against the configured chain adapter.",
				},
				{
					reviewerUserId: "reviewer",
					adapterFactory: async () => [{ adapter: fakeAdapter() }],
				},
			),
		).resolves.toEqual({ status: "approved", orderStatus: "paid" });
		const state = await db
			.prepare(
				`SELECT o.status AS order_status, pr.status AS review_status,
				 pr.reviewer_user_id, pr.resolution_note
				 FROM orders o JOIN payment_reviews pr ON pr.order_id = o.id
				 WHERE pr.id = ?`,
			)
			.bind(second.id)
			.first<Record<string, string>>();
		expect(state).toEqual({
			order_status: "paid",
			review_status: "approved",
			reviewer_user_id: "reviewer",
			resolution_note:
				"Transaction verified against the configured chain adapter.",
		});
	});

	it("returns a stable missing-review error", async () => {
		await expect(
			resolvePaymentReview(
				env,
				{
					reviewId: "00000000-0000-4000-8000-000000000099",
					decision: "reject",
					note: "This review does not exist.",
				},
				{ reviewerUserId: "reviewer" },
			),
		).rejects.toMatchObject({ code: "payment_review_not_found", status: 404 });
	});

	it("returns a stable conflict when conditional resolution loses", async () => {
		const id = "26071306394512345690";
		await cloneReviewOrder(db, id);
		const review = await createPaymentReview(
			{
				orderId: id,
				description: "Concurrent rejection regression",
				evidence: pngEvidence(),
			},
			{ db, bucket },
		);
		const conflictDb = new Proxy(db, {
			get(target, property) {
				if (property === "batch")
					return async (statements: D1PreparedStatement[]) => {
						await resolvePaymentReview(
							env,
							{
								reviewId: review.id,
								decision: "reject",
								note: "Winning rejection",
							},
							{ reviewerUserId: "reviewer" },
						);
						return target.batch(statements);
					};
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await expect(
			resolvePaymentReview(
				{ DB: conflictDb } as Env,
				{
					reviewId: review.id,
					decision: "reject",
					note: "Another request completed first.",
				},
				{ reviewerUserId: "reviewer" },
			),
		).rejects.toMatchObject({
			code: "payment_review_resolution_conflict",
			status: 409,
		});
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ? AND action = 'payment_review.rejected'",
				)
				.bind(review.id)
				.first(),
		).toEqual({ count: 1 });
	});

	it("rolls back approval accounting when rejection wins during verification", async () => {
		const id = "26071306394512345680";
		await cloneReviewOrder(db, id);
		const review = await createPaymentReview(
			{
				orderId: id,
				description: "Concurrent decision regression",
				transactionHash: "race-transaction",
				evidence: pngEvidence(),
			},
			{ db, bucket },
		);
		const adapter = fakeAdapter();
		let onVerified = () => {};
		let onResume = () => {};
		const verified = new Promise<void>((resolve) => {
			onVerified = resolve;
		});
		const resume = new Promise<void>((resolve) => {
			onResume = resolve;
		});
		const approve = resolvePaymentReview(
			env,
			{
				reviewId: review.id,
				decision: "approve",
				note: "Approve verified payment",
			},
			{
				reviewerUserId: "reviewer",
				adapterFactory: async () => [
					{
						adapter: {
							...adapter,
							getTransaction: async () => {
								onVerified();
								await resume;
								const tx = await adapter.getTransaction("race-transaction");
								return tx ? { ...tx, hash: "race-transaction" } : null;
							},
						},
					},
				],
			},
		);
		const outcome = approve.then(
			() => null,
			(error: unknown) => error,
		);
		await verified;
		await resolvePaymentReview(
			env,
			{
				reviewId: review.id,
				decision: "reject",
				note: "Reject while RPC is pending",
			},
			{ reviewerUserId: "reviewer" },
		);
		onResume();
		expect(await outcome).toMatchObject({
			code: "payment_review_resolution_conflict",
		});
		expect(
			await db
				.prepare(`SELECT o.status, o.received_amount_units, r.status AS review_status,
		 (SELECT COUNT(*) FROM order_payments WHERE order_id = o.id) AS payments,
		 (SELECT COUNT(*) FROM webhook_events WHERE order_id = o.id) AS events
		 FROM orders o JOIN payment_reviews r ON r.order_id = o.id WHERE o.id = ?`)
				.bind(id)
				.first(),
		).toEqual({
			status: "pending",
			received_amount_units: "0",
			review_status: "rejected",
			payments: 0,
			events: 0,
		});
	});

	it("keeps an approval pending after a failed commit and accepts an expired order atomically on retry", async () => {
		const id = "26071306394512345681";
		await cloneReviewOrder(db, id);
		await db
			.prepare("UPDATE orders SET status = 'expired' WHERE id = ?")
			.bind(id)
			.run();
		const review = await createPaymentReview(
			{
				orderId: id,
				description: "Retry an expired payment review",
				transactionHash: "late-review-transaction",
				evidence: pngEvidence(),
			},
			{ db, bucket },
		);
		const adapter = fakeAdapter();
		const factory = async () => [
			{
				adapter: {
					...adapter,
					getTransaction: async () => {
						const tx = await adapter.getTransaction("late-review-transaction");
						return tx ? { ...tx, hash: "late-review-transaction" } : null;
					},
				},
			},
		];
		await db
			.prepare(`CREATE TRIGGER fail_review_approval BEFORE UPDATE OF status ON payment_reviews
		 WHEN NEW.status = 'approved' BEGIN SELECT RAISE(FAIL, 'simulated approval failure'); END`)
			.run();
		try {
			await expect(
				resolvePaymentReview(
					env,
					{
						reviewId: review.id,
						decision: "approve",
						note: "Late payment approved",
					},
					{ reviewerUserId: "reviewer", adapterFactory: factory },
				),
			).rejects.toThrow();
			expect(
				await db
					.prepare("SELECT status FROM payment_reviews WHERE id = ?")
					.bind(review.id)
					.first(),
			).toEqual({ status: "pending" });
			expect(
				await db
					.prepare("SELECT status FROM orders WHERE id = ?")
					.bind(id)
					.first(),
			).toEqual({ status: "expired" });
		} finally {
			await db.prepare("DROP TRIGGER fail_review_approval").run();
		}
		await expect(
			resolvePaymentReview(
				env,
				{
					reviewId: review.id,
					decision: "approve",
					note: "Late payment approved",
				},
				{ reviewerUserId: "reviewer", adapterFactory: factory },
			),
		).resolves.toEqual({ status: "approved", orderStatus: "paid" });
	});
});

async function cloneReviewOrder(db: D1Database, id: string) {
	await db.batch([
		db
			.prepare(`INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at)
		 SELECT ?, ?, 'pending', amount_minor, currency, currency_decimals, payment_asset_id, '0', expires_at, 0, created_at, updated_at FROM orders WHERE id = ?`)
			.bind(id, id, orderId),
		db
			.prepare(`INSERT INTO order_payment_snapshots (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind, asset_id, asset_code, decimals, target_value, connection_id, adapter, required_confirmations, expected_amount_units, created_at)
		 SELECT ?, receiving_method_id, receiving_method_name, rail_code, rail_kind, asset_id, asset_code, decimals, target_value, connection_id, adapter, required_confirmations, expected_amount_units, created_at FROM order_payment_snapshots WHERE order_id = ?`)
			.bind(id, orderId),
	]);
}

function pngEvidence(): ArrayBuffer {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	bytes.set([0, 0, 0, 1], 16);
	bytes.set([0, 0, 0, 1], 20);
	return bytes.buffer;
}

function fakeAdapter(): PaymentAdapter<unknown> {
	const transaction: NormalizedTransaction = {
		network: "tron",
		hash: "review-transaction-2",
		eventIndex: 0,
		from: "T222222222222222222222222222222222",
		to: address,
		assetCode: "USDT",
		amountUnits: 10_000_000n,
		blockNumber: 100n,
		blockHash: "block-review-100",
		confirmations: 2,
		timestamp: new Date(),
		success: true,
	};
	return {
		id: "review-test",
		network: "tron",
		configSchema: {} as PaymentAdapter<unknown>["configSchema"],
		validateConfig: (value) => value,
		createPaymentTarget: async (target) => target,
		getTransaction: async () => transaction,
		findTransactions: async () => [],
		validateAddress: () => true,
		validatePayment: (payment, target, assetCode) =>
			payment.to === target.address && payment.assetCode === assetCode,
		getConfirmations: async (payment) => payment.confirmations,
		healthCheck: async () => ({
			healthy: true,
			latencyMs: 0,
			checkedAt: new Date(),
		}),
		classifyError: () => "permanent",
		isRetryable: () => false,
	};
}

async function seed(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at) VALUES ('reviewer', 'Reviewer', 'reviewer@example.com', 1, 1, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('review-asset', 'tron', 'USDT', 'USDT', 'token', 6, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, enabled, health_status, created_at, updated_at) VALUES ('review-connection', 'tron', 'TRON', 'rpc', 'https://api.trongrid.io', 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 2, created_at = ?, updated_at = ? WHERE id = 'review-asset'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('review-method', 'Primary USDT', 'tron', 'address', ?, ?, 1, ?, ?)",
			)
			.bind(address, address, now, now),
		db
			.prepare(
				"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES (?, 'review-order-1', 'pending', '1000', 'USD', 2, 'review-asset', '0', ?, 0, ?, ?)",
			)
			.bind(orderId, now + 900_000, now, now),
		db
			.prepare(
				"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES (?, 'review-order-2', 'pending', '1000', 'USD', 2, 'review-asset', '0', ?, 0, ?, ?)",
			)
			.bind(concurrentOrderId, now + 900_000, now, now),
		db
			.prepare(
				`INSERT INTO order_payment_snapshots
				 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
				  asset_id, asset_code, decimals, target_value, connection_id,
				  adapter, required_confirmations, expected_amount_units, created_at)
				 VALUES (?, 'review-method', 'Primary USDT', 'tron', 'chain',
				  'review-asset', 'USDT', 6, ?, 'review-connection',
				  'tron', 2, '10000000', ?)`,
			)
			.bind(orderId, address, now),
	]);
}
