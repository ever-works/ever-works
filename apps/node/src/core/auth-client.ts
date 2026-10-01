import {
	EVER_ID_ERROR_CODE_WIRE_VALUES,
	EVER_ID_LIMITS,
	EVER_ID_SCOPES,
	EVER_ID_WIRE_ERROR_CODES,
	type EverIdErrorCode,
	type EverIdWireErrorCode
} from '@ever-works/contracts';
import { FleetClientError, joinUrl, normalizeApiUrl, type FetchLike, type FetchRequestInit } from './fleet-client';
import type { Scheduler } from './heartbeat';
import type { Logger } from './logger';
import type { FleetNodeKind } from './types';

/**
 * The *authenticate* leg of enrollment (PRD §3.2 — "sign in instead of
 * pasting").
 *
 * Before this, the only way onto a fleet was: open the web app, issue a
 * one-time token in Fleet settings, copy it, alt-tab, paste it. That is fine
 * for one machine and miserable for ten — and it pushes a single-use
 * credential through the clipboard, which is the least protected place on the
 * machine.
 *
 * This client lets the node do the same two calls the human was doing by hand:
 *
 *   POST /api/auth/login                    email + password → session token
 *   POST /api/fleet/nodes/enrollment-token  session token   → enrollment token
 *
 * The enrollment token is then consumed by the ordinary `POST /api/fleet/enroll`
 * path, so the server-side protocol is completely unchanged — this is a nicer
 * way to OBTAIN the token, not a new way to enroll.
 *
 * ## Credential handling
 *
 * - The password is used for exactly one request and is never stored,
 *   persisted, or logged. Callers pass it straight through from the form.
 * - The session token and the minted enrollment token are registered with the
 *   logger (`protect`) the moment they exist, so neither can appear in a log
 *   line or an error message.
 * - Only the long-lived heartbeat secret is ever written to disk, by the
 *   existing `saveConfig` path. Nothing here persists anything.
 *
 * ## Sign in with Ever ID (APW-12)
 *
 * {@link PlatformAuthClient.signInWithEverId} obtains the same session token
 * without a password, through the OAuth 2.0 device authorization grant
 * (RFC 8628) run directly against Ever ID with the node's own public client:
 *
 *   GET  /api/auth/ever-id/client-config            issuer + the `node` client id
 *   GET  <issuer>/.well-known/openid-configuration   device + token endpoints
 *   POST <device_authorization_endpoint>             client id + scope → codes
 *   POST <token_endpoint>, polled                    device code → access token
 *   POST /api/auth/ever-id/session                   access token → session token
 *
 * The person is shown Ever ID's verification address and the user code — and
 * nothing else. The device code and the Ever ID access token are protected the
 * moment they exist and forgotten once they are spent; the access token never
 * leaves the method that exchanges it.
 */

/** Result of a successful sign-in. The token is short-lived and in-memory only. */
export interface SignInResult {
	sessionToken: string;
	userId: string | null;
	email: string | null;
}

export interface PlatformAuthClientOptions {
	apiUrl: string;
	fetchFn: FetchLike;
	logger?: Logger;
	/** Sent as `User-Agent` — the production edge 403s default/absent agents. */
	userAgent?: string;
	/** Per-request timeout; 0 disables the abort signal (used in tests). */
	timeoutMs?: number;
	/** Timers for the Ever ID sign-in's polling; defaults to the real ones. */
	scheduler?: Scheduler;
	/** Wall clock (ms) for the Ever ID code's expiry; defaults to `Date.now`. */
	now?: () => number;
}

export const DEFAULT_AUTH_TIMEOUT_MS = 20_000;

/** What the person needs to approve an Ever ID sign-in (spec §6.6). */
export interface EverIdDevicePrompt {
	/** Ever ID's verification address. It never carries the code. */
	verificationUri: string;
	/** The code to enter at that address. */
	userCode: string;
	/** Seconds until the code expires — at most 900 (FR-41). */
	expiresInSeconds: number;
}

