import { z } from "zod";
import { orderIdPathSchema } from "#/features/orders/schema";
import { DomainError } from "#/lib/domain-error";
import { inspectImage } from "#/lib/image";

const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const reviewInputSchema = z.object({
	orderId: orderIdPathSchema,
	description: z.string().trim().min(10).max(1_000),
	transactionHash: z.string().trim().min(8).max(256).optional(),
});

export type CreatePaymentReviewInput = z.input<typeof reviewInputSchema> & {
	evidence: ArrayBuffer;
	claimedContentType?: string;
};

export class PaymentReviewError extends DomainError {
	constructor(
		override readonly code:
			| "invalid_evidence"
			| "order_unavailable"
			| "review_exists"
			| "rate_limited"
			| "storage_failed",
		override readonly status: number,
	) {
		super(code, status, code);
		this.name = "PaymentReviewError";
	}
}

export async function createPaymentReview(
	input: CreatePaymentReviewInput,
	dependencies: {
		db: D1Database;
		bucket: R2Bucket;
		requestId?: string | null;
		ipAddress?: string | null;
	},
) {
	const data = reviewInputSchema.parse(input);
	const bytes = new Uint8Array(input.evidence);
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_EVIDENCE_BYTES) {
		throw new PaymentReviewError("invalid_evidence", 422);
	}
	const image = await inspectImage(input.evidence);
	if (!image) throw new PaymentReviewError("invalid_evidence", 422);
	const { contentType, extension, sha256: evidenceSha256 } = image;

	const order = await dependencies.db
		.prepare("SELECT status, is_test FROM orders WHERE id = ? LIMIT 1")
		.bind(data.orderId)
		.first<{ status: string; is_test: number }>();
	if (
		!order ||
		order.is_test === 1 ||
		!["pending", "confirming", "partially_paid", "expired"].includes(
			order.status,
		)
	) {
		throw new PaymentReviewError("order_unavailable", 409);
	}
	const pending = await dependencies.db
		.prepare(
			"SELECT 1 AS found FROM payment_reviews WHERE order_id = ? AND status = 'pending' LIMIT 1",
		)
		.bind(data.orderId)
		.first<{ found: number }>();
	if (pending) throw new PaymentReviewError("review_exists", 409);

	const reviewId = crypto.randomUUID();
	const evidenceKey = `payment-reviews/${data.orderId}/${reviewId}.${extension}`;
	try {
		await dependencies.bucket.put(evidenceKey, input.evidence, {
			httpMetadata: { contentType },
			customMetadata: {
				orderId: data.orderId,
				reviewId,
				sha256: evidenceSha256,
			},
		});
	} catch {
		throw new PaymentReviewError("storage_failed", 503);
	}

	const now = Date.now();
	try {
		const results = await dependencies.db.batch([
			dependencies.db
				.prepare(
					`INSERT OR IGNORE INTO payment_reviews
					 (id, order_id, status, transaction_hash, description, evidence_key,
					 evidence_content_type, evidence_size_bytes, evidence_sha256, created_at, updated_at)
					 VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					reviewId,
					data.orderId,
					data.transactionHash ?? null,
					data.description,
					evidenceKey,
					contentType,
					bytes.byteLength,
					evidenceSha256,
					now,
					now,
				),
			dependencies.db
				.prepare(
					`INSERT INTO audit_logs
					 (id, action, target_type, target_id, request_id, ip_address, after, created_at)
					 SELECT ?, 'payment_review.created', 'payment_review', ?, ?, ?, ?, ?
					 WHERE EXISTS (SELECT 1 FROM payment_reviews WHERE id = ?)`,
				)
				.bind(
					crypto.randomUUID(),
					reviewId,
					dependencies.requestId ?? null,
					dependencies.ipAddress ?? null,
					JSON.stringify({ orderId: data.orderId, evidenceSha256 }),
					now,
					reviewId,
				),
		]);
		if ((results[0]?.meta.changes ?? 0) !== 1) {
			const existing = await dependencies.db
				.prepare(
					"SELECT 1 AS found FROM payment_reviews WHERE order_id = ? AND status = 'pending' LIMIT 1",
				)
				.bind(data.orderId)
				.first<{ found: number }>();
			if (existing) throw new PaymentReviewError("review_exists", 409);
			throw new Error("Payment review could not be created");
		}
	} catch (error) {
		await dependencies.bucket.delete(evidenceKey).catch(() => undefined);
		throw error;
	}
	return { id: reviewId, status: "pending" as const, createdAt: now };
}
