export interface PaymentScanMessage {
	kind: "payment.scan";
	version: 1;
	receivingMethodId: string;
	orderId: string;
	alipayPolling?: true;
}

export interface PaymentProviderEventMessage {
	kind: "payment.provider_event";
	version: 1;
	eventId: string;
}

export interface PaymentRateSyncMessage {
	kind: "payment.rate_sync";
	version: 1;
	category: "crypto" | "fiat";
}

export interface PaymentRpcHealthMessage {
	kind: "payment.rpc_health";
	version: 1;
	connectionIds: string[];
}

export interface PaymentEventSourceReconcileMessage {
	kind: "payment.event_source_reconcile";
	version: 1;
	sourceId: string;
}

export type PaymentQueueMessage =
	| PaymentScanMessage
	| PaymentProviderEventMessage
	| PaymentRateSyncMessage
	| PaymentRpcHealthMessage
	| PaymentEventSourceReconcileMessage;

export type ProviderPaymentTrigger = {
	transactionHash: string;
	eventIndex: number;
	fromAddress: string;
	toAddress: string;
	assetCode: string;
	contractAddress: string | null;
	blockNumber: string;
	removed: boolean;
};