export interface SignInWithEverIdOptions {
	/**
	 * Shows the person the verification address and the code. Called once,
	 * before polling starts; a returned promise is awaited first.
	 */
	onPrompt: (prompt: EverIdDevicePrompt) => void | Promise<void>;
}

/**
 * How an Ever ID sign-in can end, in the spec's words where it has them
 * (S16, S17, S22, S23, §6.6). Client-authored, like every message here.
 */
export const EVER_ID_SIGN_IN_MESSAGES = {
	unavailable: "Ever ID isn't available on this server. Sign in another way.",
	providerUnavailable: "Ever ID isn't responding. Try again in a minute, or sign in another way.",
	expired: 'The code expired. Start again.',
	declined: 'Sign-in was declined at Ever ID.',
	notConnected: 'Connect Ever ID to your Ever Works account in Settings → Security first.',
	signInExpired: 'That sign-in expired or was already used. Start again.',
	accountSuspended: 'Account is suspended.',
	rateLimited: 'Too many attempts — wait a minute and try again',
	insecureApiUrl: (host: string) =>
		`Refusing to send an Ever ID sign-in over insecure HTTP to a non-local host (${host}). Use an https:// API URL.`,
	insecureProvider: (host: string) => `Refusing to use Ever ID over insecure HTTP (${host}).`,
	providerRejected: (error: string) => `Ever ID refused the sign-in request (${error}).`
} as const;

/** The local-client kind a node signs in as (`GET /client-config`). */
const EVER_ID_CLIENT_KIND = 'node';

/** Exactly the scopes the device request asks for; no `audience`, no `resource` (plan §7). */
const EVER_ID_DEVICE_SCOPE = ['openid', 'email', EVER_ID_SCOPES.SESSION_EXCHANGE].join(' ');

const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** RFC 8628 §3.5: back off on a failed poll, but stop waiting on an Ever ID that is down. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

interface EverIdDeviceGrant {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

interface EverIdReply {
	ok: boolean;
	/** 0 when the server could not be reached or read. */
	status: number;
	/** The parsed JSON body, or `undefined` when there was none or it was not JSON. */
	body: unknown;
	/** Why the server could not be reached or read (status 0 only). */
	failure?: string;
}

/** Local shape check so an obviously empty form never leaves the machine. */
export function credentialsLookUsable(email: string | undefined, password: string | undefined): boolean {
	if (typeof email !== 'string' || typeof password !== 'string') {
		return false;
	}
	const trimmed = email.trim();
	// Deliberately loose: the server owns email validation. We only refuse
	// input that cannot possibly be an address, so the user gets an instant
	// answer instead of a round trip.
	return trimmed.length >= 3 && trimmed.includes('@') && password.length > 0;
}

export class PlatformAuthClient {
	private readonly apiUrl: string;
	private readonly fetchFn: FetchLike;
	private readonly logger: Logger | undefined;
	private readonly userAgent: string;
	private readonly timeoutMs: number;
	private readonly scheduler: Scheduler | undefined;
	private readonly now: () => number;

	constructor(options: PlatformAuthClientOptions) {
		this.apiUrl = normalizeApiUrl(options.apiUrl);
		this.fetchFn = options.fetchFn;
		this.logger = options.logger;
		this.userAgent = options.userAgent ?? 'ever-works-node';
		this.timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
		this.scheduler = options.scheduler;
		this.now = options.now ?? (() => Date.now());
	}

	get baseUrl(): string {
		return this.apiUrl;
	}

	/**
	 * Exchange email + password for a session token.
	 *
	 * The password is passed straight into the request body and dropped: it is
	 * never held in a field, never logged, never written anywhere.
	 */
	async signIn(email: string, password: string): Promise<SignInResult> {
		if (!credentialsLookUsable(email, password)) {
			throw new FleetClientError('invalid-request', 'Enter the email and password of your Ever Works account');
		}

		const payload = await this.post('api/auth/login', 'sign-in', { email: email.trim(), password }, null);

		const sessionToken = firstString(payload, ['access_token', 'accessToken', 'token']);
		if (!sessionToken) {
			throw new FleetClientError('malformed', 'Sign-in response did not contain a session token');
		}
		// Protect BEFORE anything else can touch it.
		this.logger?.protect(sessionToken);

		const user = readObject(payload, 'user');
		return {
			sessionToken,
			userId: user ? firstString(user, ['id']) : null,
			email: user ? firstString(user, ['email']) : null
		};
	}

