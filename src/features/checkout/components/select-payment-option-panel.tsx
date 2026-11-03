import { ArrowLeft, Building2, Link2, WalletCards } from "lucide-react";
import { useState } from "react";
import { AssetLabel, NetworkLabel } from "#/components/crypto-icons/labels";
import { Button } from "#/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import type { listCheckoutPaymentOptionsFn } from "#/features/checkout/server/functions";
import { m } from "#/paraglide/messages";

type Option = NonNullable<
	Awaited<ReturnType<typeof listCheckoutPaymentOptionsFn>>
>["options"][number];
type RailKind = Option["railKind"];
type AlipayEnvironment = NonNullable<Option["alipayEnvironment"]>;
type AlipayProduct = NonNullable<Option["alipayProduct"]>;
type AlipayOption = Option & {
	alipayEnvironment: AlipayEnvironment;
	alipayProduct: AlipayProduct;
};

export function SelectPaymentOptionPanel({
	busy,
	loading,
	onBack,
	onConfirm,
	options,
	unavailableReason,
}: {
	busy: boolean;
	loading?: boolean;
	onBack?: () => void;
	onConfirm: (option: Option) => void;
	options: Option[];
	unavailableReason?:
		| "rate_unavailable"
		| "payment_method_unavailable"
		| "test_order"
		| null;
}) {
	// Selections are kept as the payer's choices; the effective values fall
	// back to the first available entry whenever a choice is absent or no
	// longer offered, so the panel needs no effect to re-synchronize.
	const [selectedKind, setSelectedKind] = useState<RailKind | "">("");
	const [selectedReceivingMethodId, setSelectedReceivingMethodId] =
		useState("");
	const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState("");
	const [selectedAlipayEnvironment, setSelectedAlipayEnvironment] = useState<
		AlipayEnvironment | ""
	>("");
	const [selectedAlipayProduct, setSelectedAlipayProduct] = useState<
		AlipayProduct | ""
	>("");

	const kinds = [...new Set(options.map((option) => option.railKind))];
	const kind = kinds.find((value) => value === selectedKind) ?? kinds[0] ?? "";
	const kindOptions = options.filter((option) => option.railKind === kind);
	const receivingMethods = Array.from(
		new Map(
			kindOptions.map((option) => [
				option.receivingMethodId,
				{
					id: option.receivingMethodId,
					name: option.receivingMethodName,
					network: option.network,
					networkName: option.networkName,
				},
			]),
		).values(),
	);
	const receivingMethodId = receivingMethods.some(
		(method) => method.id === selectedReceivingMethodId,
	)
		? selectedReceivingMethodId
		: (receivingMethods[0]?.id ?? "");
	const paymentMethodOptions = kindOptions.filter(
		(option) => option.receivingMethodId === receivingMethodId,
	);
	const assets = Array.from(
		new Map(
			paymentMethodOptions.map((option) => [option.paymentMethodId, option]),
		).values(),
	);
	const paymentMethodId = assets.some(
		(asset) => asset.paymentMethodId === selectedPaymentMethodId,
	)
		? selectedPaymentMethodId
		: (assets[0]?.paymentMethodId ?? "");
	const selectedAssetOptions = paymentMethodOptions.filter(
		(option) => option.paymentMethodId === paymentMethodId,
	);
	const alipayOptions = selectedAssetOptions.filter(
		(option): option is AlipayOption =>
			typeof option.alipayEnvironment === "string" &&
			typeof option.alipayProduct === "string",
	);
	const alipayEnvironments = [
		...new Set(alipayOptions.map((option) => option.alipayEnvironment)),
	];
	const alipayEnvironment =
		alipayEnvironments.find((value) => value === selectedAlipayEnvironment) ??
		(alipayEnvironments.includes("production")
			? "production"
			: (alipayEnvironments[0] ?? ""));
	const alipayProducts = [
		...new Set(
			alipayOptions
				.filter((option) => option.alipayEnvironment === alipayEnvironment)
				.map((option) => option.alipayProduct),
		),
	];
	const alipayProduct =
		alipayProducts.find((value) => value === selectedAlipayProduct) ??
		(alipayProducts.includes("website")
			? "website"
			: (alipayProducts[0] ?? ""));
	const selected =
		alipayOptions.find(
			(option) =>
				option.alipayEnvironment === alipayEnvironment &&
				option.alipayProduct === alipayProduct,
		) ?? selectedAssetOptions[0];

	return (
		<section className="w-full pb-4">
			<div className="mb-3 flex items-center gap-2">
				{onBack ? (
					<Button
						aria-label={m.checkout_back()}
						className="size-8 rounded-full"
						onClick={onBack}
						size="icon-sm"
						variant="ghost"
					>
						<ArrowLeft />
					</Button>
				) : null}
				<p className="font-semibold text-base">
					{m.checkout_select_payment_method()}
				</p>
			</div>
			{loading ? (
				<p className="py-8 text-center text-muted-foreground text-sm">
					{m.common_loading()}
				</p>
			) : options.length === 0 ? (
				<div className="rounded-xl border bg-muted/30 px-4 py-5 text-center">
					<p className="font-medium">{m.checkout_no_payment_options()}</p>
					<p className="mt-1 text-muted-foreground text-sm">
						{unavailableReason === "test_order"
							? m.orders_test_payment_disabled()
							: unavailableReason === "rate_unavailable"
								? m.checkout_payment_rate_unavailable_hint()
								: m.checkout_no_payment_options_hint()}
					</p>
				</div>
			) : (
				<>
					{kinds.length > 1 ? (
						<div className="mb-4 grid grid-cols-3 gap-2">
							{kinds.map((value) => (
								<Button
									className="h-auto min-h-16 flex-col gap-1 rounded-xl px-2 py-2"
									key={value}
									onClick={() => {
										setSelectedKind(value);
										setSelectedReceivingMethodId("");
										setSelectedPaymentMethodId("");
										setSelectedAlipayEnvironment("");
										setSelectedAlipayProduct("");
									}}
									variant={kind === value ? "default" : "outline"}
								>
									{kindIcon(value)}
									<span className="text-xs">{kindLabel(value)}</span>
								</Button>
							))}
						</div>
					) : null}
					<div className="mb-4 grid grid-cols-2 gap-2">
						<div className="min-w-0">
							<p className="mb-1.5 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
								{kindLabel(kind)}
							</p>
							<Select
								disabled={!receivingMethods.length}
								onValueChange={(value) => {
									setSelectedReceivingMethodId(value);
									setSelectedPaymentMethodId("");
									setSelectedAlipayEnvironment("");
									setSelectedAlipayProduct("");
								}}
								value={receivingMethodId}
							>
								<SelectTrigger className="h-12.5 w-full rounded-xl bg-card">
									<SelectValue />
								</SelectTrigger>
								<SelectContent position="popper">
									{receivingMethods.map((method) => (
										<SelectItem key={method.id} value={method.id}>
											<NetworkLabel
												displayName={method.name.trim() || method.networkName}
												network={method.network}
											/>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="min-w-0">
							<p className="mb-1.5 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
								{m.common_currency()}
							</p>
							<Select
								disabled={!assets.length}
								onValueChange={(value) => {
									setSelectedPaymentMethodId(value);
									setSelectedAlipayEnvironment("");
									setSelectedAlipayProduct("");
								}}
								value={paymentMethodId}
							>
								<SelectTrigger className="h-12.5 w-full rounded-xl bg-card">
									<SelectValue />
								</SelectTrigger>
								<SelectContent position="popper">
									{assets.map((option) => (
										<SelectItem
											key={option.paymentMethodId}
											value={option.paymentMethodId}
										>
											<AssetLabel
												label={option.asset}
												network={option.network}
												symbol={option.asset}
											/>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					{alipayEnvironments.length > 1 || alipayProducts.length > 1 ? (
						<div
							className={`mb-4 grid gap-2 ${
								alipayEnvironments.length > 1 && alipayProducts.length > 1
									? "grid-cols-2"
									: "grid-cols-1"
							}`}
						>
							{alipayEnvironments.length > 1 ? (
								<div className="min-w-0">
									<p className="mb-1.5 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
										{m.payment_alipay_environment()}
									</p>
									<Select
										onValueChange={(value) => {
											setSelectedAlipayEnvironment(
												value === "sandbox" ? "sandbox" : "production",
											);
											setSelectedAlipayProduct("");
										}}
										value={alipayEnvironment}
									>
										<SelectTrigger className="h-12.5 w-full rounded-xl bg-card">
											<SelectValue />
										</SelectTrigger>
										<SelectContent position="popper">
											{alipayEnvironments.map((environment) => (
												<SelectItem key={environment} value={environment}>
													{environment === "sandbox"
														? m.payment_alipay_sandbox()
														: m.payment_alipay_production()}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							) : null}
							{alipayProducts.length > 1 ? (
								<div className="min-w-0">
									<p className="mb-1.5 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
										{m.payment_alipay_product()}
									</p>
									<Select
										onValueChange={(value) =>
											setSelectedAlipayProduct(
												value === "face_to_face" ? "face_to_face" : "website",
											)
										}
										value={alipayProduct}
									>
										<SelectTrigger className="h-12.5 w-full rounded-xl bg-card">
											<SelectValue />
										</SelectTrigger>
										<SelectContent position="popper">
											{alipayProducts.map((product) => (
												<SelectItem key={product} value={product}>
													{product === "face_to_face"
														? m.payment_alipay_face_to_face()
														: m.payment_alipay_website()}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							) : null}
						</div>
					) : null}
					<Button
						className="h-12 w-full rounded-xl text-base"
						disabled={busy || !selected}
						onClick={() => selected && onConfirm(selected)}
					>
						{m.common_confirm()}
					</Button>
				</>
			)}
		</section>
	);
}

function kindLabel(kind: RailKind | "") {
	if (kind === "chain") return m.nav_networks();
	if (kind === "exchange") return m.nav_exchanges();
	if (kind === "wallet") return m.nav_wallets();
	return m.orders_receiving_type();
}

function kindIcon(kind: RailKind) {
	if (kind === "chain") return <Link2 className="size-5" />;
	if (kind === "exchange") return <Building2 className="size-5" />;
	return <WalletCards className="size-5" />;
}
