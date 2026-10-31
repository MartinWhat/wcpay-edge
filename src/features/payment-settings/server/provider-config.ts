import { z } from "zod";
import { paymentSettingsError } from "#/features/payment-settings/errors";

const binanceConfiguration = z.object({
	receiverUid: z
		.string()
		.trim()
		.regex(/^[1-9]\d*$/)
		.max(100),
	apiKey: z.string().trim().min(1).max(512),
	secretKey: z.string().trim().min(1).max(512),
});

const okxConfiguration = z.object({
	accountUid: z
		.string()
		.trim()
		.regex(/^[1-9]\d*$/)
		.max(100),
	apiKey: z.string().trim().min(1).max(512),
	secretKey: z.string().trim().min(1).max(512),
	passphrase: z.string().trim().min(1).max(512),
});

const okpayConfiguration = z.object({
	shopId: z
		.string()
		.trim()
		.regex(/^[1-9]\d*$/)
		.max(100),
	apiKey: z.string().trim().min(1).max(512),
});

const alipayConfiguration = z
	.object({
		appId: z
			.string()
			.trim()
			.regex(/^\d{8,32}$/),
		privateKey: z.string().trim().min(1).max(16_384),
		alipayPublicKey: z.string().trim().min(1).max(16_384),
		keyType: z.enum(["PKCS1", "PKCS8"]).default("PKCS8"),
	})
	.strict();

export function parseReceivingProviderConfiguration(
	railCode: string,
	configuration: Record<string, string>,
) {
	if (railCode === "binance") {
		const parsed = parseConfiguration(binanceConfiguration, configuration);
		return {
			targetType: "account" as const,
			targetField: "receiverUid",
			targetValue: parsed.receiverUid,
			credentials: { apiKey: parsed.apiKey, secretKey: parsed.secretKey },
		};
	}
	if (railCode === "okx") {
		const parsed = parseConfiguration(okxConfiguration, configuration);
		return {
			targetType: "account" as const,
			targetField: "accountUid",
			targetValue: parsed.accountUid,
			credentials: {
				apiKey: parsed.apiKey,
				secretKey: parsed.secretKey,
				passphrase: parsed.passphrase,
			},
		};
	}
	if (railCode === "okpay") {
		const parsed = parseConfiguration(okpayConfiguration, configuration);
		return {
			targetType: "provider" as const,
			targetField: "shopId",
			targetValue: parsed.shopId,
			credentials: { apiKey: parsed.apiKey },
		};
	}
	if (railCode === "alipay") {
		const parsed = parseConfiguration(alipayConfiguration, configuration);
		return {
			targetType: "provider" as const,
			targetField: "appId",
			targetValue: parsed.appId,
			credentials: {
				appId: parsed.appId,
				privateKey: parsed.privateKey,
				alipayPublicKey: parsed.alipayPublicKey,
				keyType: parsed.keyType,
			},
		};
	}
	throw paymentSettingsError("receiving_method_configuration_required");
}

function parseConfiguration<T>(
	schema: z.ZodType<T>,
	configuration: Record<string, string>,
) {
	const result = schema.safeParse(configuration);
	if (!result.success)
		throw paymentSettingsError("receiving_method_configuration_required");
	return result.data;
}
