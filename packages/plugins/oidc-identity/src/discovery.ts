import type { IdentityTokenRejectionCode } from '@ever-works/plugin';

/**
 * APW-12 T6 — the discovery half of the `identity-provider` capability: reading
 * the provider's OpenID Connect discovery document, and the outbound rule every
 * call to Ever ID obeys.
 *
 * Spec: FR-3 (what **Test connection** reads and reports), FR-14 (the discovery
 * document is cached for 3,600 seconds; a changed issuer turns sign-in off until
 * an administrator re-tests), FR-15 (5,000 ms timeout; discovery and key fetches
 * retry once after 1,000 ms) and FR-16 (nothing here may reach a log with token
 * material in it). Plan §4.3 is the table these numbers come from.
 *
 * ## Why this reads the document itself instead of `openid-client.discovery()`
 *
 * Plan §4.2 names `openid-client` as the flow's tool, and it stays that: T7 and
 * T8 build the `Configuration` (`buildAuthorizationUrl`,
 * `authorizationCodeGrant`) from the document this module read. The diagnostic
 * read cannot be that call, for two measured reasons:
 *
 *   1. **FR-3 wants a row per check, not an exception.** `openid-client`'s
 *      `discovery()` rejects when the discovered `issuer` differs from the
 *      address it fetched (`build/index.js` — "discovered metadata issuer does
 *      not match the expected issuer"), and that rejection is precisely the
 *      `issuerMatch` row FR-3 asks **Test connection** to render. A call that
 *      throws cannot report "the endpoints are present but S256 is missing"
 *      either: it is all-or-nothing.
 *   2. **FR-15's retry and testability.** `discovery()` bounds itself with
 *      `AbortSignal.timeout()` — a native timer a fake clock cannot drive — and
 *      performs no retry; §4.3 asks for one retry after 1,000 ms.
 *
 * Both reasons are about the *diagnostic* path only. Nothing here duplicates a
 * security decision: the document this module returns is the document T7/T8 feed
 * to `openid-client`, and the numbers below are the same §4.3 numbers.
 *
 * ## The numbers, and the one place they come from
 *
 * The constants below mirror `EVER_ID_LIMITS` in
 * `packages/contracts/src/apps/ever-id.ts` — plan §4.3's single source. This
 * package does not depend on `@ever-works/contracts` (T5 transcribed the
 * settings-schema bounds the same way and said so), so the values are
 * transcribed here rather than imported, and
 * `src/__tests__/test-connection.spec.ts` reads the contracts source off disk and
 * asserts the two agree, so a drift on either side reddens a test instead of
 * shipping.
 */

/**
 * FR-15 — every call to Ever ID times out after 5,000 ms.
 *
 * This is the per-attempt bound. For **Test connection** it is also the bound on
 * the whole run (FR-3, ACC-12-03): `testConnection` passes a deadline so the
 * retry can never push the answer past 5 seconds.
 */
export const OIDC_OUTBOUND_TIMEOUT_MS = 5_000;

/** FR-15 — discovery and key fetches retry **once** after 1,000 ms. */
export const OIDC_OUTBOUND_RETRY_DELAY_MS = 1_000;

/** FR-15 — "retry once": two attempts, never three. */
export const OIDC_OUTBOUND_MAX_ATTEMPTS = 2;

/** FR-14 — the discovery document is cached for 3,600 seconds. */
export const OIDC_DISCOVERY_CACHE_SECONDS = 3_600;

/** FR-13 — signing keys are cached for 600 seconds. */
export const OIDC_JWKS_CACHE_SECONDS = 600;

/** FR-13 — an unknown key id triggers at most one refresh per 30 seconds. */
export const OIDC_JWKS_UNKNOWN_KID_COOLDOWN_SECONDS = 30;

/** FR-13 — cached keys stay usable for at most 21,600 seconds, then fail closed. */
export const OIDC_JWKS_MAX_STALE_SECONDS = 21_600;

/**
 * FR-11 / FR-3 — the only signing algorithms Ever ID may use, in one place.
 *
 * FR-11 accepts an ID token signed with one of these three; FR-3 reports failure
 * when the provider advertises none of them. The key cache (§4.3) rejects `none`
 * and `HS*` **before** it looks a key up, which is this same list read as an
 * allow-list.
 */
export const OIDC_IDENTITY_SIGNING_ALGS = ['RS256', 'ES256', 'EdDSA'] as const;

