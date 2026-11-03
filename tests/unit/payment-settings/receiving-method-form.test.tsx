// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceivingConfigurationFields } from "#/features/payment-settings/pages/admin-methods";
import { m } from "#/paraglide/messages";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

describe("receiving method configuration form", () => {
	let container: HTMLDivElement | undefined;
	let root: ReturnType<typeof createRoot> | undefined;

	afterEach(async () => {
		if (root) await act(async () => root?.unmount());
		container?.remove();
		container = undefined;
		root = undefined;
	});

	it("saves the selected Alipay product with the receiving method", async () => {
		const onChange = vi.fn<(value: string) => void>();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<ReceivingConfigurationFields
					methods={[
						{
							id: "alipay-cny",
							name: "CNY · Alipay",
							rail_code: "alipay",
							rail_name: "Alipay",
							asset_code: "CNY",
							decimals: 2,
							rail_kind: "fiat",
						},
					]}
					onChange={onChange}
				/>,
			);
		});

		await chooseRadixValue(0, "fiat");
		await chooseRadixValue(1, "alipay");

		const currencySelect = getCombobox(2);
		await act(async () => currencySelect.click());
		const currencyOption = findOption((item) =>
			item.textContent?.includes("CNY"),
		);
		await act(async () => currencyOption.click());
		await act(async () => currencySelect.click());

		await chooseRadixValue(3, "face_to_face");

		const lastValue = onChange.mock.lastCall?.[0];
		if (!lastValue) throw new Error("Receiving configuration was not emitted");
		expect(JSON.parse(lastValue)).toMatchObject({
			paymentMethodIds: ["alipay-cny"],
			alipayProduct: "face_to_face",
		});
	});

	async function chooseRadixValue(index: number, value: string) {
		await act(async () => getCombobox(index).click());
		const label =
			value === "fiat"
				? m.receiving_fiat_methods()
				: value === "alipay"
					? "Alipay"
					: m.payment_alipay_face_to_face();
		const option = findOption(
			(item) =>
				item.getAttribute("data-value") === value ||
				item.textContent?.includes(label) === true,
		);
		await act(async () => option.click());
	}

	function getCombobox(index: number) {
		const combobox =
			container?.querySelectorAll<HTMLElement>('[role="combobox"]')[index];
		if (!combobox) throw new Error(`Combobox ${index} was not rendered`);
		return combobox;
	}

	function findOption(predicate: (item: HTMLElement) => boolean) {
		const option = [
			...document.querySelectorAll<HTMLElement>('[role="option"]'),
		].find(predicate);
		if (!option) throw new Error("Expected option was not rendered");
		return option;
	}
});