	/**
	 * Mint a one-time enrollment token for this machine using a session token.
	 *
	 * Mirrors what the Fleet settings page's "Add node" button does; the
	 * returned token has the same 15-minute, single-use semantics.
	 */
	async createEnrollmentToken(sessionToken: string, request: { name: string; kind: FleetNodeKind }): Promise<string> {
		const name = request.name.trim();
		if (!name) {
			throw new FleetClientError('invalid-request', 'A node name is required to mint an enrollment token');
		}
		this.logger?.protect(sessionToken);

		const payload = await this.post(
			'api/fleet/nodes/enrollment-token',
			'enrollment-token',
			{ name, kind: request.kind },
			sessionToken
		);

		const token = firstString(payload, ['token', 'enrollmentToken']);
		if (!token) {
			throw new FleetClientError('malformed', 'Enrollment-token response did not contain a token');
		}
		this.logger?.protect(token);
		return token;
	}

	/**
	 * Sign in with Ever ID using a code instead of a password (APW-12 FR-39 to
	 * FR-42) and return the same session {@link signIn} returns.
	 *
	 * Polls no faster than Ever ID asks and never faster than every 5 seconds,
	 * adds 5 seconds on every `slow_down`, and gives up when the code expires
	 * (at most 900 seconds). A node never creates an account: an Ever ID that
	 * is not connected to one ends with S23.
	 */
	async signInWithEverId(options: SignInWithEverIdOptions): Promise<SignInResult> {
		// The Ever ID access token is sent to this host as a bearer.
		const apiBase = new URL(this.apiUrl);
		if (!isSecureUrl(apiBase)) {
			throw new FleetClientError('invalid-request', EVER_ID_SIGN_IN_MESSAGES.insecureApiUrl(apiBase.host));
		}

		const { issuer, clientId } = await this.readEverIdClientConfig();
		const endpoints = await this.discoverEverId(issuer);
		const grant = await this.requestEverIdDeviceGrant(endpoints.deviceAuthorization, clientId);
		this.logger?.protect(grant.deviceCode);
		try {
			await options.onPrompt({
				verificationUri: grant.verificationUri,
				userCode: grant.userCode,
				expiresInSeconds: grant.expiresInSeconds
			});
			return await this.obtainEverIdSession(endpoints.token, clientId, grant);
		} finally {
			// Single-use: the code is spent whichever way the sign-in ended.
			this.logger?.unprotect(grant.deviceCode);
		}
	}

	private async readEverIdClientConfig(): Promise<{ issuer: URL; clientId: string }> {
		const url = joinUrl(this.apiUrl, 'api/auth/ever-id/client-config');
		const reply = await this.everIdRequest(url, { method: 'GET', timeoutMs: this.timeoutMs });
		if (reply.failure !== undefined) {
			throw this.unreachable(url, reply.failure);
		}
		if (!reply.ok) {
			throw everIdApiError(reply);
		}

		const config = asRecord(reply.body);
		const issuer = parseHttpUrl(firstString(config, ['issuer']));
		const localClients = config?.localClients;
		const clientId = (Array.isArray(localClients) ? localClients : [])
			.map(asRecord)
			.filter((client) => client?.kind === EVER_ID_CLIENT_KIND)
			.map((client) => firstString(client, ['clientId']))
			.find((id): id is string => id !== null);
		// Without an issuer or a client for nodes there is nothing to sign in with.
		if (!issuer || !clientId) {
			throw new FleetClientError('invalid-request', EVER_ID_SIGN_IN_MESSAGES.unavailable);
		}
		assertSecureProviderUrl(issuer);
		return { issuer, clientId };
	}