/** One of {@link OIDC_IDENTITY_SIGNING_ALGS}. */
export type OidcIdentitySigningAlg = (typeof OIDC_IDENTITY_SIGNING_ALGS)[number];

/**
 * The subset of the token-rejection vocabulary (`@ever-works/plugin`) this module
 * can raise.
 *
 * `providerUnavailable` is the honest answer when the provider cannot be reached
 * or its keys can no longer be trusted; T7/T8 rethrow it as
 * `IdentityTokenRejectedError` with the same code, so the closed set the contract
 * publishes stays the only vocabulary a caller branches on.
 */
export type OidcProviderUnavailableCode = Extract<IdentityTokenRejectionCode, 'providerUnavailable'>;

/**
 * Why the provider is unavailable — a closed set, never a provider's own text.
 *
 * FR-16 forbids a message carrying token material, and the cheapest way to keep
 * that promise in a path that has a client secret in scope is to have no free
 * text at all: `OidcProviderUnavailableError.message` **is** the code, and this
 * reason names which rule failed. T12 maps it onto the facade's
 * `IdentityProviderUnavailableError`; T32 records it in `availability`.
 */
export type OidcProviderUnavailableReason =
	/** FR-2/FR-3 — the integration is not configured, so nothing can be read. */
	| 'notConfigured'
	/** FR-14 — the discovery document could not be read. */
	| 'discoveryFailed'
	/** FR-14 — the provider advertises a different issuer than the configured one. */
	| 'issuerDrift'
	/** FR-3 — discovery answered, but a required capability is missing. */
	| 'discoveryIncomplete'
	/** FR-13 — no key set has ever been fetched, so nothing may be verified. */
	| 'keysUnavailable'
	/** FR-13 — the last good key fetch is older than 21,600 seconds: fail closed. */
	| 'keysStale';

/**
 * The single error a discovery or key-set failure raises (FR-14, FR-13).
 *
 * `message` is the code and nothing else — no issuer echo, no HTTP body, no
 * client secret (FR-16). Extending `Error` is load-bearing exactly as it is for
 * `IdentityTokenRejectedError`: callers catch it as an `Error` and branch on
 * `code`, and a reason they do not recognise must degrade to "unavailable",
 * never to a pass.
 */
export class OidcProviderUnavailableError extends Error {
	readonly code: OidcProviderUnavailableCode = 'providerUnavailable';

	constructor(readonly reason: OidcProviderUnavailableReason) {
		super('providerUnavailable');
		this.name = 'OidcProviderUnavailableError';
	}
}

/**
 * The discovery document, as far as this package reads it.
 *
 * Only the fields FR-3 and T7/T8's flow need are named; the index signature keeps
 * every other claim (`userinfo_endpoint`, `end_session_endpoint`,
 * `revocation_endpoint`, `token_endpoint_auth_methods_supported`, …) verbatim, so
 * a later task reads a claim without re-fetching and without this interface
 * having to grow first.
 */
export interface OidcDiscoveryDocument {
	/** The issuer the provider claims — FR-3 compares it to the configured one, exactly. */
	issuer: string;
	authorization_endpoint?: string;
	token_endpoint?: string;
	jwks_uri?: string;
	end_session_endpoint?: string;
	device_authorization_endpoint?: string;
	code_challenge_methods_supported?: string[];
	id_token_signing_alg_values_supported?: string[];
	backchannel_logout_supported?: boolean;
	backchannel_logout_session_supported?: boolean;
	[claim: string]: unknown;
}

/** The shape of a response this module needs — a structural subset of `Response`. */
export interface OidcHttpResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}

/**
 * What this module hands the fetch seam.
 *
 * `signal` and `headers` are what T6 needed; `method` and `body` were added by
 * **T7**, because the code exchange is the one call that is not a GET — and a
 * spec that cannot see the request it is asserting on cannot prove FR-15's
 * `client_secret_basic`, the four form fields of RFC 6749 §4.1.3 or the absence
 * of a retry. Both are optional and both default to a bodyless GET, so every
 * T6 fake that ignores them keeps compiling and keeps its behaviour.
 */
export interface OidcFetchInit {
	readonly signal: AbortSignal;
	readonly headers: Record<string, string>;
	/** The HTTP method; the callers that pass one pass `POST`. Defaults to a GET. */
	readonly method?: string;
	/** The already-encoded request body, sent only when present. */
	readonly body?: string;
}

