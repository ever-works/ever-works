import type { SignedStatsReport, StatsSendResult } from '@ever-works/contracts';
import type { IPlugin } from '../plugin.interface.js';

/**
 * The `stats-sink` capability — the one way the anonymous usage statistics
 * module hands a finished report to whatever delivers it.
 *
 * The statistics module builds the report, validates it against the published
 * schema, serialises it ONCE and signs those exact bytes with the instance's
 * statistics key. A provider receives that {@link SignedStatsReport} and must
 * deliver `body` exactly as given, with exactly the headers given: it never
 * parses, re-serialises, enriches or logs the body.
 *
 * The first-party provider is `ever-stats-sink` (`POST <base>/v1/stats/reports`).
 * The provider in use is chosen by `EVER_WORKS_STATS_SINK` (default
 * `ever-stats-sink`), so a different delivery path is a plugin, not a change
 * to the module.
 *
 * Rules every provider follows:
 *
 *  - **No socket before `send`.** `onLoad` opens no connection and starts no
 *    timer; a client, if any, is created on the first `send`.
 *  - **Nothing identifying is added.** No cookie, credential, instance URL or
 *    host name travels with the report; redirects are refused.
 *  - **Closed results.** Every outcome maps onto {@link StatsSendResult}: a
 *    refusal by the receiver is `rejected` (retried only after an upgrade), a
 *    transient problem (rate limit, 5xx, network, timeout) is `failed`
 *    (retried on the module's ladder).
 */
export const STATS_SINK_CAPABILITY = 'stats-sink' as const;

/** Where and how the module asks a provider to deliver one report. */
export interface StatsSinkSendOptions {
	/**
	 * Base URL of the statistics endpoint (`EVER_STATS_API_URL`, else
	 * `EVER_PLATFORM_API_URL`, else `https://api.ever.co`). A provider that
	 * posts over HTTP appends `/v1/stats/reports`; one that delivers elsewhere
	 * may ignore it.
	 */
	readonly baseUrl: string;
	/** Upper bound for the whole delivery, in milliseconds. */
	readonly timeoutMs: number;
	/** `User-Agent` to send, e.g. `ever-stats/1.0.0 (works/1.4.2)`. */
	readonly userAgent: string;
}

export interface IStatsSinkPlugin extends IPlugin {
	send(report: SignedStatsReport, options: StatsSinkSendOptions): Promise<StatsSendResult>;
}

/** Runtime guard: declares the capability AND implements `send`. */
export function isStatsSinkPlugin(plugin: unknown): plugin is IStatsSinkPlugin {
	if (!plugin || typeof plugin !== 'object') return false;
	const candidate = plugin as Partial<IStatsSinkPlugin>;
	return (
		Array.isArray(candidate.capabilities) &&
		candidate.capabilities.includes(STATS_SINK_CAPABILITY) &&
		typeof candidate.send === 'function'
	);
}
