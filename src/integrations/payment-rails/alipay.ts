import { z } from "zod";
import type {
	FiatPaymentProvider,
	HostedPayment,
	ProviderPayment,
} from "#/integrations/payment-rails/types";
import { isSafePublicUrl } from "#/lib/webhook-url";

export const alipayEndpoints = {
	production: "https://openapi.alipay.com",
	sandbox: "https://openapi-sandbox.dl.alipaydev.com",
} as const;

export type AlipayEnvironment = keyof typeof alipayEndpoints;
export type AlipayProduct = "website" | "face_to_face";

const configSchema = z
	.object({
		appId: z
			.string()
			.trim()
			.regex(/^\d{8,32}$/),
		privateKey: z.string().min(1),
		alipayPublicKey: z.string().min(1),
		keyType: z.enum(["PKCS1", "PKCS8"]).default("PKCS8"),
		endpoint: z.url().default(alipayEndpoints.production),
		timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
	})
	.strict();

const queryResponseSchema = z.object({
	code: z.string().max(64),
	msg: z.string().max(256),
	sub_code: z.string().max(128).optional(),
	sub_msg: z.string().max(256).optional(),
	out_trade_no: z.string().max(128).optional(),
	trade_no: z.string().max(64).optional(),
	trade_status: z.string().max(64).optional(),
	total_amount: z.string().max(32).optional(),
	receipt_amount: z.string().max(32).optional(),
	send_pay_date: z.string().max(64).optional(),
});

const precreateResponseSchema = z.object({
	code: z.string(),
	msg: z.string(),
	out_trade_no: z.string(),
	qr_code: z.string().trim().min(1).max(2048),
});

export type AlipayConfig = z.infer<typeof configSchema>;
export type AlipayQueryResponse = {
	code: string;
	message: string;
	subCode: string | null;
	subMessage: string | null;
	externalOrderId: string | null;
	providerTradeId: string | null;
	tradeStatus: string | null;
	totalAmount: string | null;
	receiptAmount: string | null;
	paidAt: string | null;
};
export type AlipayQueryInspection = {
	outcome: "success" | "not_found" | "rejected" | "mismatch";
	response: AlipayQueryResponse;
	payment: ProviderPayment | null;
};
type SdkClient = {
	pageExecute(
		method: string,
		httpMethod: "GET",
		params: {
			notifyUrl: string;
			returnUrl?: string;
			bizContent: Record<string, string>;
		},
	): string;
	checkNotifySignV2(input: Record<string, string>): boolean;
	sdkExecute(method: string, params: Record<string, unknown>): string;
	rsaCheck(
		signContent: string,
		sign: string,
		signType: "RSA" | "RSA2",
	): boolean;
};

type AlipayErrorKind = "configuration" | "network" | "provider" | "signature";
export type AlipayErrorDiagnostics = {
	httpStatus?: number;
	gatewayCode?: string;
	gatewaySubCode?: string;
	transportCode?: string;
};

const defaultAlipayErrorCodes: Record<AlipayErrorKind, string> = {
	configuration: "ALIPAY_CONFIGURATION_ERROR",
	network: "ALIPAY_GATEWAY_NETWORK_ERROR",
	provider: "ALIPAY_PROVIDER_ERROR",
	signature: "ALIPAY_RESPONSE_SIGNATURE_ERROR",
};

export class AlipayError extends Error {
	constructor(
		message: string,
		readonly kind: AlipayErrorKind,
		readonly code = defaultAlipayErrorCodes[kind],
		readonly diagnostics: AlipayErrorDiagnostics = {},
	) {
		super(message);
		this.name = "AlipayError";
	}
}

export class AlipayProvider implements FiatPaymentProvider {
	readonly railCode = "alipay";
	readonly kind = "fiat" as const;
	readonly config: AlipayConfig;
	readonly sdk: SdkClient;

	private constructor(
		configuration: unknown,
		private readonly fetcher: typeof fetch = fetch,
		sdk: SdkClient,
	) {
		const parsed = configSchema.safeParse(configuration);
		if (!parsed.success)
			throw new AlipayError(
				"Alipay provider configuration is invalid",
				"configuration",
				"ALIPAY_CONFIGURATION_INVALID",
			);
		this.config = parsed.data;
		this.sdk = sdk;
	}

