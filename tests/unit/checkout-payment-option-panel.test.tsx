// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectPaymentOptionPanel } from "#/features/checkout/components/select-payment-option-panel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView ??= () => {};

type Option = Parameters<typeof SelectPaymentOptionPanel>[0]["options"][number];

describe("checkout payment option panel", () => {
	let container: HTMLDivElement | undefined;
	let root: ReturnType<typeof createRoot> | undefined;

	afterEach(async () => {
		if (root) await act(async () => root?.unmount());
		container?.remove();
		container = undefined;
		root = undefined;
	});

	it("renders the operator-defined receiving method name", async () => {
		await renderPanel([option("chain", "BEP20(BNB Chain)")]);

		expect(container?.textContent).toContain("Select a payment method");
		expect(container?.textContent).not.toContain("Select a receiving method");
		expect(container?.textContent).toContain("BEP20(BNB Chain)");
		expect(container?.textContent).not.toContain("BNB Smart Chain");
	});

	it("falls back to the network name when the custom name is blank", async () => {
		await renderPanel([option("chain", "   ")]);

		expect(container?.textContent).toContain("BNB Smart Chain");
	});

	it("derives the effective selection from the offered options", async () => {
		const onConfirm = vi.fn();
		const chain = option("chain", "BEP20(BNB Chain)");
		const exchange = option("exchange", "Binance Pay");
		await renderPanel([chain, exchange], onConfirm);

		await click("Confirm");
		expect(onConfirm).toHaveBeenLastCalledWith(chain);

		await click("Exchanges");
		await click("Confirm");
		expect(onConfirm).toHaveBeenLastCalledWith(exchange);

		// The chosen kind disappears from the offer: the first remaining one
		// takes over without an extra effect commit.
		await renderPanel([chain], onConfirm);
		await click("Confirm");
		expect(onConfirm).toHaveBeenLastCalledWith(chain);
	});

	it("confirms the selected Alipay product without duplicating its currency", async () => {
		const onConfirm = vi.fn();
		const website = alipayOption("website");
		const faceToFace = alipayOption("face_to_face");
		await renderPanel([website, faceToFace], onConfirm);

		const selectors =
			container?.querySelectorAll<HTMLElement>('[role="combobox"]');
		expect(selectors).toHaveLength(3);
		await act(async () => selectors?.[2]?.click());

		const productOption = [
			...document.querySelectorAll<HTMLElement>('[role="option"]'),
		].find((item) => item.textContent === "Face-to-face payment");
		if (!productOption) throw new Error("Alipay product option not rendered");
		await act(async () => productOption.click());
		await click("Confirm");

		expect(onConfirm).toHaveBeenLastCalledWith(faceToFace);
	});

	async function click(label: string) {
		const button = [...(container?.querySelectorAll("button") ?? [])].find(
			(candidate) => candidate.textContent === label,
		);
		if (!button) throw new Error(`button ${label} not rendered`);
		await act(async () => button.click());
	}

	async function renderPanel(options: Option[], onConfirm = vi.fn()) {
		if (!container) {
			container = document.createElement("div");
			document.body.appendChild(container);
			root = createRoot(container);
		}
		await act(async () => {
			root?.render(
				<SelectPaymentOptionPanel
					busy={false}
					onConfirm={onConfirm}
					options={options}
				/>,
			);
		});
	}
});

function option(
	railKind: Option["railKind"],
	receivingMethodName: string,
): Option {
	return {
		receivingMethodId: `method-${railKind}`,
		receivingMethodName,
		paymentMethodId: `asset-usdt-${railKind}`,
		asset: "USDT",
		network: railKind === "chain" ? "bsc" : "binance",
		networkName: railKind === "chain" ? "BNB Smart Chain" : "Binance",
		railKind,
		amount: "12.5",
		current: false,
	};
}

function alipayOption(product: "website" | "face_to_face"): Option {
	return {
		receivingMethodId: "receiving-alipay",
		receivingMethodName: "Alipay",
		paymentMethodId: "alipay-cny",
		asset: "CNY",
		network: "alipay",
		networkName: "Alipay",
		railKind: "fiat",
		amount: "12.5",
		current: false,
		alipayEnvironment: "production",
		alipayProduct: product,
	};
}
