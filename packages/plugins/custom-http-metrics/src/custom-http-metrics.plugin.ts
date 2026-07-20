import type {
	IPlugin,
	IMetricsProviderPlugin,
	MetricDescriptor,
	MetricQuery,
	MetricSample,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	PluginSettings,
	ValidationError,
	ValidationResult
} from '@ever-works/plugin';
// Direct import (NOT via `@ever-works/plugin/helpers`): the SSRF guard pulls in
// `node:net` / `node:dns` and is intentionally excluded from the helpers barrel.
import { safeFetchWithDnsPin, SsrfBlockedError, isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';

/**
 * Custom HTTP Metrics — first-party `metrics-provider` plugin (Goals PR-7).
 *
 * Lets users point the platform at their OWN metric endpoints: each
 * configured endpoint is a GET-only, JSON-returning URL plus a
 * dot/bracket path to the numeric value inside the response. Every
 * endpoint surfaces as one {@link MetricDescriptor} with
 * `supportedWindows: ['point']` — a custom endpoint returns the
 * current value; any window semantics beyond "point in time" are the
 * endpoint's own concern.
 *
 * READ-ONLY BY CONTRACT (see `metrics-provider.interface.ts`):
 * non-GET methods are rejected both at settings-validation time and
 * again at call time. All outbound requests go through
 * {@link safeFetchWithDnsPin} (lexical + DNS-resolved SSRF guard),
 * redirects are refused, responses are capped at 1 MB / 15 s and must
 * be `content-type: *json*`.
 */

/** Hard cap on the response body size (1 MB). */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Hard cap on the request duration (15 s). */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Unit reported when an endpoint does not declare one. */
const DEFAULT_UNIT = 'count';

/**
 * Stable machine-readable failure codes for {@link CustomHttpMetricsError}.
 */
export type CustomHttpMetricsErrorCode =
	| 'invalid_settings'
	| 'unknown_metric'
	| 'unsupported_window'
	| 'method_not_allowed'
	| 'ssrf_blocked'
	| 'redirect_blocked'
	| 'timeout'
	| 'http_error'
	| 'invalid_content_type'
	| 'response_too_large'
	| 'invalid_json'
	| 'value_not_found'
	| 'value_not_numeric';

/**
 * Typed error thrown by the plugin. The facade wraps non-FacadeError
 * plugin failures, so the discriminated `code` (not the message) is
 * the stable contract for programmatic handling / tests.
 */
export class CustomHttpMetricsError extends Error {
	readonly code: CustomHttpMetricsErrorCode;
	/** HTTP status of the upstream response (only for `http_error`). */
	readonly status?: number;

	constructor(code: CustomHttpMetricsErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = 'CustomHttpMetricsError';
		this.code = code;
		if (options?.status !== undefined) {
			this.status = options.status;
		}
	}
}

/** One configured metric endpoint (an entry of the `endpoints` setting). */
export interface CustomHttpMetricEndpoint {
	/** Stable metric id this endpoint is exposed as. */
	id: string;
	/** Human-readable label. */
	label: string;
	/** HTTP(S) URL returning JSON. */
	url: string;
	/** Dot/bracket path to the numeric value inside the JSON response. */
	valuePath: string;
	/** Unit of the metric value (defaults to `'count'`). */
	unit?: string;
	/** Only `'GET'` is allowed — kept explicit so misconfiguration is loud. */
	method?: string;
	/** Extra request headers (e.g. an Authorization bearer token). */
	headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Value-path resolver (small, safe, dependency-free — NO eval, NO jsonpath)
// ---------------------------------------------------------------------------

/**
 * Path segments that must never be traversed. The resolver only reads
 * own-properties anyway, but rejecting these outright keeps a
 * misconfigured path from ever touching prototype machinery.
 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse a dot/bracket value path into segments.
 *
 * Supported syntax (JSONPath-ish, deliberately tiny):
 * - `data.metrics.value` — dot-separated keys
 * - `data.metrics[0].value` — numeric array indices in brackets
 * - `data['some key'].value` / `data["some key"]` — quoted keys in brackets
 * - optional leading `$` root (`$.data.value`)
 *
 * Throws a plain `Error` on syntactically invalid or forbidden paths —
 * callers map it to their own typed error / validation message.
 */
export function parseValuePath(path: string): (string | number)[] {
	if (typeof path !== 'string' || path.trim() === '') {
		throw new Error('Value path must be a non-empty string');
	}

	let input = path.trim();
	// Optional JSONPath-style root marker.
	if (input.startsWith('$')) {
		input = input.slice(1);
		if (input.startsWith('.')) {
			input = input.slice(1);
		}
		if (input === '') {
			throw new Error('Value path must select a property, not the root');
		}
	}

	const segments: (string | number)[] = [];
	let i = 0;

	const pushKey = (key: string) => {
		if (key === '') {
			throw new Error(`Empty segment in value path "${path}"`);
		}
		if (FORBIDDEN_SEGMENTS.has(key)) {
			throw new Error(`Forbidden segment "${key}" in value path "${path}"`);
		}
		segments.push(key);
	};

	while (i < input.length) {
		const char = input[i];

		if (char === '[') {
			const closing = input.indexOf(']', i + 1);
			if (closing === -1) {
				throw new Error(`Unterminated "[" in value path "${path}"`);
			}
			const inner = input.slice(i + 1, closing);
			if (
				(inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2) ||
				(inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2)
			) {
				pushKey(inner.slice(1, -1));
			} else if (/^\d+$/.test(inner)) {
				segments.push(Number(inner));
			} else {
				throw new Error(`Invalid bracket segment "[${inner}]" in value path "${path}" — use [0] or ['key']`);
			}
			i = closing + 1;
			// After a bracket: either end, another bracket, or a dot separator.
			if (i < input.length && input[i] === '.') {
				i += 1;
				if (i === input.length) {
					throw new Error(`Trailing "." in value path "${path}"`);
				}
			} else if (i < input.length && input[i] !== '[') {
				throw new Error(`Expected "." or "[" after "]" in value path "${path}"`);
			}
			continue;
		}

		// Plain identifier segment: read until the next '.' or '['.
		let end = i;
		while (end < input.length && input[end] !== '.' && input[end] !== '[') {
			end += 1;
		}
		pushKey(input.slice(i, end));
		i = end;
		if (i < input.length && input[i] === '.') {
			i += 1;
			if (i === input.length) {
				throw new Error(`Trailing "." in value path "${path}"`);
			}
		}
	}

	if (segments.length === 0) {
		throw new Error('Value path must contain at least one segment');
	}
	return segments;
}

/**
 * Resolve a parsed value path against arbitrary JSON data.
 *
 * Only own enumerable/data properties are read (never the prototype
 * chain); numeric segments only index arrays. Returns `undefined`
 * whenever the path does not fully resolve.
 */
export function resolveValuePath(data: unknown, path: string): unknown {
	const segments = parseValuePath(path);
	let current: unknown = data;

	for (const segment of segments) {
		if (current === null || current === undefined) {
			return undefined;
		}
		if (typeof segment === 'number') {
			if (!Array.isArray(current)) {
				return undefined;
			}
			current = current[segment];
			continue;
		}
		if (typeof current !== 'object' || Array.isArray(current)) {
			return undefined;
		}
		if (!Object.prototype.hasOwnProperty.call(current, segment)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}

	return current;
}

// ---------------------------------------------------------------------------
// Settings parsing
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(entry: Record<string, unknown>, key: string): string | undefined {
	const value = entry[key];
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Parse the `endpoints` setting into a typed list. Absent/empty
 * settings yield `[]` (a legal "not configured yet" state); malformed
 * settings throw `CustomHttpMetricsError('invalid_settings')` so
 * misconfiguration surfaces loudly instead of silently dropping
 * endpoints.
 */
export function parseEndpoints(settings?: PluginSettings): CustomHttpMetricEndpoint[] {
	const raw = settings?.endpoints;
	if (raw === undefined || raw === null) {
		return [];
	}
	if (!Array.isArray(raw)) {
		throw new CustomHttpMetricsError('invalid_settings', 'The "endpoints" setting must be an array.');
	}

	return raw.map((entry, index) => {
		if (!isPlainObject(entry)) {
			throw new CustomHttpMetricsError('invalid_settings', `endpoints[${index}] must be an object.`);
		}
		const id = requiredString(entry, 'id');
		const label = requiredString(entry, 'label');
		const url = requiredString(entry, 'url');
		const valuePath = requiredString(entry, 'valuePath');
		if (!id || !label || !url || !valuePath) {
			throw new CustomHttpMetricsError(
				'invalid_settings',
				`endpoints[${index}] is missing a required field — "id", "label", "url" and "valuePath" are all required non-empty strings.`
			);
		}

		const endpoint: CustomHttpMetricEndpoint = { id, label, url, valuePath };
		if (typeof entry.unit === 'string' && entry.unit.trim() !== '') {
			endpoint.unit = entry.unit;
		}
		if (typeof entry.method === 'string') {
			endpoint.method = entry.method;
		}
		if (isPlainObject(entry.headers)) {
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(entry.headers)) {
				if (typeof value === 'string') {
					headers[name] = value;
				}
			}
			endpoint.headers = headers;
		}
		return endpoint;
	});
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

/**
 * Read the response body as text, enforcing the byte cap both via the
 * Content-Length header (fast path) and while streaming (truthful
 * path — Content-Length can lie or be absent).
 */
async function readBodyWithCap(response: Response, maxBytes: number): Promise<string> {
	const tooLarge = () =>
		new CustomHttpMetricsError('response_too_large', `Response exceeds the ${maxBytes}-byte limit.`);

	const contentLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		throw tooLarge();
	}

	const body = response.body;
	if (body && typeof body.getReader === 'function') {
		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let received = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value) {
				received += value.byteLength;
				if (received > maxBytes) {
					await reader.cancel().catch(() => undefined);
					throw tooLarge();
				}
				chunks.push(value);
			}
		}
		const merged = new Uint8Array(received);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder().decode(merged);
	}

	// Bodyless Response (e.g. minimal test doubles) — fall back to text()
	// and enforce the cap after the fact.
	const text = await response.text();
	if (Buffer.byteLength(text, 'utf8') > maxBytes) {
		throw tooLarge();
	}
	return text;
}

/** Coerce a JSON value to a finite number, or `undefined` when impossible. */
function coerceFiniteNumber(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Detect the `redirect: 'error'` rejection. Undici surfaces it as a bare
 * `TypeError` — either directly (`unexpected redirect`) or as
 * `TypeError: fetch failed` with the redirect reason on `cause` — so the
 * message/cause text is the only signal available.
 */
function isRedirectRefusedError(error: unknown): boolean {
	if (!(error instanceof TypeError)) {
		return false;
	}
	const cause = (error as { cause?: unknown }).cause;
	const causeMessage = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
	return /redirect/i.test(error.message) || /redirect/i.test(causeMessage);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class CustomHttpMetricsPlugin implements IPlugin, IMetricsProviderPlugin {
	readonly id = 'custom-http-metrics';
	readonly name = 'Custom HTTP Metrics';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'metrics';
	readonly capabilities: readonly string[] = ['metrics-provider'];
	readonly providerName = 'custom-http';
	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			endpoints: {
				type: 'array',
				title: 'Metric endpoints',
				description:
					'HTTP endpoints to read metric values from. Each endpoint is exposed as one metric. GET-only, JSON responses only; private/internal addresses are blocked.',
				items: {
					type: 'object',
					properties: {
						id: {
							type: 'string',
							title: 'Metric id',
							description:
								'Stable metric identifier (e.g. "signups"). Used by Goals to address this metric.',
							minLength: 1
						},
						label: {
							type: 'string',
							title: 'Label',
							description: 'Human-readable display label (e.g. "Daily signups").',
							minLength: 1
						},
						url: {
							type: 'string',
							title: 'URL',
							format: 'uri',
							description:
								'HTTP(S) URL that returns the metric as JSON. Requests are GET-only and SSRF-guarded (private, loopback, link-local and cloud-metadata addresses are rejected).'
						},
						unit: {
							type: 'string',
							title: 'Unit',
							description: 'Unit of the metric value (e.g. "usd", "count", "ms"). Defaults to "count".',
							default: 'count'
						},
						valuePath: {
							type: 'string',
							title: 'Value path',
							description:
								'Dot/bracket path to the numeric value inside the JSON response, e.g. "data.metrics[0].value" or "stats[\'active users\']".',
							minLength: 1
						},
						method: {
							type: 'string',
							title: 'HTTP method',
							description:
								'Metrics providers are read-only by contract — GET is the only allowed method.',
							enum: ['GET'],
							default: 'GET'
						},
						headers: {
							type: 'object',
							title: 'Request headers',
							description:
								'Extra request headers, e.g. { "Authorization": "Bearer …" }. Header values may contain credentials and are stored as secrets.',
							additionalProperties: { type: 'string' },
							'x-secret': true
						}
					},
					required: ['id', 'label', 'url', 'valuePath']
				}
			}
		}
	};

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Custom HTTP Metrics plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	/**
	 * Cheap synchronous probe. With resolved settings at hand the plugin
	 * is useful iff at least one well-formed endpoint is configured;
	 * without settings (registry-level probe) the plugin itself is
	 * always operational, so report `true`.
	 */
	isAvailable(settings?: PluginSettings): boolean {
		if (settings === undefined) {
			return true;
		}
		try {
			return parseEndpoints(settings).length > 0;
		} catch {
			return false;
		}
	}

	async listMetrics(settings?: PluginSettings): Promise<MetricDescriptor[]> {
		return parseEndpoints(settings).map((endpoint) => ({
			id: endpoint.id,
			label: endpoint.label,
			unit: endpoint.unit ?? DEFAULT_UNIT,
			supportedWindows: ['point']
		}));
	}

	async getMetricValue(query: MetricQuery, settings?: PluginSettings): Promise<MetricSample> {
		const endpoints = parseEndpoints(settings);
		const endpoint = endpoints.find((candidate) => candidate.id === query.metricId);
		if (!endpoint) {
			throw new CustomHttpMetricsError(
				'unknown_metric',
				`Unknown metric "${query.metricId}" — no configured endpoint has that id.`
			);
		}

		if (query.window !== 'point') {
			throw new CustomHttpMetricsError(
				'unsupported_window',
				`Custom HTTP endpoints only support the "point" window (got "${query.window}"). Window semantics beyond a point-in-time reading are the endpoint's concern.`
			);
		}

		// Read-only contract: enforce GET at call time too, in case a
		// non-GET method slipped past settings validation (older stored
		// settings, direct DB edits, …).
		const method = (endpoint.method ?? 'GET').toUpperCase();
		if (method !== 'GET') {
			throw new CustomHttpMetricsError(
				'method_not_allowed',
				`Metrics providers are read-only — only GET is allowed (endpoint "${endpoint.id}" is configured with "${endpoint.method}").`
			);
		}

		const response = await this.fetchEndpoint(endpoint);

		if (!response.ok) {
			throw new CustomHttpMetricsError(
				'http_error',
				`Endpoint "${endpoint.id}" responded with HTTP ${response.status}.`,
				{ status: response.status }
			);
		}

		const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
		if (!contentType.includes('json')) {
			throw new CustomHttpMetricsError(
				'invalid_content_type',
				`Endpoint "${endpoint.id}" must return JSON (got content-type "${contentType || 'unknown'}").`
			);
		}

		const rawBody = await readBodyWithCap(response, MAX_RESPONSE_BYTES);

		let data: unknown;
		try {
			data = JSON.parse(rawBody);
		} catch (error) {
			throw new CustomHttpMetricsError('invalid_json', `Endpoint "${endpoint.id}" returned invalid JSON.`, {
				cause: error
			});
		}

		const extracted = resolveValuePath(data, endpoint.valuePath);
		if (extracted === undefined) {
			throw new CustomHttpMetricsError(
				'value_not_found',
				`Value path "${endpoint.valuePath}" did not resolve to a value in the response of endpoint "${endpoint.id}".`
			);
		}

		const value = coerceFiniteNumber(extracted);
		if (value === undefined) {
			throw new CustomHttpMetricsError(
				'value_not_numeric',
				`Value at "${endpoint.valuePath}" of endpoint "${endpoint.id}" is not a finite number (got ${JSON.stringify(extracted)}).`
			);
		}

		return {
			value,
			unit: endpoint.unit ?? DEFAULT_UNIT,
			at: new Date().toISOString()
		};
	}

	/**
	 * Issue the actual GET through the DNS-pinning SSRF guard. Redirects
	 * are refused outright (`redirect: 'error'`) — the guard does not
	 * re-validate post-redirect targets, so following them would reopen
	 * the private-address hole.
	 */
	private async fetchEndpoint(endpoint: CustomHttpMetricEndpoint): Promise<Response> {
		try {
			return await safeFetchWithDnsPin(endpoint.url, {
				method: 'GET',
				headers: { accept: 'application/json', ...(endpoint.headers ?? {}) },
				redirect: 'error',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
		} catch (error) {
			if (error instanceof SsrfBlockedError) {
				throw new CustomHttpMetricsError(
					'ssrf_blocked',
					`Endpoint "${endpoint.id}" URL was rejected by the SSRF guard: ${error.message}`,
					{ cause: error }
				);
			}
			if (isTimeoutError(error)) {
				throw new CustomHttpMetricsError(
					'timeout',
					`Endpoint "${endpoint.id}" did not respond within ${REQUEST_TIMEOUT_MS}ms.`,
					{ cause: error }
				);
			}
			if (isRedirectRefusedError(error)) {
				throw new CustomHttpMetricsError(
					'redirect_blocked',
					`Endpoint "${endpoint.id}" responded with an HTTP redirect — redirects are refused because the SSRF guard does not re-validate post-redirect targets. Configure the final URL directly.`,
					{ cause: error }
				);
			}
			throw error;
		}
	}

	/**
	 * Custom validation beyond JSON Schema: GET-only enforcement, URL /
	 * SSRF pre-checks, value-path syntax and duplicate-id detection.
	 * (The lexical SSRF check here is early feedback only — the
	 * authoritative guard runs on every fetch.)
	 */
	validateSettings(settings: Record<string, unknown>): ValidationResult {
		const errors: ValidationError[] = [];
		const warnings: ValidationError[] = [];

		const raw = settings.endpoints;
		if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
			return {
				valid: true,
				warnings: [
					{
						path: 'endpoints',
						message:
							'No metric endpoints configured yet — the plugin will expose no metrics until you add one.'
					}
				]
			};
		}
		if (!Array.isArray(raw)) {
			return {
				valid: false,
				errors: [{ path: 'endpoints', message: 'Must be an array of endpoint objects.' }]
			};
		}

		const seenIds = new Set<string>();
		raw.forEach((entry, index) => {
			const basePath = `endpoints[${index}]`;
			if (!isPlainObject(entry)) {
				errors.push({ path: basePath, message: 'Must be an object.' });
				return;
			}

			for (const field of ['id', 'label', 'url', 'valuePath'] as const) {
				if (requiredString(entry, field) === undefined) {
					errors.push({ path: `${basePath}.${field}`, message: 'Required non-empty string.' });
				}
			}

			const id = requiredString(entry, 'id');
			if (id !== undefined) {
				if (seenIds.has(id)) {
					errors.push({ path: `${basePath}.id`, message: `Duplicate metric id "${id}".` });
				}
				seenIds.add(id);
			}

			if (typeof entry.method === 'string' && entry.method.toUpperCase() !== 'GET') {
				errors.push({
					path: `${basePath}.method`,
					message: `Metrics providers are read-only — only GET is allowed (got "${entry.method}").`
				});
			}

			const url = requiredString(entry, 'url');
			if (url !== undefined && !isSafeWebhookUrl(url)) {
				errors.push({
					path: `${basePath}.url`,
					message:
						'URL is not allowed — it must be a valid http(s) URL and must not point at private, loopback, link-local or cloud-metadata addresses.'
				});
			}

			const valuePath = requiredString(entry, 'valuePath');
			if (valuePath !== undefined) {
				try {
					parseValuePath(valuePath);
				} catch (error) {
					errors.push({
						path: `${basePath}.valuePath`,
						message: `Invalid value path: ${error instanceof Error ? error.message : String(error)}`
					});
				}
			}

			if (entry.headers !== undefined && !isPlainObject(entry.headers)) {
				errors.push({ path: `${basePath}.headers`, message: 'Must be an object of string header values.' });
			} else if (isPlainObject(entry.headers)) {
				for (const [name, value] of Object.entries(entry.headers)) {
					if (typeof value !== 'string') {
						errors.push({
							path: `${basePath}.headers.${name}`,
							message: 'Header values must be strings.'
						});
					}
				}
			}
		});

		if (errors.length > 0) {
			return { valid: false, errors, ...(warnings.length > 0 ? { warnings } : {}) };
		}
		return warnings.length > 0 ? { valid: true, warnings } : { valid: true };
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Custom HTTP Metrics plugin is ready (metrics come from user-configured endpoints)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Read numeric metric values from your own HTTP endpoints (GET-only, JSON). Each configured endpoint becomes one metric that Goals can evaluate targets against.',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			icon: { type: 'lucide', value: 'Activity', backgroundColor: '#0ea5e9' },
			keywords: ['metrics', 'goals', 'http', 'custom'],
			readme: [
				'## What does Custom HTTP Metrics do?',
				'',
				'It turns any JSON HTTP endpoint you control into a platform metric. Configure a URL, an optional auth header and a value path (e.g. `data.metrics[0].value`) — the platform then reads the current numeric value on demand, so Goals can evaluate targets against it.',
				'',
				'## Why use it?',
				'',
				'- **Bring your own numbers** — expose any internal counter or KPI without waiting for a first-party integration',
				'- **Read-only by design** — only GET requests are ever issued; the plugin cannot mutate anything',
				'- **Safe by default** — URLs are SSRF-guarded (private/internal addresses blocked), redirects refused, responses capped at 1 MB / 15 s',
				'',
				'## How it works in Ever Works',
				'',
				'Each configured endpoint appears as one metric with `point` window support (an instantaneous reading). The Metrics facade routes `getMetricValue` calls here, extracts the number at your configured value path and records usage for budgets.',
				'',
				'## Getting started',
				'',
				'1. Add an endpoint: id, label, URL and value path',
				'2. Optionally set a unit (e.g. `usd`) and an `Authorization` header',
				'3. Reference the metric id from a Goal target'
			].join('\n')
		};
	}
}

export default CustomHttpMetricsPlugin;