	private async discoverEverId(issuer: URL): Promise<{ deviceAuthorization: string; token: string }> {
		const url = `${issuer.origin}${issuer.pathname.replace(/\/+$/, '')}/.well-known/openid-configuration`;
		const reply = await this.everIdRequest(url, { method: 'GET', timeoutMs: this.providerTimeoutMs() });
		const document = asRecord(reply.body);
		if (reply.failure !== undefined || !reply.ok || !document) {
			throw new FleetClientError(
				'network',
				EVER_ID_SIGN_IN_MESSAGES.providerUnavailable,
				reply.status || undefined
			);
		}

		const deviceAuthorization = parseHttpUrl(firstString(document, ['device_authorization_endpoint']));
		const token = parseHttpUrl(firstString(document, ['token_endpoint']));
		// A provider that does not offer device authorization cannot run this sign-in.
		if (!deviceAuthorization) {
			throw new FleetClientError('invalid-request', EVER_ID_SIGN_IN_MESSAGES.unavailable);
		}
		if (!token) {
			throw new FleetClientError('malformed', EVER_ID_SIGN_IN_MESSAGES.providerUnavailable);
		}
		assertSecureProviderUrl(deviceAuthorization);
		assertSecureProviderUrl(token);
		return { deviceAuthorization: deviceAuthorization.toString(), token: token.toString() };
	}

	private async requestEverIdDeviceGrant(endpoint: string, clientId: string): Promise<EverIdDeviceGrant> {
		const reply = await this.everIdRequest(endpoint, {
			method: 'POST',
			form: { client_id: clientId, scope: EVER_ID_DEVICE_SCOPE },
			timeoutMs: this.providerTimeoutMs()
		});
		if (reply.failure !== undefined || reply.status >= 500) {
			throw new FleetClientError(
				'network',
				EVER_ID_SIGN_IN_MESSAGES.providerUnavailable,
				reply.status || undefined
			);
		}
		if (reply.status === 429) {
			throw new FleetClientError('rate-limited', EVER_ID_SIGN_IN_MESSAGES.rateLimited, 429);
		}
		if (!reply.ok) {
			throw new FleetClientError(
				'invalid-request',
				EVER_ID_SIGN_IN_MESSAGES.providerRejected(
					sanitize(firstString(reply.body, ['error']) ?? `HTTP ${reply.status}`)
				),
				reply.status
			);
		}

		const body = asRecord(reply.body);
		const deviceCode = firstString(body, ['device_code']);
		const userCode = sanitize(firstString(body, ['user_code']) ?? '');
		// Only the plain verification address: `verification_uri_complete` would put
		// the user code in an address (FR-42).
		const verificationUri = parseHttpUrl(firstString(body, ['verification_uri']));
		if (!deviceCode || !userCode || !verificationUri) {
			throw new FleetClientError('malformed', EVER_ID_SIGN_IN_MESSAGES.providerUnavailable);
		}
		assertSecureProviderUrl(verificationUri);

		const expiresIn = positiveNumber(body?.expires_in);
		const interval = positiveNumber(body?.interval);
		return {
			deviceCode,
			userCode,
			verificationUri: verificationUri.href,
			// FR-41: never wait past 900 seconds, whatever the provider answers.
			expiresInSeconds: Math.min(
				expiresIn ?? EVER_ID_LIMITS.deviceCodeMaxLifetimeSeconds,
				EVER_ID_LIMITS.deviceCodeMaxLifetimeSeconds
			),
			// FR-41: never poll faster than the provider asks, and never faster than every 5 s.
			intervalSeconds: Math.max(
				interval ?? EVER_ID_LIMITS.devicePollMinIntervalSeconds,
				EVER_ID_LIMITS.devicePollMinIntervalSeconds
			)
		};
	}

