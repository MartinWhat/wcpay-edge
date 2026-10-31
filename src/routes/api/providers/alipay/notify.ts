import { createFileRoute } from "@tanstack/react-router";
import { handleAlipayNotification } from "#/features/payments/server/alipay-notification";
import { getEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/providers/alipay/notify")({
	server: {
		handlers: {
			POST: ({ request }) => handleAlipayNotification(request, getEnv()),
		},
	},
});