	static async create(
		configuration: unknown,
		fetcher: typeof fetch = fetch,
	): Promise<AlipayProvider> {
		const parsed = configSchema.safeParse(configuration);
		if (!parsed.success)
			throw new AlipayError(
				"Alipay provider configuration is invalid",
				"configuration",
				"ALIPAY_CONFIGURATION_INVALID",
			);
		const { AlipaySdk } = await import("alipay-sdk");
		const sdk = new AlipaySdk({
			appId: parsed.data.appId,
			privateKey: parsed.data.privateKey,
			alipayPublicKey: parsed.data.alipayPublicKey,
			keyType: parsed.data.keyType,
			endpoint: parsed.data.endpoint,
			gateway: `${parsed.data.endpoint.replace(/\/$/, "")}/gateway.do`,
			timeout: parsed.data.timeoutMs,
		});
		return new AlipayProvider(configuration, fetcher, sdk);
	}

	async createHostedPayment(input: {
		orderId: string;
		amountMinor: string;
		currency: string;
		currencyDecimals: number;
		description: string;
		notifyUrl: string;
		returnUrl?: string;
		product?: AlipayProduct;
	}): Promise<HostedPayment> {
		if (input.product === "face_to_face") {
			if (input.currency !== "CNY")
				throw new AlipayError(
					"Alipay only supports CNY orders",
					"configuration",
				);
			if (!isSafePublicUrl(input.notifyUrl, ["https:"]))
				throw new AlipayError(
					"Alipay notify URL must use HTTPS",
					"configuration",
				);
			const signed = this.sdk.sdkExecute("alipay.trade.precreate", {
				notifyUrl: input.notifyUrl,
				bizContent: {
					outTradeNo: input.orderId,
					totalAmount: minorAmount(input.amountMinor, input.currencyDecimals),
					subject: input.description.slice(0, 256),
				},
			});
			try {
				const response = await this.requestGateway(signed);
				const parsed = precreateResponseSchema.safeParse(response.data);
				if (
					!parsed.success ||
					parsed.data.code !== "10000" ||
					parsed.data.out_trade_no !== input.orderId
				)
					throw new AlipayError(
						"Alipay did not create the QR payment",
						"provider",
					);
				return { providerOrderId: input.orderId, qrCode: parsed.data.qr_code };
			} catch (error) {
				if (error instanceof AlipayError) throw error;
				throw new AlipayError(
					"Alipay could not create the QR payment",
					"provider",
				);
			}
		}
		if (input.product !== undefined && input.product !== "website")
			throw new AlipayError(
				"Alipay payment product is invalid",
				"configuration",
			);
		if (input.currency !== "CNY")
			throw new AlipayError("Alipay only supports CNY orders", "configuration");
		if (!isSafePublicUrl(input.notifyUrl, ["https:"]))
			throw new AlipayError(
				"Alipay notify URL must use HTTPS",
				"configuration",
			);
		if (input.returnUrl && !isSafePublicUrl(input.returnUrl, ["https:"]))
			throw new AlipayError(
				"Alipay return URL must use HTTPS",
				"configuration",
			);
		try {
			const paymentUrl = this.sdk.pageExecute("alipay.trade.page.pay", "GET", {
				notifyUrl: input.notifyUrl,
				...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
				bizContent: {
					outTradeNo: input.orderId,
					totalAmount: minorAmount(input.amountMinor, input.currencyDecimals),
					subject: input.description.slice(0, 256),
					productCode: "FAST_INSTANT_TRADE_PAY",
				},
			});
			const url = new URL(paymentUrl);
			if (
				url.protocol !== "https:" ||
				url.searchParams.get("method") !== "alipay.trade.page.pay" ||
				!url.searchParams.get("sign")
			)
				throw new AlipayError(
					"Alipay returned an unsafe payment URL",
					"provider",
				);
			return { providerOrderId: input.orderId, paymentUrl: url.toString() };
		} catch (error) {
			if (error instanceof AlipayError) throw error;
			throw new AlipayError(
				"Alipay could not create the payment URL",
				"provider",
			);
		}
	}

	verifyNotification(input: Record<string, string>) {
		try {
			return (
				input.app_id === this.config.appId &&
				input.sign_type === "RSA2" &&
				this.sdk.checkNotifySignV2(input)
			);
		} catch {
			return false;
		}
	}