/**
 * The seam every outbound call goes through.
 *
 * Optional everywhere it is used, and defaulting to the runtime's `fetch`: the
 * platform's plugin loader constructs a plugin with no arguments
 * (`PluginLoaderService.loadPluginModule`, `plugin-loader.service.ts:364` —
 * `new PluginClass()`), so an injected fetch is a test's business and never a
 * production requirement.
 */
export type OidcFetchImpl = (url: string, init: OidcFetchInit) => Promise<OidcHttpResponse>;

/** The runtime `fetch`, adapted to {@link OidcFetchImpl} so no call site casts. */
export const oidcDefaultFetch: OidcFetchImpl = (url, init) => fetch(url, init);

/** One JSON request. */
export interface OidcOutboundRequest {
	readonly url: string;
	/** Extra headers; `accept: application/json` is always sent. */
	readonly headers?: Record<string, string>;
	/**
	 * The HTTP method. Absent means a GET — the discovery read and the key fetch
	 * (FR-3, FR-13). T7's code exchange passes `POST`, the one call that is not.
	 */
	readonly method?: string;
	/** The request body, encoded by the caller; sent only when present. */
	readonly body?: string;
	/**
	 * Sent as `content-type` when a body is sent.
	 *
	 * The token endpoint of RFC 6749 §4.1.3 takes
	 * `application/x-www-form-urlencoded`; a provider that checks the header — as
	 * ZITADEL and Keycloak both do — answers `415` without it.
	 */
	readonly contentType?: string;
}

/** Every injectable knob of an outbound call. */
export interface OidcOutboundOptions {
	readonly fetchImpl?: OidcFetchImpl;
	/** The clock, in epoch milliseconds. Defaults to `Date.now`. */
	readonly now?: () => number;
	readonly timeoutMs?: number;
	readonly retryDelayMs?: number;
	/**
	 * Absolute epoch-ms deadline the **whole** call must fit inside.
	 *
	 * FR-3 gives **Test connection** 5 seconds for every check, while FR-15 gives
	 * discovery one retry after 1 second — with a 5,000 ms per-attempt timeout the
	 * two together would allow 11 seconds. The deadline is how the two are kept:
	 * the retry happens whenever it fits, and the answer is reported at the
	 * deadline either way. Callers with no such bound (the key fetch, FR-13) leave
	 * it undefined and get §4.3 literally.
	 */
	readonly deadlineAt?: number;
}

/** Why a JSON GET did not produce a body. */
export type OidcOutboundFailure = 'timeout' | 'httpStatus' | 'network' | 'invalidBody';

/** The outcome of {@link fetchJsonWithOneRetry}. */
export interface OidcOutboundResult {
	readonly ok: boolean;
	/** Present as soon as a response was received, pass or fail. */
	readonly status?: number;
	/** The parsed body, when `ok`. */
	readonly body?: unknown;
	/** Why it failed, when not `ok`. */
	readonly failure?: OidcOutboundFailure;
	/** How many attempts were started — 1 or 2 (FR-15). */
	readonly attempts: number;
}

/**
 * One request, **never retried** — FR-15's "the code exchange is never retried".
 *
 * Same per-attempt bound as {@link fetchJsonWithOneRetry}
 * ({@link OIDC_OUTBOUND_TIMEOUT_MS}, on a `setTimeout` so an injected clock and
 * vitest's fake timers can drive it) and the same never-rejects contract, but a
 * single attempt by construction rather than by option: a security-relevant
 * "no second try" is safer as a different function than as a flag a caller can
 * pass wrongly. FR-15 gives the token endpoint 5,000 ms and one attempt, and
 * this is that rule.
 *
 * `deadlineAt` is honoured when a caller passes one, and reports how many
 * attempts had started when the bound was reached — `1` once the request is in
 * flight, `0` if it never was.
 */
