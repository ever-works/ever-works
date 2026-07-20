export {
	PostHogMetricsPlugin,
	PostHogMetricsError,
	POSTHOG_METRIC_IDS,
	DEFAULT_API_HOST,
	REQUEST_TIMEOUT_MS,
	EVENT_COUNT_HOGQL,
	ACTIVE_USERS_HOGQL,
	resolveWindowRange
} from './posthog-metrics.plugin.js';
export type { PostHogMetricsErrorCode, RangeWindow } from './posthog-metrics.plugin.js';
export { PostHogMetricsPlugin as default } from './posthog-metrics.plugin.js';