	/**
	 * Polls for Ever ID's access token and trades it for a session. The access
	 * token never leaves this frame and is forgotten by the logger once spent.
	 */
	private async obtainEverIdSession(
		tokenEndpoint: string,
		clientId: string,
		grant: EverIdDeviceGrant
	): Promise<SignInResult> {
		const accessToken = await this.pollEverIdToken(tokenEndpoint, clientId, grant);
		try {
			return await this.exchangeEverIdToken(accessToken);
		} finally {
			this.logger?.unprotect(accessToken);
		}
	}

	/** RFC 8628 §3.4–3.5 with the FR-41 bounds. */
	private async pollEverIdToken(tokenEndpoint: string, clientId: string, grant: EverIdDeviceGrant): Promise<string> {
		const deadline = this.now() + grant.expiresInSeconds * 1000;
		const slowDownStepMs = EVER_ID_LIMITS.devicePollSlowDownStepSeconds * 1000;
		let intervalMs = grant.intervalSeconds * 1000;
		let consecutiveFailures = 0;

		for (;;) {
			await this.sleep(intervalMs);
			if (this.now() >= deadline) {
				throw new FleetClientError('unauthorized', EVER_ID_SIGN_IN_MESSAGES.expired);
			}

			const reply = await this.everIdRequest(tokenEndpoint, {
				method: 'POST',
				form: { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: grant.deviceCode, client_id: clientId },
				timeoutMs: this.providerTimeoutMs()
			});

			if (reply.failure !== undefined || reply.status >= 500) {
				// A connection failure halves the polling rate before the next try (§3.5).
				consecutiveFailures += 1;
				if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
					throw new FleetClientError('network', EVER_ID_SIGN_IN_MESSAGES.providerUnavailable);
				}
				intervalMs *= 2;
				continue;
			}
			consecutiveFailures = 0;

			if (reply.ok) {
				const accessToken = firstString(reply.body, ['access_token']);
				if (!accessToken) {
					throw new FleetClientError('malformed', EVER_ID_SIGN_IN_MESSAGES.providerUnavailable);
				}
				// Protect BEFORE anything else can touch it.
				this.logger?.protect(accessToken);
				return accessToken;
			}
			if (reply.status === 429) {
				intervalMs += slowDownStepMs;
				continue;
			}

			const error = firstString(reply.body, ['error']);
			switch (error) {
				case 'authorization_pending':
					continue;
				case 'slow_down':
					// "MUST be increased by 5 seconds for this and all subsequent requests."
					intervalMs += slowDownStepMs;
					continue;
				case 'expired_token':
					throw new FleetClientError('unauthorized', EVER_ID_SIGN_IN_MESSAGES.expired, reply.status);
				case 'access_denied':
					throw new FleetClientError('forbidden', EVER_ID_SIGN_IN_MESSAGES.declined, reply.status);
				default:
					throw new FleetClientError(
						'invalid-request',
						EVER_ID_SIGN_IN_MESSAGES.providerRejected(sanitize(error ?? `HTTP ${reply.status}`)),
						reply.status
					);
			}
		}
	}

	private async exchangeEverIdToken(accessToken: string): Promise<SignInResult> {
		const url = joinUrl(this.apiUrl, 'api/auth/ever-id/session');
		const reply = await this.everIdRequest(url, { method: 'POST', bearer: accessToken, timeoutMs: this.timeoutMs });
		if (reply.failure !== undefined) {
			throw this.unreachable(url, reply.failure);
		}
		if (!reply.ok) {
			throw everIdApiError(reply);
		}

		const sessionToken = firstString(reply.body, ['access_token']);
		if (!sessionToken) {
			throw new FleetClientError('malformed', 'Sign-in response did not contain a session token');
		}
		// Protect BEFORE anything else can touch it.
		this.logger?.protect(sessionToken);

		const user = readObject(reply.body, 'user');
		return {
			sessionToken,
			userId: user ? firstString(user, ['id']) : null,
			email: user ? firstString(user, ['email']) : null
		};
	}