	parseNotification(input: Record<string, string>): ProviderPayment {
		if (
			!input.trade_no ||
			!/^\d+$/.test(input.trade_no) ||
			!input.total_amount ||
			!isPaidTradeStatus(input.trade_status)
		)
			throw new AlipayError("Alipay notification is incomplete", "provider");
		return {
			providerTradeId: input.trade_no,
			amountMinor: decimalToMinor(input.total_amount, 2),
			currency: "CNY",
			currencyDecimals: 2,
			status: "succeeded",
		};
	}

	async queryPayment(providerOrderId: string): Promise<ProviderPayment | null> {
		const result = await this.queryPaymentWithDiagnostics(providerOrderId);
		if (result.outcome === "rejected")
			throw new AlipayError(
				"Alipay rejected the payment query",
				"provider",
				"ALIPAY_QUERY_REJECTED",
				queryResponseErrorDiagnostics(result.response),
			);
		if (result.outcome === "mismatch")
			throw new AlipayError(
				"Alipay query did not match the order",
				"provider",
				"ALIPAY_QUERY_ORDER_MISMATCH",
				queryResponseErrorDiagnostics(result.response),
			);
		return result.payment;
	}

	async queryPaymentWithDiagnostics(
		providerOrderId: string,
	): Promise<AlipayQueryInspection> {
		let signed: string;
		try {
			signed = this.sdk.sdkExecute("alipay.trade.query", {
				bizContent: { outTradeNo: providerOrderId },
			});
		} catch {
			throw new AlipayError(
				"Alipay query request could not be signed",
				"configuration",
				"ALIPAY_QUERY_SIGNING_FAILED",
			);
		}
		const gatewayResponse = await this.requestGateway(signed);
		const parsed = queryResponseSchema.safeParse(gatewayResponse.data);
		if (!parsed.success)
			throw new AlipayError(
				"Alipay query response is invalid",
				"provider",
				"ALIPAY_QUERY_RESPONSE_INVALID",
			);
		const responseData = parsed.data;
		const response: AlipayQueryResponse = {
			code: responseData.code,
			message: responseData.msg,
			subCode: responseData.sub_code ?? null,
			subMessage: responseData.sub_msg ?? null,
			externalOrderId: responseData.out_trade_no ?? null,
			providerTradeId: responseData.trade_no ?? null,
			tradeStatus: responseData.trade_status ?? null,
			totalAmount: responseData.total_amount ?? null,
			receiptAmount: responseData.receipt_amount ?? null,
			paidAt: responseData.send_pay_date ?? null,
		};
		if (
			responseData.code === "40004" &&
			responseData.sub_code === "ACQ.TRADE_NOT_EXIST"
		)
			return { outcome: "not_found", response, payment: null };
		if (responseData.code !== "10000")
			return { outcome: "rejected", response, payment: null };
		if (
			responseData.out_trade_no &&
			responseData.out_trade_no !== providerOrderId
		)
			return { outcome: "mismatch", response, payment: null };
		const status = isPaidTradeStatus(responseData.trade_status)
			? "succeeded"
			: responseData.trade_status === "TRADE_CLOSED"
				? "rejected"
				: "pending";
		if (
			status === "succeeded" &&
			(!responseData.trade_no ||
				!(responseData.total_amount ?? responseData.receipt_amount) ||
				responseData.out_trade_no !== providerOrderId)
		)
			throw new AlipayError(
				"Alipay query did not match the order",
				"provider",
				"ALIPAY_QUERY_ORDER_MISMATCH",
			);
		return {
			outcome: "success",
			response,
			payment: {
				providerTradeId: responseData.trade_no ?? providerOrderId,
				amountMinor:
					status === "succeeded"
						? decimalToMinor(
								responseData.total_amount ?? responseData.receipt_amount ?? "0",
								2,
							)
						: "0",
				currency: "CNY",
				currencyDecimals: 2,
				status,
			},
		};
	}