export async function fetchJsonOnce(
	request: OidcOutboundRequest,
	options: OidcOutboundOptions = {}
): Promise<OidcOutboundResult> {
	const now = options.now ?? Date.now;
	const startedAt = now();
	const attempts = { count: 0 };
	const work = (async (): Promise<OidcOutboundResult> => {
		attempts.count += 1;
		return {
			...(await readJsonOnce(
				request,
				options.fetchImpl ?? oidcDefaultFetch,
				options.timeoutMs ?? OIDC_OUTBOUND_TIMEOUT_MS
			)),
			attempts: attempts.count
		};
	})();
	if (options.deadlineAt === undefined) return work;
	const remaining = Math.max(0, options.deadlineAt - startedAt);
	return settleWithin(work, remaining, () => ({ ok: false, failure: 'timeout', attempts: attempts.count }));
}

/**
 * FR-15's outbound rule, implemented once for discovery and the key set.
 *
 * Two attempts at most, the second after {@link OIDC_OUTBOUND_RETRY_DELAY_MS},
 * each bounded by {@link OIDC_OUTBOUND_TIMEOUT_MS}, and the whole call bounded by
 * `deadlineAt` when the caller has one. It never rejects: a provider that is
 * down, slow or answers nonsense is a *result* here, because every caller has a
 * fail-closed answer to give (a failed check row, `providerUnavailable`) and none
 * of them wants a raw fetch error in its stack.
 */
export async function fetchJsonWithOneRetry(
	request: OidcOutboundRequest,
	options: OidcOutboundOptions = {}
): Promise<OidcOutboundResult> {
	const now = options.now ?? Date.now;
	const startedAt = now();
	// Shared with the loop so the deadline's answer can report how many attempts
	// had actually started when time ran out.
	const attempts = { count: 0 };
	const work = attemptJsonFetch(request, options, attempts);
	if (options.deadlineAt === undefined) return work;
	const remaining = Math.max(0, options.deadlineAt - startedAt);
	return settleWithin(work, remaining, () => ({ ok: false, failure: 'timeout', attempts: attempts.count }));
}

/**
 * The attempt loop behind {@link fetchJsonWithOneRetry}.
 *
 * Reads `attempts` as it goes so the deadline path can report a truthful count,
 * and swallows everything: the retry decision is about what the provider
 * answered, never about the shape of an error object.
 */
async function attemptJsonFetch(
	request: OidcOutboundRequest,
	options: OidcOutboundOptions,
	attempts: { count: number }
): Promise<OidcOutboundResult> {
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? OIDC_OUTBOUND_TIMEOUT_MS;
	const retryDelayMs = options.retryDelayMs ?? OIDC_OUTBOUND_RETRY_DELAY_MS;
	const deadlineAt = options.deadlineAt;
	let last: OidcOutboundResult = { ok: false, failure: 'timeout', attempts: 0 };

	try {
		for (let attempt = 1; attempt <= OIDC_OUTBOUND_MAX_ATTEMPTS; attempt += 1) {
			if (attempt > 1) {
				// FR-3's 5 s bound decides whether the retry fits at all: a first
				// attempt that used the whole budget leaves no room for one, and
				// reporting late would break the bound the check exists to prove.
				if (deadlineAt !== undefined && now() + retryDelayMs >= deadlineAt) break;
				await delayFor(retryDelayMs);
			}
			if (deadlineAt !== undefined && now() >= deadlineAt) break;

			const perAttemptMs =
				deadlineAt === undefined ? timeoutMs : Math.max(1, Math.min(timeoutMs, deadlineAt - now()));
			attempts.count = attempt;
			last = {
				...(await readJsonOnce(request, options.fetchImpl ?? oidcDefaultFetch, perAttemptMs)),
				attempts: attempt
			};
			if (last.ok) return last;
		}
	} catch {
		// Unreachable by construction (readJsonOnce and delayFor do not reject); a
		// last-resort fail-closed answer beats an exception escaping to a caller
		// that has a check row to render.
	}

	return { ...last, attempts: attempts.count };
}

