export const ALIPAY_FAST_POLL_WINDOW_MS = 5 * 60_000;
export const ALIPAY_STATUS_POLL_WINDOW_MS = 15 * 60_000;
export const ALIPAY_FAST_POLL_INTERVAL_SECONDS = 15;
export const ALIPAY_SLOW_POLL_INTERVAL_SECONDS = 60;
// Minute Cron is only a recovery path; this avoids same-tick duplicate scans.
export const ALIPAY_SCHEDULED_FALLBACK_INTERVAL_MS = 61_000;

export function isAlipayStatusPollOpen(createdAtMs: number, nowMs: number) {
	return nowMs < createdAtMs + ALIPAY_STATUS_POLL_WINDOW_MS;
}

export function alipayStatusPollDelaySeconds(
	createdAtMs: number,
	nowMs: number,
) {
	return nowMs - createdAtMs < ALIPAY_FAST_POLL_WINDOW_MS
		? ALIPAY_FAST_POLL_INTERVAL_SECONDS
		: ALIPAY_SLOW_POLL_INTERVAL_SECONDS;
}