	/**
	 * One request of the Ever ID sign-in, to the API or to Ever ID. Never throws:
	 * an HTTP refusal comes back as a reply, and a server that could not be
	 * reached or read comes back with status 0 and the reason in `failure`.
	 */
	private async everIdRequest(
		url: string,
		request: { method: 'GET' | 'POST'; form?: Record<string, string>; bearer?: string; timeoutMs: number }
	): Promise<EverIdReply> {
		const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': this.userAgent };
		// `FetchLike` always carries a body. A GET's stays empty and the adapter
		// sends none (see `systemFetch`).
		let body = '';
		if (request.form) {
			headers['Content-Type'] = 'application/x-www-form-urlencoded';
			body = new URLSearchParams(request.form).toString();
		} else if (request.method === 'POST') {
			headers['Content-Type'] = 'application/json';
			body = '{}';
		}
		if (request.bearer) {
			headers.Authorization = `Bearer ${request.bearer}`;
		}
		const init: FetchRequestInit = { method: request.method, headers, body };
		if (request.timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
			init.signal = AbortSignal.timeout(request.timeoutMs);
		}

		try {
			const response = await this.fetchFn(url, init);
			const raw = await response.text();
			return { ok: response.ok, status: response.status, body: parseJson(raw) };
		} catch (error) {
			return {
				ok: false,
				status: 0,
				body: undefined,
				failure: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/** Ever ID gets the platform's outbound budget (FR-15); after it, S16 applies. */
	private providerTimeoutMs(): number {
		return this.timeoutMs > 0 ? Math.min(this.timeoutMs, EVER_ID_LIMITS.outboundTimeoutMs) : 0;
	}

	private unreachable(url: string, detail: string): FleetClientError {
		return new FleetClientError('network', `Could not reach ${url}: ${this.logger?.redact(detail) ?? detail}`);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			if (this.scheduler) {
				this.scheduler.setTimeout(resolve, ms);
			} else {
				setTimeout(resolve, ms);
			}
		});
	}

	private async post(
		path: string,
		operation: string,
		body: Record<string, unknown>,
		bearer: string | null
	): Promise<unknown> {
		const url = joinUrl(this.apiUrl, path);
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			'User-Agent': this.userAgent
		};
		if (bearer) {
			headers.Authorization = `Bearer ${bearer}`;
		}
		const init: FetchRequestInit = { method: 'POST', headers, body: JSON.stringify(body) };
		if (this.timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
			init.signal = AbortSignal.timeout(this.timeoutMs);
		}

		let response;
		try {
			response = await this.fetchFn(url, init);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new FleetClientError('network', `Could not reach ${url}: ${this.logger?.redact(detail) ?? detail}`);
		}

		if (!response.ok) {
			throw authErrorForStatus(response.status, operation);
		}

		let raw: string;
		try {
			raw = await response.text();
		} catch {
			throw new FleetClientError('malformed', 'Could not read the API response body');
		}
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			throw new FleetClientError('malformed', 'API response was not valid JSON');
		}
	}
}

/**
 * Status → stable, client-authored message. Server bodies are never echoed:
 * a login endpoint's error text is exactly the kind of thing that leaks
 * whether an account exists.
 */
function authErrorForStatus(status: number, operation: string): FleetClientError {
	if (status === 401) {
		return new FleetClientError(
			'unauthorized',
			operation === 'sign-in'
				? 'Sign-in was rejected — check the email and password for this API host'
				: 'The session was rejected — sign in again',
			status
		);
	}
	if (status === 403) {
		return new FleetClientError(
			'forbidden',
			'The API refused the request (403) — this account may not be allowed to add fleet nodes',
			status
		);
	}
	if (status === 429) {
		return new FleetClientError('rate-limited', 'Too many attempts — wait a minute and try again', status);
	}
	if (status >= 400 && status < 500) {
		return new FleetClientError('invalid-request', `Request rejected by the API (HTTP ${status})`, status);
	}
	return new FleetClientError('server', `API error (HTTP ${status})`, status);
}