/** One GET: 5,000 ms, one JSON parse, and no error text that could carry a body. */
async function readJsonOnce(
	request: OidcOutboundRequest,
	fetchImpl: OidcFetchImpl,
	timeoutMs: number
): Promise<Omit<OidcOutboundResult, 'attempts'>> {
	const controller = new AbortController();
	// setTimeout rather than `AbortSignal.timeout`: the injected clock in the specs
	// drives vitest's fake timers, and a native timer would ignore them — the 5 s
	// bound would then only be provable by really waiting 5 seconds.
	const timer = scheduleTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(request.url, {
			signal: controller.signal,
			method: request.method ?? 'GET',
			...(request.body === undefined ? {} : { body: request.body }),
			headers: {
				accept: 'application/json',
				...(request.contentType === undefined ? {} : { 'content-type': request.contentType }),
				...request.headers
			}
		});
		if (!response || typeof response.status !== 'number' || response.ok !== true) {
			return { ok: false, failure: 'httpStatus', status: response?.status };
		}
		try {
			return { ok: true, status: response.status, body: await response.json() };
		} catch {
			return { ok: false, failure: 'invalidBody', status: response.status };
		}
	} catch {
		// A rejected fetch is either our abort (timeout) or the transport. Both are
		// reported as codes, never as the error's own message: a transport error can
		// quote the URL and headers a Basic-auth request carried (FR-16).
		return { ok: false, failure: controller.signal.aborted ? 'timeout' : 'network' };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolve `work`, or the fallback after `ms` — whichever happens first.
 *
 * The timer is cleared when `work` wins, and the fallback also answers a
 * rejection, so a caller can never be left waiting on a promise that will not
 * settle. Used for FR-3's whole-run bound, which must hold even when an injected
 * fetch ignores its abort signal.
 */
function settleWithin<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
	return new Promise<T>((resolve) => {
		const timer = scheduleTimeout(() => resolve(fallback()), ms);
		const done = (value: T): void => {
			clearTimeout(timer);
			resolve(value);
		};
		work.then(done, () => done(fallback()));
	});
}

/** A `setTimeout` that never keeps the process alive (an unref'd timer). */
function scheduleTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
	const timer = setTimeout(callback, ms);
	const unref = (timer as { unref?: () => void }).unref;
	if (typeof unref === 'function') unref.call(timer);
	return timer;
}

/** FR-15's 1,000 ms pause between the two attempts. */
function delayFor(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve) => {
		scheduleTimeout(resolve, ms);
	});
}

/**
 * RFC 8414 §3.1's metadata address for an issuer.
 *
 * The well-known segment is appended to the issuer's **path**, so an issuer with
 * a tenant path (`https://id.example/realms/ever`) discovers from
 * `/realms/ever/.well-known/openid-configuration` — what ZITADEL, Keycloak and
 * Entra all publish — rather than from the origin, which is what
 * `oauth4webapi.discoveryRequest` (the engine behind `openid-client`) does too.
 */
