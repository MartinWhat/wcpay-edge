import {
	ReceivingMethodNotReadyError,
	type ReceivingMethodReadiness,
	type ReceivingMethodReadinessReason,
} from "#/features/payment-settings/readiness";
import { createReceivingMethodAdapters } from "#/features/payment-settings/server/method-adapter";

type ReceivingMethodReadinessRow = {
	id: string;
	enabled: number;
	asset_kind: "native" | "token" | "external" | "fiat";
	contract_address: string | null;
	rail_code: string;
	rail_kind: "chain" | "exchange" | "wallet" | "fiat";
	connection_enabled: number;
	connection_healthy: number;
	payment_method_id: string;
	target_value: string;
};

export async function checkReceivingMethodReadiness(
	db: D1Database,
	methodId: string,
	options: {
		requireEnabled?: boolean;
		now?: number;
		validateTarget?: boolean;
	} = {},
): Promise<ReceivingMethodReadiness> {
	const checkedAt = options.now ?? Date.now();
	const methods = await db
		.prepare(
			`SELECT rm.id, rm.enabled, link.payment_asset_id AS payment_method_id,
			 rm.target_value,
			 pa.kind AS asset_kind, pa.contract_address,
			 pr.code AS rail_code, pr.kind AS rail_kind,
			 EXISTS (SELECT 1 FROM payment_ingresses pc WHERE pc.rail_code = pa.rail_code
			  AND pc.enabled = 1) AS connection_enabled,
			 EXISTS (SELECT 1 FROM payment_ingresses pc WHERE pc.rail_code = pa.rail_code
			  AND pc.enabled = 1
			  AND (pr.kind != 'chain' OR pc.health_status = 'healthy')) AS connection_healthy
			 FROM receiving_methods rm
			 JOIN receiving_method_assets link ON link.receiving_method_id = rm.id
			 JOIN payment_assets pa ON pa.id = link.payment_asset_id
			 JOIN payment_rails pr ON pr.code = pa.rail_code
			 WHERE rm.id = ?`,
		)
		.bind(methodId)
		.all<ReceivingMethodReadinessRow>();
	const method = methods.results[0];
	if (!method)
		return result(methodId, checkedAt, "unsupported", [
			reason("METHOD_NOT_FOUND", "Receiving method does not exist."),
		]);
	if (
		methods.results.some(
			(row) => row.asset_kind === "token" && !row.contract_address,
		)
	)
		return result(methodId, checkedAt, "unsupported", [
			reason("INVALID_ASSET", "The token contract is not configured."),
		]);
	if ((options.requireEnabled ?? true) && !method.enabled)
		return result(methodId, checkedAt, "disabled", [
			reason("METHOD_DISABLED", "The receiving method is disabled."),
		]);
	if (!method.connection_enabled)
		return result(methodId, checkedAt, "missing_connection", [
			reason("MISSING_CONNECTION", "Configure an enabled payment connection."),
		]);
	if (!method.connection_healthy)
		return result(methodId, checkedAt, "unhealthy", [
			reason(
				"UNHEALTHY_CONNECTION",
				"No enabled connection has passed its health check.",
			),
		]);
	if (!method.target_value.trim())
		return result(methodId, checkedAt, "missing_target", [
			reason("MISSING_TARGET", "Configure the receiving target."),
		]);
	if (method.rail_kind === "fiat") {
		const connection = await db
			.prepare(
				`SELECT credential.payment_ingress_id
				 FROM payment_ingresses connection
				 JOIN receiving_methods method ON method.rail_code = connection.rail_code
				 LEFT JOIN payment_ingress_credentials credential
				   ON credential.payment_ingress_id = connection.id
				 WHERE method.id = ? AND connection.enabled = 1
				 AND credential.payment_ingress_id IS NOT NULL
				 LIMIT 1`,
			)
			.bind(methodId)
			.first<{ payment_ingress_id: string }>();
		if (!connection)
			return result(methodId, checkedAt, "missing_target", [
				reason(
					"INVALID_TARGET",
					"The fiat provider credentials are not configured.",
				),
			]);
		return result(methodId, checkedAt, "ready", []);
	}
	let adapters: Awaited<ReturnType<typeof createReceivingMethodAdapters>>;
	try {
		adapters = await createReceivingMethodAdapters(db, method.id);
	} catch {
		return result(methodId, checkedAt, "missing_target", [
			reason("INVALID_TARGET", "The receiving configuration is invalid."),
		]);
	}
	const targetValid = await Promise.all(
		adapters.map(async ({ adapter }) => {
			if (!adapter.validateAddress(method.target_value)) return false;
			if (!(options.validateTarget && adapter.validateTarget)) return true;
			try {
				return await adapter.validateTarget(method.target_value);
			} catch {
				return false;
			}
		}),
	);
	if (!targetValid.some(Boolean))
		return result(methodId, checkedAt, "missing_target", [
			reason("INVALID_TARGET", "The receiving target is invalid."),
		]);
	return result(methodId, checkedAt, "ready", []);
}

export async function assertReceivingMethodReadyForEnable(
	db: D1Database,
	methodId: string,
) {
	const readiness = await checkReceivingMethodReadiness(db, methodId, {
		requireEnabled: false,
		validateTarget: true,
	});
	if (!readiness.ready) throw new ReceivingMethodNotReadyError(readiness);
	return readiness;
}

function result(
	methodId: string,
	checkedAt: number,
	status: ReceivingMethodReadiness["status"],
	reasons: ReceivingMethodReadinessReason[],
): ReceivingMethodReadiness {
	return {
		receivingMethodId: methodId,
		ready: status === "ready",
		status,
		reasons,
		checkedAt,
	};
}

function reason(
	code: ReceivingMethodReadinessReason["code"],
	message: string,
): ReceivingMethodReadinessReason {
	return { code, message };
}
