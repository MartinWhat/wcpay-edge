import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { paymentSettingsError } from "#/features/payment-settings/errors";
import {
	parseReceivingUsdLimits,
	receivingLimitDecimals,
} from "#/features/payment-settings/receiving-method-limits";
import { adminContext } from "#/features/payment-settings/server/admin-context";
import { deleteReceivingMethod } from "#/features/payment-settings/server/delete-receiving-method";
import { parseReceivingProviderConfiguration } from "#/features/payment-settings/server/provider-config";
import { unitsToDecimal } from "#/lib/money";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { requestId } from "#/server/http";

const receivingMethodIdInput = z.object({
	id: z.string().trim().min(1).max(100),
});

export const listReceivingMethodsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await adminContext(
			systemPermission("receiving_methods", "read"),
		);
		const rows = await db
			.prepare(
				`SELECT rm.id, rm.name, rm.enabled,
				 pa.id AS payment_method_id,
				 pa.code || ' · ' || pr.name AS payment_method_name,
				 pa.default_confirmations AS required_confirmations,
				 rm.min_amount_minor, rm.max_amount_minor, pa.decimals,
				 rm.sort_order, pa.code AS asset_code,
				 rm.rail_code, rm.target_type, rm.target_value,
				 CASE WHEN rm.rail_code = 'alipay' THEN
				  CASE json_extract(rm.target_metadata, '$.product')
				   WHEN 'face_to_face' THEN 'face_to_face' ELSE 'website' END
				  ELSE NULL END AS alipay_product,
				 pr.kind AS rail_kind,
				 pr.name AS rail_name
				 FROM receiving_methods rm
				 JOIN receiving_method_assets link ON link.receiving_method_id = rm.id
				 JOIN payment_assets pa ON pa.id = link.payment_asset_id
				 JOIN payment_rails pr ON pr.code = rm.rail_code
				 ORDER BY rm.sort_order, rm.name, pa.code`,
			)
			.all<{
				id: string;
				name: string;
				enabled: number;
				payment_method_id: string;
				payment_method_name: string;
				required_confirmations: number;
				min_amount_minor: string | null;
				max_amount_minor: string | null;
				decimals: number;
				sort_order: number;
				asset_code: string;
				rail_code: string;
				target_type: "address" | "account" | "provider";
				target_value: string;
				alipay_product: "website" | "face_to_face" | null;
				rail_kind: "chain" | "exchange" | "wallet" | "fiat";
				rail_name: string;
			}>();
		const grouped = new Map<
			string,
			Omit<
				(typeof rows.results)[number],
				| "payment_method_id"
				| "payment_method_name"
				| "required_confirmations"
				| "min_amount_minor"
				| "max_amount_minor"
				| "decimals"
				| "asset_code"
			> & {
				min_amount: string | null;
				max_amount: string | null;
				assets: Array<{
					payment_method_id: string;
					payment_method_name: string;
					required_confirmations: number;
					asset_code: string;
					decimals: number;
				}>;
			}
		>();
		for (const row of rows.results) {
			const current = grouped.get(row.id) ?? {
				...row,
				min_amount:
					row.min_amount_minor === null
						? null
						: unitsToDecimal(
								BigInt(row.min_amount_minor),
								receivingLimitDecimals,
							),
				max_amount:
					row.max_amount_minor === null
						? null
						: unitsToDecimal(
								BigInt(row.max_amount_minor),
								receivingLimitDecimals,
							),
				assets: [],
			};
			current.assets.push({
				payment_method_id: row.payment_method_id,
				payment_method_name: row.payment_method_name,
				required_confirmations: row.required_confirmations,
				asset_code: row.asset_code,
				decimals: row.decimals,
			});
			grouped.set(row.id, current);
		}
		return [...grouped.values()];
	},
);

export const listReceivingMethodOptionsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await adminContext(
		systemPermission("receiving_methods", "read"),
	);
	const methods = await db
		.prepare(
			`SELECT asset.id, asset.code || ' · ' || rail.name AS name,
			 asset.rail_code, rail.name AS rail_name,
				 asset.code AS asset_code, asset.decimals,
				 rail.kind AS rail_kind
				 FROM payment_assets asset
				 JOIN payment_rails rail ON rail.code = asset.rail_code
				 ORDER BY asset.rail_code, asset.code`,
		)
		.all<{
			id: string;
			name: string;
			rail_code: string;
			rail_name: string;
			asset_code: string;
			decimals: number;
			rail_kind: "chain" | "exchange" | "wallet" | "fiat";
		}>();
	return { methods: methods.results };
});