	private async requestGateway(signed: string) {
		let response: Response;
		try {
			response = await this.fetcher(
				`${this.config.endpoint.replace(/\/$/, "")}/gateway.do`,
				{
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded;charset=utf-8",
					},
					body: signed,
					signal: AbortSignal.timeout(this.config.timeoutMs),
				},
			);
		} catch (error) {
			const timedOut =
				error instanceof Error &&
				(error.name === "TimeoutError" || error.name === "AbortError");
			const transportCode = transportErrorCode(error);
			throw new AlipayError(
				"Alipay gateway request failed",
				"network",
				timedOut ? "ALIPAY_GATEWAY_TIMEOUT" : "ALIPAY_GATEWAY_FETCH_FAILED",
				transportCode ? { transportCode } : {},
			);
		}
		if (!response.ok)
			throw new AlipayError(
				"Alipay gateway returned an error",
				"network",
				"ALIPAY_GATEWAY_HTTP_ERROR",
				{ httpStatus: response.status },
			);
		let text: string;
		try {
			text = await response.text();
		} catch {
			throw new AlipayError(
				"Alipay gateway response body could not be read",
				"network",
				"ALIPAY_GATEWAY_BODY_READ_FAILED",
				{ httpStatus: response.status },
			);
		}
		const envelope = parseJson(text);
		const key = "alipay_trade_query_response";
		const data = envelope[key] ?? envelope.alipay_trade_precreate_response;
		const sign = envelope.sign;
		if (!isRecord(data) || typeof sign !== "string")
			throw new AlipayError(
				"Alipay response signature is missing",
				"signature",
				"ALIPAY_RESPONSE_SIGNATURE_MISSING",
			);
		let verified = false;
		try {
			verified = this.sdk.rsaCheck(JSON.stringify(data), sign, "RSA2");
		} catch {
			verified = false;
		}
		if (!verified)
			throw new AlipayError(
				"Alipay response signature is invalid",
				"signature",
				"ALIPAY_RESPONSE_SIGNATURE_INVALID",
			);
		return { data };
	}
}

function isPaidTradeStatus(status: string | undefined) {
	return status === "TRADE_SUCCESS" || status === "TRADE_FINISHED";
}

function safeDiagnosticCode(value: string | undefined) {
	return value && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

function queryResponseErrorDiagnostics(response: AlipayQueryResponse) {
	const gatewayCode = safeDiagnosticCode(response.code);
	const gatewaySubCode = safeDiagnosticCode(response.subCode ?? undefined);
	return {
		...(gatewayCode ? { gatewayCode } : {}),
		...(gatewaySubCode ? { gatewaySubCode } : {}),
	};
}

function transportErrorCode(error: unknown) {
	if (!isRecord(error)) return undefined;
	const directCode = safeDiagnosticCode(
		typeof error.code === "string" ? error.code : undefined,
	);
	if (directCode) return directCode;
	const cause = isRecord(error.cause) ? error.cause : null;
	return safeDiagnosticCode(
		cause && typeof cause.code === "string" ? cause.code : undefined,
	);
}

function decimalToMinor(value: string, decimals: number) {
	if (!/^\d+(?:\.\d+)?$/.test(value))
		throw new AlipayError(
			"Alipay amount is invalid",
			"provider",
			"ALIPAY_AMOUNT_INVALID",
		);
	const [whole = "", fraction = ""] = value.split(".");
	const exact = fraction.slice(0, decimals).padEnd(decimals, "0");
	if (fraction.slice(decimals).replaceAll("0", ""))
		throw new AlipayError(
			"Alipay amount has unsupported precision",
			"provider",
			"ALIPAY_AMOUNT_PRECISION_INVALID",
		);
	const minor = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(exact || "0");
	if (minor <= 0n)
		throw new AlipayError(
			"Alipay amount must be positive",
			"provider",
			"ALIPAY_AMOUNT_NON_POSITIVE",
		);
	return minor.toString();
}

function minorAmount(value: string, decimals: number) {
	const minor = BigInt(value);
	if (minor <= 0n)
		throw new AlipayError("Payment amount must be positive", "configuration");
	return (
		(minor / 10n ** BigInt(decimals)).toString() +
		`.` +
		(minor % 10n ** BigInt(decimals)).toString().padStart(decimals, "0")
	);
}

function parseJson(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		if (isRecord(parsed)) return parsed;
	} catch {
		// Provider responses are untrusted and mapped to a structured error.
	}
	throw new AlipayError(
		"Alipay response is invalid",
		"provider",
		"ALIPAY_GATEWAY_INVALID_JSON",
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
