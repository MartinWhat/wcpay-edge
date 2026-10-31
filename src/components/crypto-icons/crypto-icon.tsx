import { type ImgHTMLAttributes, useEffect, useState } from "react";
import {
	directAssetIconUrls,
	providerIconUrls,
	resolveCatalogAssetIconUrls,
} from "./resolver";

export function AssetIcon({
	contractAddress,
	network,
	networkIndependent,
	symbol,
	...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
	contractAddress?: string | null;
	network: string;
	networkIndependent?: boolean;
	symbol?: string;
}) {
	return (
		<ResolvedAssetIcon
			key={`${network}:${contractAddress ?? "native"}:${symbol ?? ""}`}
			contractAddress={contractAddress}
			network={network}
			networkIndependent={networkIndependent}
			props={props}
			symbol={symbol}
		/>
	);
}

export function ProviderIcon({
	kind,
	provider,
	...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
	kind: "exchange" | "wallet" | "fiat";
	provider: string;
}) {
	const [index, setIndex] = useState(0);
	const sources = providerIconUrls(kind === "fiat" ? "wallet" : kind, provider);
	const src = sources[index];
	if (!src) return null;
	return (
		<img
			alt=""
			{...props}
			onError={() => setIndex((value) => value + 1)}
			src={src}
		/>
	);
}

function ResolvedAssetIcon({
	contractAddress,
	network,
	networkIndependent,
	props,
	symbol,
}: {
	contractAddress?: string | null;
	network: string;
	networkIndependent?: boolean;
	props: Omit<ImgHTMLAttributes<HTMLImageElement>, "src">;
	symbol?: string;
}) {
	const directSources = directAssetIconUrls({
		contractAddress,
		network,
		networkIndependent,
		symbol,
	});
	const [sources, setSources] = useState(directSources);
	const [index, setIndex] = useState(0);
	const [catalogRequested, setCatalogRequested] = useState(
		directSources.length === 0,
	);
	useEffect(() => {
		if (!catalogRequested) return;
		let cancelled = false;
		const direct = directAssetIconUrls({
			contractAddress,
			network,
			networkIndependent,
			symbol,
		});
		resolveCatalogAssetIconUrls({
			contractAddress,
			network,
			networkIndependent,
			symbol,
		}).then((urls) => {
			if (cancelled) return;
			const additions = urls.filter((url) => !direct.includes(url));
			setSources([...direct, ...additions]);
			setIndex(additions.length ? direct.length : direct.length + 1);
		});
		return () => {
			cancelled = true;
		};
	}, [catalogRequested, contractAddress, network, networkIndependent, symbol]);
	const src = sources[index];
	if (!src) return null;
	return (
		<img
			alt=""
			{...props}
			onError={() => {
				if (index + 1 < sources.length) {
					setIndex(index + 1);
					return;
				}
				setIndex(sources.length);
				setCatalogRequested(true);
			}}
			src={src}
		/>
	);
}