const createReceivingMethodInput = z.object({
	name: z.string().trim().min(1).max(100),
	paymentMethodIds: z
		.array(z.string().trim().min(1).max(100))
		.min(1)
		.max(100)
		.transform((values) => [...new Set(values)]),
	configuration: z.record(z.string(), z.string().trim().max(512)),
	minAmount: z
		.string()
		.trim()
		.regex(/^\d+(?:\.\d+)?$/)
		.optional(),
	maxAmount: z
		.string()
		.trim()
		.regex(/^\d+(?:\.\d+)?$/)
		.optional(),
	alipayProduct: z.enum(["website", "face_to_face"]).optional(),
});

export const createReceivingMethodFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof createReceivingMethodInput>) =>
		createReceivingMethodInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(
			systemPermission("receiving_methods", "create"),
		);
		const methods = await context.db
			.prepare(
				`SELECT asset.id, asset.code AS asset_code, asset.decimals,
				 rail.code, rail.kind FROM payment_assets asset
				 JOIN payment_rails rail ON rail.code = asset.rail_code
				 WHERE asset.id IN (${data.paymentMethodIds.map(() => "?").join(", ")})
				 ORDER BY asset.code`,
			)
			.bind(...data.paymentMethodIds)
			.all<{
				id: string;
				asset_code: string;
				code: string;
				kind: "chain" | "exchange" | "wallet" | "fiat";
				decimals: number;
			}>();
		if (methods.results.length !== data.paymentMethodIds.length)
			throw paymentSettingsError("payment_method_not_found");
		const first = methods.results[0];
		if (
			!first ||
			methods.results.some(
				(method) => method.code !== first.code || method.kind !== first.kind,
			)
		)
			throw paymentSettingsError("receiving_method_mixed_rail");
		if (data.alipayProduct && first.code !== "alipay")
			throw paymentSettingsError("receiving_method_configuration_required");
		const alipayProduct =
			first.code === "alipay" ? (data.alipayProduct ?? "website") : undefined;
		const target = receivingTarget(
			first.kind,
			first.code,
			data.configuration,
			alipayProduct,
		);
		if (
			first.code === "alipay" &&
			!(await hasConfiguredAlipayConnection(
				context.db,
				target.value,
				alipayProduct ?? "website",
				context.runtime.integrationConfigSecret,
			))
		)
			throw paymentSettingsError("receiving_method_alipay_connection_required");
		if (
			await context.db
				.prepare(
					`SELECT 1 AS value FROM receiving_methods
					 WHERE rail_code = ? AND normalized_target_value = ?
					 AND (rail_code != 'alipay' OR
					  COALESCE(json_extract(target_metadata, '$.product'), 'website') = ?)
					 LIMIT 1`,
				)
				.bind(first.code, target.value, alipayProduct ?? "website")
				.first<{ value: number }>()
		)
			throw paymentSettingsError("receiving_method_target_conflict");
		let encryptedConfiguration: string | null = null;
		if (target.credentials) {
			encryptedConfiguration = await encryptSecret(
				JSON.stringify(target.credentials),
				context.runtime.integrationConfigSecret,
			);
		}
		const now = Date.now();
		const id = crypto.randomUUID();
		const limits = parseReceivingUsdLimits(data.minAmount, data.maxAmount);
		await context.db.batch([
			context.db
				.prepare(
					`INSERT INTO receiving_methods
					(id, name, rail_code, target_type, target_value,
					 normalized_target_value, target_metadata, config_encrypted,
					 min_amount_minor, max_amount_minor, enabled, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
				)
				.bind(
					id,
					data.name,
					first.code,
					target.type,
					target.value,
					target.value,
					JSON.stringify(target.metadata),
					encryptedConfiguration,
					limits.min?.toString() ?? null,
					limits.max?.toString() ?? null,
					now,
					now,
				),
			...methods.results.map((method) =>
				context.db
					.prepare(
						`INSERT INTO receiving_method_assets
						(id, receiving_method_id, payment_asset_id, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?)`,
					)
					.bind(crypto.randomUUID(), id, method.id, now, now),
			),
		]);
		try {
			await context.db.batch([
				context.db
					.prepare(
						"UPDATE receiving_methods SET enabled = 1, updated_at = ? WHERE id = ?",
					)
					.bind(now, id),
				context.db
					.prepare(
						`UPDATE payment_ingresses SET reconcile_required_at = ?, updated_at = ?
						 WHERE enabled = 1 AND network = (
						  SELECT rail_code FROM receiving_methods WHERE id = ?
						 ) AND changes() = 1`,
					)
					.bind(now, now, id),
				context.db
					.prepare(
						`INSERT INTO audit_logs
					(id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
					VALUES (?, ?, 'receiving_method.created', 'receiving_method', ?, ?, ?, ?, ?)`,
					)
					.bind(
						crypto.randomUUID(),
						context.user.id,
						id,
						requestId(context.request),
						context.request.headers.get("cf-connecting-ip"),
						JSON.stringify({
							name: data.name,
							railCode: first.code,
							paymentMethodIds: methods.results.map((method) => method.id),
							assetCodes: methods.results.map((method) => method.asset_code),
							alipayProduct,
							minAmountMinor: limits.min?.toString() ?? null,
							maxAmountMinor: limits.max?.toString() ?? null,
							targetType: target.type,
							enabled: true,
						}),
						now,
					),
			]);
		} catch (error) {
			await context.db
				.prepare("DELETE FROM receiving_methods WHERE id = ?")
				.bind(id)
				.run();
			throw error;
		}
		return { id };
	});

const updateReceivingMethodInput = z.object({
	id: z.string().trim().min(1).max(100),
	name: z.string().trim().min(1).max(100),
	minAmount: z
		.string()
		.trim()
		.regex(/^\d+(?:\.\d+)?$/)
		.optional(),
	maxAmount: z
		.string()
		.trim()
		.regex(/^\d+(?:\.\d+)?$/)
		.optional(),
	alipayProduct: z.enum(["website", "face_to_face"]).optional(),
});

export const updateReceivingMethodFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof updateReceivingMethodInput>) =>
		updateReceivingMethodInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(
			systemPermission("receiving_methods", "update"),
		);
		const current = await context.db
			.prepare(
				`SELECT name, rail_code, target_value, normalized_target_value,
				 target_metadata,
				 min_amount_minor, max_amount_minor
				 FROM receiving_methods WHERE id = ?`,
			)
			.bind(data.id)
			.first<{
				name: string;
				rail_code: string;
				target_value: string;
				normalized_target_value: string;
				target_metadata: string | null;
				min_amount_minor: string | null;
				max_amount_minor: string | null;
			}>();
		if (!current) throw paymentSettingsError("receiving_method_not_found");
		if (data.alipayProduct && current.rail_code !== "alipay")
			throw paymentSettingsError("receiving_method_configuration_required");
		let targetMetadata = current.target_metadata;
		let previousAlipayProduct: "website" | "face_to_face" | undefined;
		let productChanged = false;
		if (data.alipayProduct && current.rail_code === "alipay") {
			const metadata = parseReceivingTargetMetadata(current.target_metadata);
			previousAlipayProduct =
				metadata.product === "face_to_face" ? "face_to_face" : "website";
			productChanged = previousAlipayProduct !== data.alipayProduct;
			if (productChanged) {
				if (
					await context.db
						.prepare(
							`SELECT 1 AS value FROM receiving_methods
							 WHERE id != ? AND rail_code = 'alipay'
							 AND normalized_target_value = ?
							 AND COALESCE(json_extract(target_metadata, '$.product'), 'website') = ?
							 LIMIT 1`,
						)
						.bind(data.id, current.normalized_target_value, data.alipayProduct)
						.first<{ value: number }>()
				)
					throw paymentSettingsError("receiving_method_target_conflict");
				if (
					!(await hasConfiguredAlipayConnection(
						context.db,
						current.target_value,
						data.alipayProduct,
						context.runtime.integrationConfigSecret,
					))
				)
					throw paymentSettingsError(
						"receiving_method_alipay_connection_required",
					);
				targetMetadata = JSON.stringify({
					...metadata,
					appId: current.target_value,
					product: data.alipayProduct,
				});
			}
		}
		const limits = parseReceivingUsdLimits(data.minAmount, data.maxAmount);
		const minAmountMinor = limits.min?.toString() ?? null;
		const maxAmountMinor = limits.max?.toString() ?? null;
		const limitsChanged =
			current.min_amount_minor !== minAmountMinor ||
			current.max_amount_minor !== maxAmountMinor;
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare(
					`UPDATE receiving_methods SET name = ?, target_metadata = ?,
				 min_amount_minor = ?, max_amount_minor = ?, updated_at = ? WHERE id = ?`,
				)
				.bind(
					data.name,
					targetMetadata,
					minAmountMinor,
					maxAmountMinor,
					now,
					data.id,
				),
			context.db
				.prepare(
					`INSERT INTO audit_logs
					 (id, actor_user_id, action, target_type, target_id, request_id,
					  ip_address, before, after, created_at)
					 VALUES (?, ?, 'receiving_method.updated', 'receiving_method',
					  ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					context.user.id,
					data.id,
					requestId(context.request),
					context.request.headers.get("cf-connecting-ip"),
					JSON.stringify({
						name: current.name,
						alipayProduct: previousAlipayProduct,
						minAmountMinor: current.min_amount_minor,
						maxAmountMinor: current.max_amount_minor,
					}),
					JSON.stringify({
						name: data.name,
						alipayProduct: data.alipayProduct,
						minAmountMinor,
						maxAmountMinor,
						limitsChanged,
						productChanged,
					}),
					now,
				),
		]);
		return { id: data.id, limitsChanged, productChanged };
	});

