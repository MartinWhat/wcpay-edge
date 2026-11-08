import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	advancePaymentScanCursor,
	handlePaymentScan,
	refreshPendingPaymentTransactions,
} from "#/server/queue";
import { runMaintenance } from "#/server/scheduled";
import { MockTronAdapter } from "../fixtures/mock-tron-adapter";
import { applyMigrations } from "./migrations";

describe("payment scan scheduling fairness", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const dependencies = {
		expire: vi.fn().mockResolvedValue(0),
		recoverWebhooks: vi.fn().mockResolvedValue({ queued: 0, failed: 0 }),
	};

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-payment-scan-fairness" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("does not advance a scan lease or expose details when Queue rejects the batch", async () => {
		const sendBatch = vi.fn().mockRejectedValue(new Error("queue unavailable"));
		await expect(
			runMaintenance(
				{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
				"*/1 * * * *",
				dependencies,
			),
		).rejects.toMatchObject({
			code: "queue_enqueue_failed",
			status: 502,
			message: "Payment Queue rejected the scheduled scan batch",
		});
		const leased = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM orders WHERE last_payment_scan_at IS NOT NULL",
			)
			.first<{ count: number }>();
		expect(leased?.count).toBe(0);
		const run = await db
			.prepare(
				"SELECT error_code FROM operation_task_runs WHERE task = 'payment_scan_enqueue' ORDER BY started_at DESC, id DESC LIMIT 1",
			)
			.first<{ error_code: string | null }>();
		expect(run?.error_code).toBe("queue_enqueue_failed");
	});

	it("rotates through active orders instead of starving later rows", async () => {
		const scanned: string[] = [];
		for (let run = 0; run < 3; run += 1) {
			await db
				.prepare(
					"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
				)
				.run();
			const sendBatch = vi.fn().mockImplementation(async (messages) => {
				const scan = messages.find(
					(message: { body: { kind: string } }) =>
						message.body.kind === "payment.scan",
				);
				if (scan) scanned.push(scan.body.orderId);
			});
			await runMaintenance(
				{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
				"*/1 * * * *",
				dependencies,
			);
		}
		expect(scanned).toEqual(["order-a", "order-b", "order-c"]);
	});

	it("backs off healthy active Webhook sources and restores normal scans when degraded", async () => {
		const now = Date.now();
		await db.batch([
			db.prepare("UPDATE orders SET status = 'expired', updated_at = 0"),
			db
				.prepare(
					`UPDATE orders SET status = 'pending', expires_at = ?,
					 last_payment_scan_at = ?, updated_at = ? WHERE id = 'order-a'`,
				)
				.bind(now + 600_000, now - 5 * 60_000, now),
			db
				.prepare(
					`INSERT INTO payment_ingresses
					 (id, name, type, transport, provider, network, external_network, external_source_id,
					  config_encrypted, mode, enabled, health_status, created_at, updated_at)
					 VALUES ('alchemy-tron', 'Payment event push', 'provider_webhook', 'webhook', 'alchemy', 'tron', 'TRON_MAINNET',
					  'alchemy-tron-source', 'encrypted', 'active', 1, 'healthy', ?, ?)`,
				)
				.bind(now, now),
			db.prepare(
				"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
			),
		]);
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const env = {
			DB: db,
			PAYMENT_QUEUE: { sendBatch },
		} as unknown as Env;

		await runMaintenance(env, "*/1 * * * *", dependencies);
		expect(sendBatch).not.toHaveBeenCalled();

		await db.batch([
			db.prepare(
				"UPDATE payment_ingresses SET health_status = 'degraded' WHERE id = 'alchemy-tron'",
			),
			db.prepare(
				"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
			),
		]);
		await runMaintenance(env, "*/1 * * * *", dependencies);
		expect(sendBatch).toHaveBeenCalledOnce();
		const scan = sendBatch.mock.calls
			.flatMap(([messages]) => messages)
			.find((message) => message.body.kind === "payment.scan");
		expect(scan?.body.orderId).toBe("order-a");

		await db.prepare("DELETE FROM payment_ingresses").run();
	});

	it("advances provider cursors monotonically and preserves empty scans", async () => {
		await expect(
			advancePaymentScanCursor(db, "order-a", []),
		).resolves.toBeNull();
		await advancePaymentScanCursor(db, "order-a", [{ blockNumber: 100n }]);
		await advancePaymentScanCursor(db, "order-a", [{ blockNumber: 90n }]);
		await advancePaymentScanCursor(db, "order-a", [
			{ blockNumber: 99n },
			{ blockNumber: 101n },
		]);
		const order = await db
			.prepare("SELECT payment_scan_cursor FROM orders WHERE id = 'order-a'")
			.first<{ payment_scan_cursor: string | null }>();
		expect(order?.payment_scan_cursor).toBe("101");
	});

	it("keeps the persisted provider cursor in D1 for the Queue consumer", async () => {
		await db.batch([
			db.prepare("UPDATE orders SET last_payment_scan_at = NULL"),
			db.prepare(
				"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
			),
		]);
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		await runMaintenance(
			{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
			"*/1 * * * *",
			dependencies,
		);
		expect(sendBatch.mock.calls[0]?.[0]?.[0]?.body).toMatchObject({
			orderId: "order-a",
		});
		expect(sendBatch.mock.calls[0]?.[0]?.[0]?.body).not.toHaveProperty(
			"sinceBlock",
		);
		const stored = await db
			.prepare("SELECT payment_scan_cursor FROM orders WHERE id = 'order-a'")
			.first<{ payment_scan_cursor: string | null }>();
		expect(stored?.payment_scan_cursor).toBe("101");
	});

	it("refreshes older confirming payments after the cursor advances", async () => {
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT INTO blockchain_transactions (id, network, tx_hash, event_index, from_address, to_address, asset_code, amount_units, block_number, block_hash, confirmations, status, observed_at, created_at, updated_at) VALUES ('bt-pending', 'tron', 'pending-hash', 0, 'from', 'TAddressa', 'TRX', '1', '50', 'old-block', 1, 'pending', ?, ?, ?)",
				)
				.bind(now, now, now),
			db
				.prepare(
					"INSERT INTO order_payments (id, order_id, transaction_id, amount_units, confirmations, status, detected_at, created_at, updated_at) VALUES ('op-pending', 'order-a', 'tron:pending-hash:0', '1', 1, 'confirming', ?, ?, ?)",
				)
				.bind(now, now, now),
		]);
		const adapter = new MockTronAdapter();
		adapter.record({
			network: "tron",
			hash: "pending-hash",
			eventIndex: 0,
			from: "from",
			to: "TAddressa",
			assetCode: "TRX",
			amountUnits: 1n,
			blockNumber: 50n,
			blockHash: "new-block",
			confirmations: 5,
			timestamp: new Date(now),
			success: true,
			canonical: true,
		});
		await expect(
			refreshPendingPaymentTransactions(db, "order-a", adapter),
		).resolves.toMatchObject([
			{ hash: "pending-hash", confirmations: 5, blockHash: "new-block" },
		]);
	});

	it("limits expired scans and skips settled Alipay orders", async () => {
		const now = Date.now();
		await db.batch([
			db.prepare("UPDATE orders SET status = 'expired', updated_at = 0"),
			db
				.prepare(
					"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('alipay', 'Alipay', 'fiat', 'alipay', ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('alipay-asset', 'alipay', 'CNY', 'CNY', 'fiat', 2, ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('method-alipay', 'Alipay', 'alipay', 'provider', 'app-id', 'app-id', 1, ?, ?)",
				)
				.bind(now, now),
			db.prepare(
				"UPDATE receiving_methods SET enabled = 0 WHERE id = 'method'",
			),
			db.prepare(
				"UPDATE system_settings SET value = '2' WHERE key = 'payments.scan_batch_size'",
			),
			db.prepare(
				"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
			),
			db
				.prepare(
					"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, paid_at, version, created_at, updated_at) VALUES ('order-recent-paid', 'recent-paid', 'paid', '100', 'USD', 2, 'asset', '1', ?, ?, 1, ?, ?)",
				)
				.bind(now - 1, now - 60_000, now, now),
			db
				.prepare(
					"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, paid_at, version, created_at, updated_at) VALUES ('order-old-paid', 'old-paid', 'paid', '100', 'USD', 2, 'asset', '1', ?, ?, 1, ?, ?)",
				)
				.bind(now - 1, now - 25 * 3_600_000, now, now),
			db
				.prepare(
					"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES ('order-recent-expired', 'recent-expired', 'expired', '100', 'USD', 2, 'asset', '0', ?, 1, ?, ?)",
				)
				.bind(now - 1, now, now),
			db
				.prepare(
					"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES ('order-old-expired', 'old-expired', 'expired', '100', 'USD', 2, 'asset', '0', ?, 1, ?, ?)",
				)
				.bind(now - 16 * 60_000, now - 20 * 60_000, now - 16 * 60_000),
			db
				.prepare(
					"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, paid_at, version, created_at, updated_at) VALUES ('order-alipay-paid', 'alipay-paid', 'paid', '100', 'CNY', 2, 'alipay-asset', '100', ?, ?, 1, ?, ?)",
				)
				.bind(now - 1, now - 1, now, now),
		]);
		await db.batch([
			paymentSnapshot(db, "order-recent-paid", "TRecentPaid", now),
			paymentSnapshot(db, "order-old-paid", "TOldPaid", now),
			paymentSnapshot(db, "order-recent-expired", "TRecentExpired", now),
			db
				.prepare(
					`INSERT INTO order_payment_snapshots
					 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
					  asset_id, asset_code, decimals, target_value, adapter,
					  required_confirmations, expected_amount_units, created_at)
					 VALUES ('order-alipay-paid', 'method-alipay', 'Alipay', 'alipay', 'fiat',
					  'alipay-asset', 'CNY', 2, 'app-id', 'alipay', 1, '100', ?)`,
				)
				.bind(now),
		]);
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		await runMaintenance(
			{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
			"*/1 * * * *",
			dependencies,
		);
		expect(
			sendBatch.mock.calls
				.flatMap(([messages]) => messages)
				.filter((message) => message.body.kind === "payment.scan")
				.map((message) => message.body.orderId),
		).toEqual(["order-recent-paid", "order-recent-expired"]);

		const ack = vi.fn();
		const retry = vi.fn();
		await handlePaymentScan(
			{
				id: "alipay-scan",
				timestamp: new Date(now),
				attempts: 1,
				body: {
					kind: "payment.scan",
					version: 1,
					orderId: "order-alipay-paid",
					receivingMethodId: "method-alipay",
				},
				ack,
				retry,
			} as unknown as Parameters<typeof handlePaymentScan>[0],
			{ DB: db } as Env,
		);
		expect(ack).toHaveBeenCalledOnce();
		expect(retry).not.toHaveBeenCalled();
	});

	it("schedules pending Alipay queries and only scans recently expired orders", async () => {
		const now = Date.now();
		const orders = [
			["poll-alipay-pending", "pending", now + 600_000, now, now],
			[
				"poll-alipay-recent-expired",
				"expired",
				now - 600_000,
				now - 300_000,
				now - 600_000,
			],
			[
				"poll-alipay-old-expired-recent-update",
				"expired",
				now - 16 * 60_000,
				now - 60_000,
				now - 16 * 60_000,
			],
			[
				"poll-alipay-pending-past-cutoff",
				"pending",
				now - 16 * 60_000,
				now,
				now - 16 * 60_000,
			],
			["poll-alipay-paid", "paid", now - 1, now - 1, now - 1],
		] as const;
		await db.batch([
			db.prepare("UPDATE orders SET status = 'expired', updated_at = 0"),
			db.prepare(
				"DELETE FROM order_payment_snapshots WHERE rail_code = 'alipay'",
			),
			db.prepare("DELETE FROM orders WHERE payment_asset_id = 'alipay-asset'"),
			db.prepare(
				"UPDATE system_settings SET value = '20' WHERE key = 'payments.scan_batch_size'",
			),
			db.prepare(
				"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
			),
			db
				.prepare(
					"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('alipay', 'Alipay', 'fiat', 'alipay', ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT OR IGNORE INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('alipay-asset', 'alipay', 'CNY', 'CNY', 'fiat', 2, ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT OR IGNORE INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('method-alipay', 'Alipay', 'alipay', 'provider', 'app-id', 'app-id', 1, ?, ?)",
				)
				.bind(now, now),
			...orders.flatMap(([id, status, expiresAt, updatedAt, createdAt]) => [
				db
					.prepare(
						`INSERT INTO orders
						 (id, external_order_id, status, amount_minor, currency, currency_decimals,
						  payment_asset_id, received_amount_units, expires_at, paid_at, version,
						  created_at, updated_at)
						 VALUES (?, ?, ?, '100', 'CNY', 2, 'alipay-asset', ?, ?, ?, 0, ?, ?)`,
					)
					.bind(
						id,
						id,
						status,
						status === "paid" ? "100" : "0",
						expiresAt,
						status === "paid" ? updatedAt : null,
						createdAt,
						updatedAt,
					),
				db
					.prepare(
						`INSERT INTO order_payment_snapshots
						 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
						  asset_id, asset_code, decimals, target_value, adapter,
						  required_confirmations, expected_amount_units, created_at)
						 VALUES (?, 'method-alipay', 'Alipay', 'alipay', 'fiat',
						  'alipay-asset', 'CNY', 2, 'app-id', 'alipay', 1, '100', ?)`,
					)
					.bind(id, now),
			]),
		]);

		const sendBatch = vi.fn().mockResolvedValue(undefined);
		await runMaintenance(
			{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
			"*/1 * * * *",
			dependencies,
		);
		const scanned = sendBatch.mock.calls
			.flatMap(([messages]) => messages)
			.filter((message) => message.body.kind === "payment.scan")
			.map((message) => message.body.orderId)
			.sort();
		expect(scanned).toEqual([
			"poll-alipay-pending",
			"poll-alipay-recent-expired",
		]);
	});

	it("dispatches USDT first within the oldest due batch without starving other assets", async () => {
		const now = Date.now();
		const pending = [
			["priority-trx-a", "TRX"],
			["priority-usdt-a", "USDT"],
			["priority-trx-b", "TRX"],
			["priority-usdt-b", "USDT"],
			["priority-trx-c", "TRX"],
			["priority-usdt-c", "USDT"],
		] as const;
		await db.batch([
			db.prepare("UPDATE orders SET status = 'expired', updated_at = 0"),
			db.prepare(
				"DELETE FROM order_payment_snapshots WHERE rail_code = 'alipay'",
			),
			db.prepare("DELETE FROM orders WHERE payment_asset_id = 'alipay-asset'"),
			db.prepare(
				"UPDATE system_settings SET value = '4' WHERE key = 'payments.scan_batch_size'",
			),
			db
				.prepare(
					"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, contract_address, decimals, created_at, updated_at) VALUES ('asset-usdt', 'tron', 'USDT', 'USDT', 'token', 'TUsdtContract', 6, ?, ?)",
				)
				.bind(now, now),
			...pending.flatMap(([id, code], index) => {
				const assetId = code === "USDT" ? "asset-usdt" : "asset";
				return [
					db
						.prepare(
							"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, created_at, updated_at) VALUES (?, ?, 'pending', '100', 'USD', 2, ?, '0', ?, ?, ?)",
						)
						.bind(id, id, assetId, now + 600_000, now + index, now + index),
					paymentSnapshot(db, id, `TAddress${index}`, now + index, {
						id: assetId,
						code,
					}),
				];
			}),
		]);
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		for (let run = 0; run < 2; run += 1) {
			await db
				.prepare(
					"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
				)
				.run();
			await runMaintenance(
				{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
				"*/1 * * * *",
				dependencies,
			);
		}
		expect(
			sendBatch.mock.calls.map(([messages]) =>
				messages.map(
					(message: { body: { orderId: string } }) => message.body.orderId,
				),
			),
		).toEqual([
			[
				"priority-usdt-a",
				"priority-usdt-b",
				"priority-trx-a",
				"priority-trx-b",
			],
			["priority-usdt-c", "priority-trx-c"],
		]);
	});
});

function paymentSnapshot(
	db: D1Database,
	orderId: string,
	targetValue: string,
	now: number,
	asset = { id: "asset", code: "TRX" },
) {
	return db
		.prepare(
			`INSERT INTO order_payment_snapshots
			 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
			  asset_id, asset_code, decimals, target_value, connection_id, adapter,
			  required_confirmations, expected_amount_units, created_at)
			 VALUES (?, 'method', 'Primary TRX', 'tron', 'chain', ?, ?, 6,
			  ?, 'connection', 'tron', 1, '1000000', ?)`,
		)
		.bind(orderId, asset.id, asset.code, targetValue, now);
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
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('asset', 'tron', 'TRX', 'TRX', 'native', 6, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, enabled, health_status, created_at, updated_at) VALUES ('connection', 'tron', 'TRON', 'rpc', 'https://api.trongrid.io', 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 1, created_at = ?, updated_at = ? WHERE id = 'asset'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('method', 'Primary TRX', 'tron', 'address', 'TAddressa', 'TAddressa', 1, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('payments.scan_batch_size', '1', 0, ?, ?)",
			)
			.bind(now, now),
		...(["a", "b", "c"] as const).flatMap((suffix, index) => [
			db
				.prepare(
					"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, created_at, updated_at) VALUES (?, ?, 'pending', '100', 'USD', 2, 'asset', '0', ?, ?, ?)",
				)
				.bind(
					`order-${suffix}`,
					`merchant-${suffix}`,
					now + 600_000,
					now + index,
					now + index,
				),
			db
				.prepare(
					`INSERT INTO order_payment_snapshots
					 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
					  asset_id, asset_code, decimals, target_value, connection_id, adapter,
					  required_confirmations, expected_amount_units, created_at)
					 VALUES (?, 'method', 'Primary TRX', 'tron', 'chain', 'asset', 'TRX', 6,
					  ?, 'connection', 'tron', 1, '1000000', ?)`,
				)
				.bind(`order-${suffix}`, `TAddress${suffix}`, now + index),
		]),
	]);
}
