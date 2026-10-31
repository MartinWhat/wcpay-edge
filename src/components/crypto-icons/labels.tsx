import { AssetIcon, ProviderIcon } from "./crypto-icon";

export function NetworkLabel({
	displayName,
	network,
}: {
	displayName?: string;
	network: string;
}) {
	return (
		<AssetLabel
			label={displayName?.trim() || network}
			network={network}
			symbol=""
		/>
	);
}

export function ProviderLabel({
	kind,
	name,
	provider,
}: {
	kind: "exchange" | "wallet" | "fiat";
	name: string;
	provider: string;
}) {
	return (
		<span className="flex min-w-0 items-center gap-2">
			<span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
				<ProviderIcon
					className="size-5 rounded-full object-contain"
					height={20}
					kind={kind}
					provider={provider}
					width={20}
				/>
			</span>
			<span className="truncate">{name}</span>
		</span>
	);
}

export function AssetLabel({
	contractAddress,
	label,
	network,
	networkIndependent,
	symbol,
}: {
	contractAddress?: string | null;
	label: string;
	network: string;
	networkIndependent?: boolean;
	symbol?: string;
}) {
	return (
		<span className="flex min-w-0 items-center gap-2">
			<span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
				<AssetIcon
					className="size-5 rounded-full object-contain"
					contractAddress={contractAddress}
					height={20}
					network={network}
					networkIndependent={networkIndependent}
					symbol={symbol ?? label.split(" · ")[0]}
					width={20}
				/>
			</span>
			<span className="truncate">{label}</span>
		</span>
	);
}