export function buildDiscoveryUrl(issuerUrl: string): string {
	const url = new URL(issuerUrl);
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/.well-known/openid-configuration`;
	url.search = '';
	url.hash = '';
	return url.toString();
}

/** Why a discovery read produced no document. */
export type OidcDiscoveryFailure =
	| OidcOutboundFailure
	/** The configured issuer is not an address a discovery document can be read from. */
	| 'invalidIssuer'
	/** A 200 answered with a body that is not an object carrying a string `issuer`. */
	| 'invalidDocument';

/** The outcome of one discovery read (FR-3, FR-14). */
export type OidcDiscoveryRead =
	| {
			readonly ok: true;
			readonly document: OidcDiscoveryDocument;
			readonly fetchedAt: number;
			/**
			 * FR-3: whether the document's `issuer` equals the configured issuer
			 * **exactly**. A `false` here is a reported check row, not an exception —
			 * and every other read path in this class refuses to hand the document on
			 * when it is false (FR-14's disable).
			 */
			readonly issuerMatches: boolean;
			readonly attempts: number;
	  }
	| {
			readonly ok: false;
			readonly failure: OidcDiscoveryFailure;
			readonly attempts: number;
			readonly status?: number;
	  };

/** Construction options for {@link OidcDiscoveryReader}. */
export interface OidcDiscoveryOptions extends OidcOutboundOptions {
	/** The administrator's configured issuer address (FR-2), compared exactly. */
	readonly issuerUrl: string;
	/** FR-14's 3,600 seconds; overridable so a spec can pin the boundary. */
	readonly cacheSeconds?: number;
}

/**
 * The discovery document, read, cached for 3,600 seconds and refused on drift
 * (FR-14).
 *
 * Two entry points, and the difference between them is the point:
 *
 *   - {@link read} **always** fetches. It is what **Test connection** calls, because
 *     an administrator pressing the button is asking the provider a question and a
 *     cached answer would defeat FR-14's "until an administrator re-tests".
 *   - {@link get} serves the cache and refreshes it when it has expired. It is what
 *     the flow calls, and it fails closed — `providerUnavailable` — whenever the
 *     document could not be read or the provider's issuer has drifted, so a
 *     sign-in can never proceed against a provider whose identity changed under
 *     it.
 */
export class OidcDiscoveryReader {
	private document: OidcDiscoveryDocument | null = null;
	private fetchedAtMs: number | null = null;

	constructor(private readonly options: OidcDiscoveryOptions) {}

	/** The configured issuer this reader answers for (FR-7: one issuer set per installation). */
	get issuerUrl(): string {
		return this.options.issuerUrl;
	}

	/**
	 * When the last successful read happened, in epoch ms, or `null`.
	 *
	 * This is the in-process source of plan §4.2's `availability.discoveryRefreshedAt`
	 * and of plan §9.1's health view; T32 persists it.
	 */
	get lastRefreshedAt(): number | null {
		return this.fetchedAtMs;
	}

	/** The cached document while FR-14's 3,600 seconds have not elapsed, else `null`. */
	cachedDocument(): OidcDiscoveryDocument | null {
		if (this.document === null || this.fetchedAtMs === null) return null;
		const cacheMs = (this.options.cacheSeconds ?? OIDC_DISCOVERY_CACHE_SECONDS) * 1_000;
		return this.now() - this.fetchedAtMs < cacheMs ? this.document : null;
	}

	/**
	 * Read the document from the provider now (FR-3's read, FR-14's 3,600-second cache
	 * entry point).
	 *
	 * A successful read replaces the cache even when the issuer drifts: the drift is
	 * what an administrator needs to see, and {@link get} refuses it either way.
	 */
	async read(options: { deadlineAt?: number } = {}): Promise<OidcDiscoveryRead> {
		let url: string;
		try {
			url = buildDiscoveryUrl(this.options.issuerUrl);
		} catch {
			// The settings schema refuses a non-URL issuer at write time; this is the
			// fail-closed answer for a value that reached us another way.
			return { ok: false, failure: 'invalidIssuer', attempts: 0 };
		}

		const result = await fetchJsonWithOneRetry(
			{ url },
			{
				fetchImpl: this.options.fetchImpl,
				now: this.options.now,
				timeoutMs: this.options.timeoutMs,
				retryDelayMs: this.options.retryDelayMs,
				deadlineAt: options.deadlineAt
			}
		);
		if (!result.ok) {
			return {
				ok: false,
				failure: result.failure ?? 'network',
				attempts: result.attempts,
				status: result.status
			};
		}

		const document = asDiscoveryDocument(result.body);
		if (document === null) {
			return { ok: false, failure: 'invalidDocument', attempts: result.attempts, status: result.status };
		}

		const fetchedAt = this.now();
		this.document = document;
		this.fetchedAtMs = fetchedAt;
		return {
			ok: true,
			document,
			fetchedAt,
			issuerMatches: document.issuer === this.options.issuerUrl,
			attempts: result.attempts
		};
	}

	/**
	 * The document, from the cache while it is fresh and from the provider once it is
	 * not (FR-14). Throws {@link OidcProviderUnavailableError} rather than returning
	 * `null`: every caller of this method is on a path that must not continue without
	 * a document.
	 */
	async get(): Promise<OidcDiscoveryDocument> {
		const cached = this.cachedDocument();
		if (cached !== null) {
			this.assertIssuerMatches(cached);
			return cached;
		}

		const read = await this.read();
		if (!read.ok) throw new OidcProviderUnavailableError('discoveryFailed');
		this.assertIssuerMatches(read.document);
		return read.document;
	}

	/** FR-14: a different issuer turns sign-in off until an administrator re-tests. */
	private assertIssuerMatches(document: OidcDiscoveryDocument): void {
		if (document.issuer !== this.options.issuerUrl) throw new OidcProviderUnavailableError('issuerDrift');
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}
}

/**
 * The document, or `null` when the body is not one.
 *
 * `issuer` is the only claim required here: it is the one FR-3 compares and the
 * one FR-11 anchors `iss` to, so a body without it is not a discovery document at
 * all. Every other claim's absence is a *check row*, which is why they are not
 * required — the row is how an administrator learns which one is missing.
 */
export function asDiscoveryDocument(value: unknown): OidcDiscoveryDocument | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.issuer !== 'string' || candidate.issuer.length === 0) return null;
	return value as OidcDiscoveryDocument;
}