export const deleteReceivingMethodFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof receivingMethodIdInput>) =>
		receivingMethodIdInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(
			systemPermission("receiving_methods", "delete"),
		);
		return deleteReceivingMethod(context.db, data.id, {
			actorUserId: context.user.id,
			requestId: requestId(context.request),
			ipAddress: context.request.headers.get("cf-connecting-ip"),
		});
	});

function receivingTarget(
	kind: "chain" | "exchange" | "wallet" | "fiat",
	railCode: string,
	configuration: Record<string, string>,
	alipayProduct?: "website" | "face_to_face",
) {
	if (kind !== "chain") {
		const parsed = parseReceivingProviderConfiguration(railCode, configuration);
		return {
			type: parsed.targetType,
			value: parsed.targetValue,
			metadata: {
				[parsed.targetField]: parsed.targetValue,
				...(railCode === "alipay" && alipayProduct
					? { product: alipayProduct }
					: {}),
			},
			credentials: parsed.credentials,
		};
	}
	const value = configuration.address?.trim();
	if (!value)
		throw paymentSettingsError("receiving_method_configuration_required");
	return {
		type: "address" as const,
		value,
		metadata: { address: value },
		credentials: null,
	};
}

async function hasConfiguredAlipayConnection(
	db: D1Database,
	targetValue: string,
	product: "website" | "face_to_face",
	integrationConfigSecret: string,
) {
	const connections = await db
		.prepare(
			`SELECT credential.config_encrypted
			 FROM payment_ingresses connection
			 JOIN payment_ingress_credentials credential
			   ON credential.payment_ingress_id = connection.id
			 WHERE connection.rail_code = 'alipay' AND connection.enabled = 1
			 AND connection.provider_product = ?`,
		)
		.bind(product)
		.all<{ config_encrypted: string }>();
	for (const connection of connections.results) {
		try {
			const config: unknown = JSON.parse(
				await decryptSecret(
					connection.config_encrypted,
					integrationConfigSecret,
				),
			);
			if (
				config &&
				typeof config === "object" &&
				"appId" in config &&
				config.appId === targetValue
			)
				return true;
		} catch {
			// A malformed connection is not a usable Alipay target.
		}
	}
	return false;
}

