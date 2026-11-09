import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
	Ban,
	ExternalLink,
	LoaderCircle,
	MoreHorizontal,
	Play,
	RefreshCw,
	Send,
	SlidersHorizontal,
	Undo2,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { AssetLabel, NetworkLabel } from "#/components/crypto-icons/labels";
import { ProButton } from "#/components/pro/base/button";
import { ModalForm } from "#/components/pro/form";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { StatusBadge, statusLabel } from "#/components/status-badge";
import { Badge } from "#/components/ui/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	hasSystemPermission,
	systemPermission,
} from "#/features/access/system-rbac";
import { orderOperationErrorMessage } from "#/features/orders/error-message";
import { orderStatuses } from "#/features/orders/schema";
import {
	cancelAdminOrderFn,
	checkAdminOrderPaymentFn,
	createDevelopmentOrderFn,
	listAdminOrdersFn,
	refundAdminOrderFn,
	resendOrderNotificationFn,
	reviewAdminAlipayOrderFn,
	simulateDevelopmentOrderStatusFn,
	simulateOrderPaymentFn,
} from "#/features/orders/server/admin";
import { Main } from "#/layouts/components/main";
import { useNavigation } from "#/layouts/components/navigation-context";
import { PageHeader } from "#/layouts/components/page-header";
import { fiatCurrencyOptions } from "#/lib/fiat-currencies";
import { formatDateTime, formatDecimalAmount } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { useVisiblePolling } from "#/lib/use-visible-polling";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

type OrderRecord = Awaited<
	ReturnType<typeof listAdminOrdersFn>
>["items"][number];
type AlipayReviewResult = Awaited<ReturnType<typeof reviewAdminAlipayOrderFn>>;

