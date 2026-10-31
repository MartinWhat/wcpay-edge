export const paymentRailKinds = [
	"chain",
	"exchange",
	"wallet",
	"fiat",
] as const;

export type PaymentRailKind = (typeof paymentRailKinds)[number];