function parseReceivingTargetMetadata(value: string | null) {
	if (value === null) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			parsed &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			Object.values(parsed).every((item) => typeof item === "string")
		)
			return parsed as Record<string, string>;
	} catch {
		// Stored target metadata must be valid JSON before it can be changed.
	}
	throw paymentSettingsError("receiving_method_configuration_required");
}

export const setReceivingMethodEnabledFn = createServerFn({ method: "POST" })
	.validator((input: { id: string; enabled: boolean }) =>
		receivingMethodIdInput.extend({ enabled: z.boolean() }).parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(
			systemPermission("receiving_methods", "update"),
		);
		const now = Date.now();
		const [result] = await context.db.batch([
			context.db
				.prepare(
					"UPDATE receiving_methods SET enabled = ?, updated_at = ? WHERE id = ? AND enabled != ?",
				)
				.bind(data.enabled, now, data.id, data.enabled),
			context.db
				.prepare(
					`UPDATE payment_ingresses SET reconcile_required_at = ?, updated_at = ?
						 WHERE enabled = 1 AND network = (
						  SELECT rail_code FROM receiving_methods WHERE id = ?
						 ) AND changes() = 1`,
				)
				.bind(now, now, data.id),
		]);
		const changed = (result?.meta.changes ?? 0) === 1;
		if (changed)
			await context.db
				.prepare(
					`INSERT INTO audit_logs
					 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
					 VALUES (?, ?, 'receiving_method.enabled_changed', 'receiving_method', ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					context.user.id,
					data.id,
					requestId(context.request),
					context.request.headers.get("cf-connecting-ip"),
					JSON.stringify({ enabled: data.enabled }),
					now,
				)
				.run();
		return { ...data, changed };
	});
