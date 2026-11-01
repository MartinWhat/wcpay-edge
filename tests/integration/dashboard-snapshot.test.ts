import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	dashboardSnapshotTtlMs,
	loadAdminDashboard,
} from "#/features/dashboard/server/admin";
import { queryAdminDashboard } from "#/features/dashboard/server/query";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("admin dashboard snapshot", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-dashboard-snapshot" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
	});

	afterAll(async () => miniflare.dispose());

	it("shares one replica-session query round per binding and ten seconds", async () => {
		const counters = createDatastoreCounters();
		const binding = instrumentD1(db, counters);
		const request = () =>
			new Request("https://pay.example/_serverFn/dashboard", {
				headers: { cookie: "gmpay_d1_bookmark=0000-0001" },
			});
		const now = Date.now();

		const first = await loadAdminDashboard(request(), binding, now);
		const second = await loadAdminDashboard(request(), binding, now + 5_000);
		expect(second).toBe(first);
		expect(counters.d1Batch).toBe(1);
		expect(first.orders.total).toBe(0);

		const refreshed = await loadAdminDashboard(
			request(),
			binding,
			now + dashboardSnapshotTtlMs + 1,
		);
		expect(refreshed).not.toBe(first);
		expect(counters.d1Batch).toBe(2);
	});

	it("excludes test orders from dashboard counts, trends, and recent orders", async () => {
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					`INSERT INTO orders
					 (id, external_order_id, status, amount_minor, currency, currency_decimals,
					  received_amount_units, is_test, expires_at, version, created_at, updated_at)
					 VALUES ('dashboard-real-order', 'dashboard-real-order', 'pending', '100', 'USD', 2, '0', 0, ?, 0, ?, ?)`,
				)
				.bind(now + 900_000, now, now),
			db
				.prepare(
					`INSERT INTO orders
					 (id, external_order_id, status, amount_minor, currency, currency_decimals,
					  received_amount_units, is_test, expires_at, version, created_at, updated_at)
					 VALUES ('dashboard-test-order', 'dashboard-test-order', 'paid', '100', 'USD', 2, '0', 1, ?, 0, ?, ?)`,
				)
				.bind(now + 900_000, now + 1, now + 1),
		]);

		const dashboard = await queryAdminDashboard(db, now + 2);
		expect(dashboard.orders).toMatchObject({ total: 1, active: 1, paid: 0 });
		expect(
			dashboard.dailyOrders.reduce((total, day) => total + day.orderCount, 0),
		).toBe(1);
		expect(dashboard.recentOrders.map((order) => order.id)).toEqual([
			"dashboard-real-order",
		]);
	});
});
