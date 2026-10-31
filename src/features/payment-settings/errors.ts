import { DomainError } from "#/lib/domain-error";

export type PaymentSettingsErrorCode =
	| "payment_connection_not_found"
	| "payment_connection_transport_unsupported"
	| "payment_rail_not_found"
	| "payment_rail_connection_managed"
	| "payment_connection_unhealthy"
	| "payment_connection_not_configured"
	| "payment_method_not_found"
	| "receiving_method_mixed_rail"
	| "receiving_method_not_found"
	| "receiving_method_invalid_limits"
	| "receiving_method_configuration_required"
	| "receiving_method_not_ready"
	| "exchange_rate_not_found"
	| "fiat_rate_credentials_required";

const errorDefinitions: Record<
	PaymentSettingsErrorCode,
	{ status: number; message: string }
> = {
	payment_connection_not_found: {
		status: 404,
		message: "Payment connection not found",
	},
	payment_connection_transport_unsupported: {
		status: 422,
		message: "Payment connection transport is not supported",
	},
	payment_rail_not_found: {
		status: 404,
		message: "Payment rail not found",
	},
	payment_rail_connection_managed: {
		status: 409,
		message: "Payment rail connection is managed by the built-in provider",
	},
	payment_connection_unhealthy: {
		status: 409,
		message: "Payment connection health check failed",
	},
	payment_connection_not_configured: {
		status: 409,
		message: "Payment connection credentials are not configured",
	},
	payment_method_not_found: {
		status: 404,
		message: "Payment method not found",
	},
	receiving_method_mixed_rail: {
		status: 422,
		message: "Receiving method assets must use the same payment rail",
	},
	receiving_method_not_found: {
		status: 404,
		message: "Receiving method not found",
	},
	receiving_method_invalid_limits: {
		status: 422,
		message: "Receiving method amount limits are invalid",
	},
	receiving_method_configuration_required: {
		status: 422,
		message: "Receiving method configuration is required",
	},
	receiving_method_not_ready: {
		status: 409,
		message: "Receiving method is not ready",
	},
	exchange_rate_not_found: {
		status: 404,
		message: "Exchange rate not found",
	},
	fiat_rate_credentials_required: {
		status: 422,
		message: "Fiat rate provider credentials are required",
	},
};

export function paymentSettingsError(code: PaymentSettingsErrorCode) {
	const definition = errorDefinitions[code];
	return new DomainError(code, definition.status, definition.message);
}
