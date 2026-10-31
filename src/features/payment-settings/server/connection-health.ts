import { paymentSettingsError } from "#/features/payment-settings/errors";
import {
	createPaymentConnectionAdapter,
	loadPaymentConnectionHealthTargets,
	loadPaymentConnectionHealthTargetsByIds,
} from "#/features/payment-settings/server/method-adapter";

export async function testPaymentConnection(
	db: D1Database,
	connectionId: string,
) {
	const connection = await db
		.prepare(
			`SELECT connection.rail_code, rail.kind
			 FROM payment_ingresses connection
			 JOIN payment_rails rail ON rail.code = connection.rail_code
			 WHERE connection.id = ? LIMIT 1`,
		)
		.bind(connectionId)
		.first<{
			rail_code: string;
			kind: "chain" | "exchange" | "wallet" | "fiat";
		}>();
	if (!connection) throw paymentSettingsError("payment_connection_not_found");
	const adapter =
		connection.kind === "chain"
			? await createPaymentConnectionAdapter(db, connectionId)
			: null;
	const checkedAt = Date.now();
	if (!adapter) {
		await saveHealth(db, connectionId, false, null, checkedAt, "configuration");
		return {
			healthy: false,
			latencyMs: null,
			checkedAt,
			errorCode: "configuration" as const,
		};
	}
	try {
		const health = await adapter.healthCheck();
		const healthCheckedAt = health.checkedAt.getTime();
		const errorCode = health.healthy ? null : "health_check_failed";
		await saveHealth(
			db,
			connectionId,
			health.healthy,
			health.latencyMs,
			healthCheckedAt,
			errorCode,
		);
		return {
			healthy: health.healthy,
			latencyMs: health.latencyMs,
			checkedAt: healthCheckedAt,
			errorCode,
		};
	} catch {
		await saveHealth(db, connectionId, false, null, checkedAt, "network");
		return {
			healthy: false,
			latencyMs: null,
			checkedAt,
			errorCode: "network" as const,
		};
	}
}

export async function refreshEnabledPaymentConnectionHealth(
	db: D1Database,
	limit = 20,
	loadTargets: typeof loadPaymentConnectionHealthTargets = loadPaymentConnectionHealthTargets,
	now = Date.now(),
	intervalMs = 15 * 60_000,
) {
	const targets = await loadTargets(db, limit, now, intervalMs);
	return refreshHealthTargets(db, targets);
}

export async function refreshPaymentConnectionHealthByIds(
	db: D1Database,
	connectionIds: string[],
) {
	return refreshHealthTargets(
		db,
		await loadPaymentConnectionHealthTargetsByIds(db, connectionIds),
	);
}

async function refreshHealthTargets(
	db: D1Database,
	targets: Awaited<ReturnType<typeof loadPaymentConnectionHealthTargets>>,
) {
	const results: Awaited<ReturnType<typeof checkHealthTarget>>[] = [];
	for (let index = 0; index < targets.length; index += 3) {
		results.push(
			...(await Promise.all(
				targets.slice(index, index + 3).map(checkHealthTarget),
			)),
		);
	}
	if (results.length)
		await db.batch(
			results.map((result) =>
				healthUpdate(
					db,
					result.id,
					result.healthy,
					result.latencyMs,
					result.checkedAt,
					result.errorCode,
				),
			),
		);
	return {
		checked: results.length,
		healthy: results.filter((result) => result.healthy).length,
		unhealthy: results.filter((result) => !result.healthy).length,
	};
}

async function checkHealthTarget({
	id,
	adapter,
}: Awaited<ReturnType<typeof loadPaymentConnectionHealthTargets>>[number]) {
	const checkedAt = Date.now();
	if (!adapter)
		return {
			id,
			healthy: false,
			latencyMs: null,
			checkedAt,
			errorCode: "configuration",
		};
	try {
		const health = await adapter.healthCheck();
		return {
			id,
			healthy: health.healthy,
			latencyMs: health.latencyMs,
			checkedAt: health.checkedAt.getTime(),
			errorCode: health.healthy ? null : "health_check_failed",
		};
	} catch {
		return {
			id,
			healthy: false,
			latencyMs: null,
			checkedAt,
			errorCode: "network",
		};
	}
}

async function saveHealth(
	db: D1Database,
	id: string,
	healthy: boolean,
	latency: number | null,
	checkedAt: number,
	errorCode: string | null,
) {
	await healthUpdate(db, id, healthy, latency, checkedAt, errorCode).run();
}

function healthUpdate(
	db: D1Database,
	id: string,
	healthy: boolean,
	latency: number | null,
	checkedAt: number,
	errorCode: string | null,
) {
	return db
		.prepare(
			`UPDATE payment_ingresses SET health_status = ?, last_latency_ms = ?,
			 last_checked_at = ?, last_error_code = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(
			healthy ? "healthy" : "unhealthy",
			latency,
			checkedAt,
			errorCode,
			checkedAt,
			id,
		);
}
