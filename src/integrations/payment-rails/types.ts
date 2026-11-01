import type { PaymentRailKind } from "#/features/payment-settings/rail-kind";

export type HostedPayment = {
	providerOrderId: string | null;
	paymentUrl?: string;
	qrCode?: string;
};

export type ProviderPayment = {
	providerTradeId: string;
	amountMinor: string;
	currency: string;
	currencyDecimals: number;
	status: "pending" | "succeeded" | "rejected" | "refunded";
};

export interface FiatPaymentProvider {
	readonly railCode: string;
	readonly kind: Extract<PaymentRailKind, "fiat">;
	createHostedPayment(input: {
		orderId: string;
		amountMinor: string;
		currency: string;
		currencyDecimals: number;
		description: string;
		notifyUrl: string;
		returnUrl?: string;
	}): Promise<HostedPayment>;
	verifyNotification(input: Record<string, string>): boolean;
	parseNotification(input: Record<string, string>): ProviderPayment;
	queryPayment(providerOrderId: string): Promise<ProviderPayment | null>;
}
