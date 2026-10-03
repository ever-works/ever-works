import type {
	IStatsSinkPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	StatsSinkSendOptions
} from '@ever-works/plugin';
import {
	EVER_STATS_MAX_BODY_BYTES,
	EVER_STATS_REPORTS_PATH,
	normaliseStatsBaseUrl,
	type SignedStatsReport,
	type StatsSendErrorCode,
	type StatsSendFieldError,
	type StatsSendResult
} from '@ever-works/contracts';

/** The plugin id `EVER_WORKS_STATS_SINK` selects by default. */
export const EVER_STATS_SINK_PLUGIN_ID = 'ever-stats-sink';

/** At most this much of an answer is read (a problem document is a few hundred bytes). */
const MAX_ANSWER_BYTES = 64 * 1024;
/** At most this many field errors are kept from a `422` (the receiver sends at most 20). */
const MAX_FIELD_ERRORS = 20;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * `ever-stats-sink` — the first-party `stats-sink` provider: it delivers one
 * signed anonymous usage statistics report to `POST <base>/v1/stats/reports`.
 *
 * What it does, and nothing else:
 *
 * - posts `report.body` EXACTLY as given (the bytes that were signed), with the
 *   signature headers as given, `Content-Type: application/json` and the
 *   `User-Agent` the module passes;
 * - sends no cookie and no credential, refuses redirects, and gives up after
 *   `timeoutMs`;
 * - accepts only an `https:` base URL (or `http:` for a private host such as a
 *   local mock), and never sends a body above 16 KiB;
 * - maps the answer onto the closed {@link StatsSendResult}.
 *
 * `onLoad` opens no connection and starts no timer: with statistics switched
 * off the plugin is installed but nothing ever calls `send`, so it never
 * touches the network. It never logs the body.
 */
export class EverStatsSinkPlugin implements IStatsSinkPlugin {
	readonly id = EVER_STATS_SINK_PLUGIN_ID;
	readonly name = 'Anonymous usage statistics sender';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'integration';
	readonly capabilities = ['stats-sink'] as const;
	readonly configurationMode = 'admin-only' as const;
	readonly settingsSchema: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

	private readonly fetchImpl: FetchLike | null;

	/** `fetchImpl` is for tests; the platform constructs the plugin with no argument. */
	constructor(fetchImpl?: FetchLike) {
		this.fetchImpl = fetchImpl ?? null;
	}

	async onLoad(_context: PluginContext): Promise<void> {
		// Deliberately empty: no client, no socket, no timer before the first send.
	}

	async onUnload(): Promise<void> {
		// Nothing to release.
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		// Local only: a health check must never reach the statistics endpoint.
		return { status: 'healthy', message: 'ready', checkedAt: Date.now() };
	}

	async send(report: SignedStatsReport, options: StatsSinkSendOptions): Promise<StatsSendResult> {
		const base = normaliseStatsBaseUrl(options.baseUrl);
		if (!base) return failed('invalid_url', null, 'rejected');
		if (report.body.byteLength > EVER_STATS_MAX_BODY_BYTES) return failed('too_large', null, 'rejected');

		const doFetch: FetchLike = this.fetchImpl ?? ((input, init) => fetch(input, init));
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(report.headers)) headers[name] = value;
		headers['Content-Type'] = 'application/json';
		headers['User-Agent'] = options.userAgent;

		let response: Response;
		try {
			response = await doFetch(`${base}${EVER_STATS_REPORTS_PATH}`, {
				method: 'POST',
				body: report.body as unknown as BodyInit,
				headers,
				redirect: 'manual',
				credentials: 'omit',
				signal: AbortSignal.timeout(Math.max(1, options.timeoutMs))
			});
		} catch (error) {
			const name = (error as { name?: unknown } | null)?.name;
			return failed(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', null);
		}

		return mapAnswer(response.status, await readAnswer(response), response.headers.get('retry-after'));
	}
}

/**
 * Map an HTTP answer onto the closed result (status table of the published contract): `202`
 * sent; `408`/`429`/`5xx` failed (retried, honouring a `Retry-After` in seconds); everything
 * else — a redirect included — rejected. What a refusal then does is the module's schedule:
 * `422` and `409` wait for a new release (or, for `409`, an identity reset), any other refusal
 * is tried again after a few days.
 */
export function mapAnswer(status: number, answer: unknown, retryAfter: string | null = null): StatsSendResult {
	const problem = (answer && typeof answer === 'object' ? answer : {}) as {
		code?: unknown;
		superseded?: unknown;
		errors?: unknown;
	};
	if (status >= 200 && status < 300) {
		const result: StatsSendResult = { status: 'sent', httpStatus: status, errorCode: null };
		if (problem.superseded === true) result.superseded = true;
		return result;
	}
	if (status >= 300 && status < 400) return failed('redirect', status, 'rejected');
	if (status === 422) {
		return {
			status: 'rejected',
			httpStatus: status,
			errorCode: 'schema_violation',
			errors: fieldErrors(problem.errors)
		};
	}
	if (status === 409) return failed('key_mismatch', status, 'rejected');
	// The receiver gave up waiting for the request: a transient condition, retried like a 5xx.
	if (status === 408) return failed('timeout', status);
	if (status === 413) return failed('too_large', status, 'rejected');
	if (status === 415) return failed('unsupported_media_type', status, 'rejected');
	if (status === 400) {
		return failed(
			problem.code === 'signature_invalid' ? 'signature_invalid' : 'validation_failed',
			status,
			'rejected'
		);
	}
	if (status === 429 || status >= 500) {
		const result = failed(status === 429 ? 'rate_limited' : 'server_error', status);
		const asked = retryAfter !== null && /^\d{1,6}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : 0;
		if (asked > 0) result.retryAfterS = asked;
		return result;
	}
	return failed('http_error', status, 'rejected');
}

function failed(
	errorCode: StatsSendErrorCode,
	httpStatus: number | null,
	status: 'failed' | 'rejected' = 'failed'
): StatsSendResult {
	return { status, httpStatus, errorCode };
}

/** Keep only `{path, code}` of each refused field — never a message or a value. */
function fieldErrors(raw: unknown): StatsSendFieldError[] {
	if (!Array.isArray(raw)) return [];
	const out: StatsSendFieldError[] = [];
	for (const entry of raw.slice(0, MAX_FIELD_ERRORS)) {
		if (!entry || typeof entry !== 'object') continue;
		const { path, code } = entry as { path?: unknown; code?: unknown };
		if (typeof path !== 'string' || path.length > 256) continue;
		out.push({ path, code: typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : null });
	}
	return out;
}

/**
 * Read a small JSON answer; anything else (or too large) is `null`.
 *
 * Never more than {@link MAX_ANSWER_BYTES} is held in memory: a declared
 * `Content-Length` above the cap is refused before reading, and the body is
 * read chunk by chunk with a running count and cancelled as soon as it passes
 * the cap — an endpoint that streams without end costs nothing beyond it.
 */
export async function readAnswer(response: Response): Promise<unknown> {
	const declared = response.headers.get('content-length');
	if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > MAX_ANSWER_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		return null;
	}
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_ANSWER_BYTES) {
				await reader.cancel().catch(() => undefined);
				return null;
			}
			chunks.push(value);
		}
		if (total === 0) return null;
		const buffer = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			buffer.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return JSON.parse(new TextDecoder().decode(buffer));
	} catch {
		return null;
	}
}

export default EverStatsSinkPlugin;