export function OrdersPage() {
	const { permissions } = useNavigation();
	const tableUrlState = useCurrentProTableUrlState({
		searchColumnId: "externalOrderId",
	});
	const [refreshKey, setRefreshKey] = useState(0);
	const snapshotRef = useRef<{
		key: string;
		at: number;
		cursors: Map<number, { createdAt: number; id: string }>;
	} | null>(null);
	const [refundingOrder, setRefundingOrder] = useState<OrderRecord | null>(
		null,
	);
	const [simulatingOrder, setSimulatingOrder] = useState<OrderRecord | null>(
		null,
	);
	const [alipayReview, setAlipayReview] = useState<{
		order: OrderRecord;
		result?: AlipayReviewResult;
		requestFailed?: boolean;
	} | null>(null);
	const [developmentToolsEnabled, setDevelopmentToolsEnabled] = useState(
		import.meta.env.DEV,
	);
	const canCreateDevelopmentOrder =
		developmentToolsEnabled &&
		hasSystemPermission(permissions, systemPermission("orders", "create"));
	const { markFailure, markSuccess } = useVisiblePolling(() => {
		snapshotRef.current = null;
		setRefreshKey((value) => value + 1);
	});
	const request = useCallback(
		async (state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "externalOrderId")
					?.value ?? "",
			);
			const key = `${search}:${state.pagination.pageSize}`;
			if (snapshotRef.current?.key !== key)
				snapshotRef.current = { key, at: Date.now(), cursors: new Map() };
			const snapshot = snapshotRef.current;
			try {
				const result = await listAdminOrdersFn({
					data: {
						pageIndex: state.pagination.pageIndex,
						pageSize: state.pagination.pageSize,
						search,
						beforeCreatedAt: snapshot.at,
						cursor: snapshot.cursors.get(state.pagination.pageIndex),
					},
				});
				setDevelopmentToolsEnabled(result.developmentToolsEnabled);
				if (result.nextCursor)
					snapshot.cursors.set(
						state.pagination.pageIndex + 1,
						result.nextCursor,
					);
				markSuccess();
				return { data: result.items, total: result.total };
			} catch (error) {
				markFailure();
				throw error;
			}
		},
		[markFailure, markSuccess],
	);
	const simulate = useMutation({
		mutationFn: simulateOrderPaymentFn,
		onSuccess: () => {
			refresh();
			toast.success(m.orders_simulation_succeeded());
		},
		onError: (error) => toast.error(orderOperationErrorMessage(error)),
	});
	const refresh = () => {
		snapshotRef.current = null;
		setRefreshKey((value) => value + 1);
	};
	const checkPayment = useMutation({
		mutationFn: checkAdminOrderPaymentFn,
		onSuccess: () => {
			refresh();
			toast.success(m.orders_payment_check_queued());
		},
		onError: showError,
	});
	const reviewAlipay = useMutation({
		mutationFn: reviewAdminAlipayOrderFn,
		onSuccess: (result) => {
			setAlipayReview((current) =>
				current ? { ...current, result } : current,
			);
			refresh();
		},
		onError: (error) => {
			setAlipayReview((current) =>
				current ? { ...current, requestFailed: true } : current,
			);
			showError(error);
		},
	});
	const cancel = useMutation({
		mutationFn: cancelAdminOrderFn,
		onSuccess: () => {
			refresh();
			toast.success(m.orders_cancelled());
		},
		onError: showError,
	});
	const refund = useMutation({
		mutationFn: refundAdminOrderFn,
		onSuccess: () => {
			setRefundingOrder(null);
			refresh();
			toast.success(m.orders_refund_recorded());
		},
		onError: showError,
	});
	const resendNotification = useMutation({
		mutationFn: resendOrderNotificationFn,
		onSuccess: () => toast.success(m.orders_notification_queued()),
		onError: showError,
	});
	const startAlipayReview = (order: OrderRecord) => {
		setAlipayReview({ order });
		reviewAlipay.mutate({ data: { orderId: order.id } });
	};
	const columns: ColumnDef<OrderRecord>[] = [
		{
			accessorKey: "externalOrderId",
			header: m.orders_order(),
			meta: { search: true },
			cell: ({ row }) => (
				<div>
					<code className="block text-xs">{row.original.id}</code>
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="text-muted-foreground text-xs">
							{row.original.externalOrderId}
						</span>
						{row.original.isTest ? (
							<Badge variant="outline">{m.orders_test_order_label()}</Badge>
						) : null}
					</div>
				</div>
			),
		},
		{
			accessorKey: "status",
			header: m.common_status(),
			cell: ({ row }) => <StatusBadge value={row.original.status} />,
		},
		{
			id: "orderAmount",
			header: m.orders_order_amount(),
			cell: ({ row }) =>
				`${formatDecimalAmount(row.original.amount)} ${row.original.currency}`,
		},
		{
			id: "paymentType",
			header: m.orders_receiving_type(),
			cell: ({ row }) =>
				row.original.railKind ? (
					<Badge variant="outline">
						{paymentKindLabel(row.original.railKind)}
					</Badge>
				) : (
					<span className="text-muted-foreground">—</span>
				),
		},
		{
			id: "payment",
			header: m.orders_receiving_information(),
			cell: ({ row }) => {
				if (!row.original.assetCode)
					return (
						<span className="text-muted-foreground">
							{m.orders_payment_method_pending()}
						</span>
					);
				return (
					<div className="grid gap-1.5">
						<div className="flex flex-wrap items-center gap-1.5">
							<NetworkLabel
								displayName={row.original.networkName}
								network={row.original.network}
							/>
						</div>
						<AssetLabel
							label={`${row.original.paymentAmount} ${row.original.assetCode}`}
							network={row.original.network}
							symbol={row.original.assetCode}
						/>
					</div>
				);
			},
		},
		{
			accessorKey: "createdAt",
			header: m.common_created(),
			cell: ({ row }) => formatDateTime(row.original.createdAt),
		},
		{
			id: "actions",
			header: m.common_actions(),
			cell: ({ row }) => {
				const active = ["pending", "confirming", "partially_paid"].includes(
					row.original.status,
				);
				const refundable = ["paid", "overpaid"].includes(row.original.status);
				const canOpenTestTools =
					developmentToolsEnabled &&
					(import.meta.env.DEV || row.original.isTest);
				const canSimulateTestStatus =
					canOpenTestTools &&
					hasSystemPermission(
						permissions,
						systemPermission("orders", "update"),
					);
				const canReviewAlipay =
					row.original.railKind === "fiat" &&
					row.original.network === "alipay" &&
					!row.original.isTest &&
					hasSystemPermission(
						permissions,
						systemPermission("orders", "update"),
					);
				if (
					!(
						canOpenTestTools ||
						canReviewAlipay ||
						active ||
						refundable ||
						row.original.notifyUrl
					)
				)
					return null;
				return (
					<div className="flex justify-end">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<ProButton
									size="icon-sm"
									variant="ghost"
									tooltip={m.common_actions()}
								>
									<MoreHorizontal />
								</ProButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{canOpenTestTools ? (
									<>
										<DropdownMenuItem
											onClick={() =>
												window.open(`/checkout/${row.original.id}`, "_blank")
											}
										>
											<ExternalLink />
											{m.common_preview()}
										</DropdownMenuItem>
										{canSimulateTestStatus ? (
											<DropdownMenuItem
												onClick={() => setSimulatingOrder(row.original)}
											>
												<SlidersHorizontal />
												{m.orders_simulate_status()}
											</DropdownMenuItem>
										) : null}
									</>
								) : null}
								{row.original.notifyUrl ? (
									<DropdownMenuItem
										disabled={resendNotification.isPending}
										onClick={() =>
											resendNotification.mutate({
												data: { orderId: row.original.id },
											})
										}
									>
										<Send />
										{m.orders_resend_notification()}
									</DropdownMenuItem>
								) : null}
								{canReviewAlipay ? (
									<DropdownMenuItem
										disabled={reviewAlipay.isPending}
										onClick={() => startAlipayReview(row.original)}
									>
										<RefreshCw />
										{m.orders_alipay_review()}
									</DropdownMenuItem>
								) : null}
								{active && row.original.network !== "alipay" && (
									<DropdownMenuItem
										disabled={checkPayment.isPending}
										onClick={() =>
											checkPayment.mutate({
												data: { orderId: row.original.id },
											})
										}
									>
										<RefreshCw />
										{m.orders_check_payment()}
									</DropdownMenuItem>
								)}
								{active && row.original.adapter === "mock" && (
									<DropdownMenuItem
										disabled={simulate.isPending}
										onClick={() =>
											simulate.mutate({ data: { orderId: row.original.id } })
										}
									>
										<Play />
										{m.orders_simulate_payment()}
									</DropdownMenuItem>
								)}
								{row.original.status === "pending" && (
									<DropdownMenuItem
										variant="destructive"
										disabled={cancel.isPending}
										onClick={() => {
											if (window.confirm(m.orders_cancel_confirmation())) {
												cancel.mutate({ data: { orderId: row.original.id } });
											}
										}}
									>
										<Ban />
										{m.orders_cancel_order()}
									</DropdownMenuItem>
								)}
								{refundable && (
									<DropdownMenuItem
										onClick={() => setRefundingOrder(row.original)}
									>
										<Undo2 />
										{m.orders_record_refund()}
									</DropdownMenuItem>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				);
			},
		},
	];
	return (
		<>
			<Main fixed className="gap-4">
				<PageHeader
					title={m.system_nav_orders()}
					description={m.orders_description()}
					actions={
						canCreateDevelopmentOrder ? (
							<ModalForm
								title={m.orders_development_create()}
								description={m.orders_development_create_description()}
								trigger={<ProButton>{m.common_new()}</ProButton>}
								initialValues={{ currency: "USD" }}
								schema={[
									{
										name: "amount",
										label: m.orders_order_amount(),
										required: true,
										fieldProps: { inputMode: "decimal", placeholder: "10.00" },
									},
									{
										name: "currency",
										label: m.common_currency(),
										valueType: "select",
										required: true,
										fieldProps: { options: fiatCurrencyOptions(getLocale()) },
									},
									{
										name: "description",
										label: m.orders_test_description(),
										valueType: "textarea",
										fieldProps: { maxLength: 500 },
									},
								]}
								onFinish={async (values) => {
									const preview = window.open("about:blank", "_blank");
									try {
										const order = await createDevelopmentOrderFn({
											data: {
												amount: String(values.amount ?? ""),
												currency: String(values.currency ?? "USD"),
												description: String(values.description ?? ""),
											},
										});
										refresh();
										if (preview) {
											preview.opener = null;
											preview.location.href = new URL(
												`/checkout/${order.orderId}`,
												window.location.origin,
											).href;
										}
										toast.success(m.orders_development_created());
									} catch (error) {
										preview?.close();
										throw error;
									}
								}}
								onFinishFailed={showError}
							/>
						) : null
					}
				/>
				<ProTable
					initialState={tableUrlState.initialState}
					onChange={tableUrlState.onChange}
					className="min-h-0 flex-1"
					columns={columns}
					request={request}
					requestKey={refreshKey}
					onRefresh={refresh}
					toolbarSearch={{
						columnId: "externalOrderId",
						placeholder: m.orders_search(),
					}}
					table={{ stickyHeader: true }}
				/>
			</Main>
			{refundingOrder && (
				<ModalForm
					key={refundingOrder.id}
					open
					onOpenChange={(open) => {
						if (!open) setRefundingOrder(null);
					}}
					title={m.orders_record_refund()}
					description={m.orders_refund_description()}
					schema={[
						{
							name: "reference",
							label: m.orders_refund_reference(),
							required: true,
							fieldProps: { minLength: 3, maxLength: 256 },
						},
						{
							name: "note",
							label: m.orders_refund_note(),
							valueType: "textarea",
							required: true,
							fieldProps: { minLength: 3, maxLength: 1000 },
						},
					]}
					onFinish={async (values) => {
						await refund.mutateAsync({
							data: {
								orderId: refundingOrder.id,
								reference: String(values.reference ?? ""),
								note: String(values.note ?? ""),
							},
						});
					}}
				/>
			)}
			{simulatingOrder ? (
				<ModalForm
					key={`simulate-${simulatingOrder.id}`}
					open
					onOpenChange={(open) => !open && setSimulatingOrder(null)}
					title={m.orders_simulate_status()}
					description={m.orders_simulate_status_description()}
					initialValues={{ status: simulatingOrder.status }}
					schema={[
						{
							name: "status",
							label: m.common_status(),
							valueType: "select",
							required: true,
							fieldProps: {
								options: orderStatuses.map((status) => ({
									label: statusLabel(status),
									value: status,
								})),
							},
						},
					]}
					onFinish={async (values) => {
						await simulateDevelopmentOrderStatusFn({
							data: {
								orderId: simulatingOrder.id,
								status: String(values.status) as (typeof orderStatuses)[number],
							},
						});
						setSimulatingOrder(null);
						refresh();
						toast.success(m.orders_simulation_succeeded());
					}}
					onFinishFailed={showError}
				/>
			) : null}
			{alipayReview ? (
				<Dialog open onOpenChange={(open) => !open && setAlipayReview(null)}>
					<DialogContent className="sm:max-w-2xl">
						<DialogHeader>
							<DialogTitle>{m.orders_alipay_review_title()}</DialogTitle>
							<DialogDescription>
								{m.orders_alipay_review_description()}
								<span className="mt-1 block break-all font-mono text-xs">
									{alipayReview.order.externalOrderId}
								</span>
							</DialogDescription>
						</DialogHeader>
						{reviewAlipay.isPending ? (
							<div
								className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
								role="status"
								aria-live="polite"
							>
								<LoaderCircle className="size-4 animate-spin" />
								{m.orders_alipay_review_loading()}
							</div>
						) : alipayReview.requestFailed ? (
							<p className="py-4 text-sm text-destructive" role="alert">
								{m.orders_alipay_review_request_failed()}
							</p>
						) : alipayReview.result ? (
							<div className="grid min-h-0 gap-2">
								<p className="text-sm font-medium">
									{alipayReviewOutcomeLabel(alipayReview.result.outcome)}
								</p>
								<p className="text-xs text-muted-foreground">
									{m.orders_alipay_review_response()}
								</p>
								<pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
									{JSON.stringify(alipayReview.result, null, 2)}
								</pre>
							</div>
						) : null}
						<DialogFooter>
							<ProButton
								variant="outline"
								disabled={reviewAlipay.isPending}
								onClick={() => startAlipayReview(alipayReview.order)}
							>
								<RefreshCw />
								{m.orders_alipay_review_retry()}
							</ProButton>
							<ProButton onClick={() => setAlipayReview(null)}>
								{m.common_close()}
							</ProButton>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}
		</>
	);
}

function showError(error: unknown) {
	toast.error(orderOperationErrorMessage(error));
}

function paymentKindLabel(kind: OrderRecord["railKind"]) {
	if (kind === "fiat") return m.receiving_fiat_methods();
	return {
		chain: m.nav_networks(),
		exchange: m.nav_exchanges(),
		wallet: m.nav_wallets(),
		"": m.common_unknown(),
	}[kind];
}

function alipayReviewOutcomeLabel(outcome: AlipayReviewResult["outcome"]) {
	switch (outcome) {
		case "success":
			return m.orders_alipay_review_found();
		case "not_found":
			return m.orders_alipay_review_not_found();
		case "rejected":
			return m.orders_alipay_review_rejected();
		case "mismatch":
			return m.orders_alipay_review_mismatch();
		case "error":
			return m.orders_alipay_review_error();
	}
}
