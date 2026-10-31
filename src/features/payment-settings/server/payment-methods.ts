import { createServerFn } from "@tanstack/react-start";
import { paymentSettingsPermission } from "#/features/access/system-rbac";
import { adminContext } from "#/features/payment-settings/server/admin-context";

export const listPaymentMethodsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await adminContext(paymentSettingsPermission("read"));
	const rows = await db
		.prepare(
			`SELECT asset.id, asset.code || ' · ' || rail.name AS name,
			 asset.default_confirmations,
			 asset.id AS asset_id, asset.code AS asset_code, asset.symbol,
			 asset.kind AS asset_kind, asset.decimals, asset.contract_address,
			 rail.code AS rail_code, rail.name AS rail_name, rail.kind AS rail_kind
			 FROM payment_assets asset
			 JOIN payment_rails rail ON rail.code = asset.rail_code
			 ORDER BY rail.kind, rail.name, asset.code`,
		)
		.all<{
			id: string;
			name: string;
			default_confirmations: number;
			asset_id: string;
			asset_code: string;
			symbol: string;
			asset_kind: string;
			decimals: number;
			contract_address: string | null;
			rail_code: string;
			rail_name: string;
			rail_kind: "chain" | "exchange" | "wallet" | "fiat";
		}>();
	return rows.results;
});
