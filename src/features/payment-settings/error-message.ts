import { m } from "#/paraglide/messages";

export function paymentSettingsOperationErrorMessage(error: unknown) {
	if (!error || typeof error !== "object" || !("code" in error))
		return m.payment_settings_operation_failed();
	switch (error.code) {
		case "invalid_input":
			return m.payment_settings_error_invalid_input();
		case "payment_connection_not_found":
			return m.payment_settings_error_connection_not_found();
		case "payment_connection_transport_unsupported":
			return m.payment_settings_error_connection_transport_unsupported();
		case "payment_rail_not_found":
			return m.payment_settings_error_rail_not_found();
		case "payment_rail_connection_managed":
			return m.payment_settings_error_rail_connection_managed();
		case "payment_connection_unhealthy":
			return m.payment_settings_error_connection_unhealthy();
		case "payment_connection_not_configured":
			return m.receiving_configuration_required();
		case "payment_method_not_found":
			return m.payment_settings_error_method_not_found();
		case "receiving_method_mixed_rail":
			return m.payment_settings_error_mixed_rail();
		case "receiving_method_target_conflict":
			return m.payment_settings_error_receiving_method_target_conflict();
		case "receiving_method_not_found":
			return m.payment_settings_error_receiving_method_not_found();
		case "receiving_method_invalid_limits":
			return m.payment_settings_error_invalid_limits();
		case "receiving_method_configuration_required":
			return m.receiving_configuration_required();
		case "receiving_method_not_ready":
			return m.payment_settings_error_receiving_method_not_ready();
		case "exchange_rate_not_found":
			return m.payment_settings_error_rate_not_found();
		case "fiat_rate_credentials_required":
			return m.payment_settings_error_rate_credentials_required();
		default:
			return m.payment_settings_operation_failed();
	}
}

export function paymentConnectionHealthErrorMessage(
	errorCode: string | null | undefined,
) {
	return errorCode === "configuration"
		? m.payment_settings_error_connection_configuration()
		: m.infrastructure_rpc_unhealthy();
}
