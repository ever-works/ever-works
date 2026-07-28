import { FleetClientError, joinUrl, normalizeApiUrl, type FetchLike, type FetchRequestInit } from './fleet-client';
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
}

export const DEFAULT_AUTH_TIMEOUT_MS = 20_000;

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

	constructor(options: PlatformAuthClientOptions) {
		this.apiUrl = normalizeApiUrl(options.apiUrl);
		this.fetchFn = options.fetchFn;
		this.logger = options.logger;
		this.userAgent = options.userAgent ?? 'ever-works-node';
		this.timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
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