function readObject(payload: unknown, key: string): Record<string, unknown> | null {
	if (!payload || typeof payload !== 'object') {
		return null;
	}
	const value = (payload as Record<string, unknown>)[key];
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** First non-empty string among `keys`, searched in order. */
function firstString(payload: unknown, keys: readonly string[]): string | null {
	if (!payload || typeof payload !== 'object') {
		return null;
	}
	const record = payload as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value) {
			return value;
		}
	}
	return null;
}

/**
 * An Ever Works API refusal of the Ever ID sign-in, read by its wire code. The
 * body's `message` is never echoed, like every other server body here.
 */
function everIdApiError(reply: EverIdReply): FleetClientError {
	const { status } = reply;
	if (status === 429) {
		return new FleetClientError('rate-limited', EVER_ID_SIGN_IN_MESSAGES.rateLimited, status);
	}
	switch (everIdErrorCode(reply.body)) {
		case 'ever_id_disabled':
			return new FleetClientError('invalid-request', EVER_ID_SIGN_IN_MESSAGES.unavailable, status);
		case 'provider_unavailable':
			return new FleetClientError('server', EVER_ID_SIGN_IN_MESSAGES.providerUnavailable, status);
		case 'not_connected':
			return new FleetClientError('forbidden', EVER_ID_SIGN_IN_MESSAGES.notConnected, status);
		case 'account_disabled':
			return new FleetClientError('forbidden', EVER_ID_SIGN_IN_MESSAGES.accountSuspended, status);
		case 'transaction_invalid':
			return new FleetClientError('unauthorized', EVER_ID_SIGN_IN_MESSAGES.signInExpired, status);
		default:
			break;
	}
	if (status === 404) {
		return new FleetClientError('invalid-request', EVER_ID_SIGN_IN_MESSAGES.unavailable, status);
	}
	if (status === 503) {
		return new FleetClientError('server', EVER_ID_SIGN_IN_MESSAGES.providerUnavailable, status);
	}
	if (status >= 400 && status < 500) {
		return new FleetClientError('invalid-request', `Request rejected by the API (HTTP ${status})`, status);
	}
	return new FleetClientError('server', `API error (HTTP ${status})`, status);
}

/**
 * The wire code of an Ever ID error body. CONTRACTS §12 puts the snake_case
 * code on the wire; the camelCase member name maps onto the same code, since
 * both spellings are in use (`EVER_ID_ERROR_CODE_WIRE_VALUES`).
 */
function everIdErrorCode(body: unknown): EverIdWireErrorCode | null {
	const code = firstString(body, ['code']);
	if (!code) {
		return null;
	}
	if ((EVER_ID_WIRE_ERROR_CODES as readonly string[]).includes(code)) {
		return code as EverIdWireErrorCode;
	}
	return Object.prototype.hasOwnProperty.call(EVER_ID_ERROR_CODE_WIRE_VALUES, code)
		? EVER_ID_ERROR_CODE_WIRE_VALUES[code as EverIdErrorCode]
		: null;
}

/** FR-2: Ever ID is reached over HTTPS, or over HTTP on this machine only. */
function assertSecureProviderUrl(url: URL): void {
	if (!isSecureUrl(url)) {
		throw new FleetClientError('invalid-request', EVER_ID_SIGN_IN_MESSAGES.insecureProvider(url.host));
	}
}

function isSecureUrl(url: URL): boolean {
	return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
}

function isLoopbackHost(hostname: string): boolean {
	return (
		hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(hostname)
	);
}

/** An absolute http(s) URL, or `null`. */
function parseHttpUrl(value: string | null): URL | null {
	if (!value) {
		return null;
	}
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function positiveNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function parseJson(raw: string): unknown {
	if (!raw) {
		return undefined;
	}
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

/** Provider text is shown to a person: no control characters, bounded length. */
function sanitize(value: string): string {
	return (
		value
			// eslint-disable-next-line no-control-regex
			.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
			.trim()
			.slice(0, 200)
	);
}
