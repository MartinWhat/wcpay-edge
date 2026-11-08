import { AlipayProvider } from "#/integrations/payment-rails/alipay";
import { decryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig, type RuntimeConfig } from "#/server/runtime-config";

export async function loadAlipayProviderForOrder(
	db: D1Database,
	orderId: string,
	runtime?: RuntimeConfig,
) {
	const row = await db
		.prepare(
			`SELECT credential.config_encrypted
			 FROM order_payment_snapshots ops
			 JOIN payment_ingresses connection ON connection.id = ops.connection_id
			 LEFT JOIN payment_ingress_credentials credential
			   ON credential.payment_ingress_id = connection.id
			 WHERE ops.order_id = ? AND ops.rail_code = 'alipay' LIMIT 1`,
		)
		.bind(orderId)
		.first<{ config_encrypted: string | null }>();
	if (!row?.config_encrypted) return null;
	const settings = runtime ?? (await loadRuntimeConfig(db));
	const configuration = await decryptSecret(
		row.config_encrypted,
		settings.integrationConfigSecret,
	);
	return AlipayProvider.create(JSON.parse(configuration));
}
