/**
 * APW-12 T8 — a **fake OpenID Connect provider**, published only through this
 * package's `./testing` subpath (plan §10.4).
 *
 * The API integration spec (`apps/api/src/auth/ever-id.flow.integration.spec.ts`,
 * T20/T25) and the Playwright lanes both need a provider that answers the way Ever
 * ID will: a discovery document, a key set, an authorization endpoint that
 * approves a configured person, a token endpoint that **checks PKCE**, device
 * authorization with FR-41's polling rules, an end-session endpoint, and helpers
 * that mint the access and logout tokens the verifiers are given. One fake, in one
 * place, because a second one would be a second set of provider behaviours to keep
 * in step.
 *
 * ## Why the subpath, and why that is load-bearing
 *
 * Plan §10.4: "published only through a `./testing` subpath export, never from the
 * main entry". The main entry (`src/index.ts`) is what the plugin loader imports in
 * production, and a fake provider that reached it would be dead weight in every
 * API process — and, worse, an HTTP server behind a class the platform already
 * instantiates. `package.json`'s `exports["./testing"]` and `tsup`'s second entry
 * are what make that separation real; `src/__tests__/fake-oidc-provider.spec.ts`
 * asserts it from both the source side and (when a build exists) the built side.
 *
 * ## What it is not
 *
 * It is not a security reference. It signs with ES256 keys it generates
 * (`node:crypto`, plan §10.4 — not `jose`, so a bug in the library under test
 * cannot hide a bug in the fake), it keeps device grants and authorization codes
 * in memory, and it makes no attempt to be a *correct* provider in the corners the
 * epic does not read. Where it deliberately *is* strict — PKCE S256, single-use
 * codes, `client_secret_basic`, FR-41's poll interval — the strictness is the
 * point: those are the behaviours the relying party has to get right, and a fake
 * that accepted anything would prove nothing about them.
 *
 * ## Time
 *
 * Every clock read goes through the injected `now` (epoch **milliseconds**,
 * defaulting to `Date.now`), and every minted claim is stamped from it. A spec
 * therefore drives token lifetimes, the device-poll interval and `iat`/`exp` with
 * literal values and an injected clock rather than by sleeping — the rule this
 * package learned the hard way in T6.
 */

import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/**
 * The `events` member of a back-channel logout notice — OpenID Connect
 * Back-Channel Logout 1.0 §2.4's event identifier.
 *
 * Spelled here rather than imported from the plugin on purpose: this module stands
 * in for an **external** provider, and a provider does not read the relying
 * party's constants. `fake-oidc-provider.spec.ts` asserts that this literal and
 * `OIDC_BACKCHANNEL_LOGOUT_EVENT` are the same string, so the two cannot drift
 * without a red test.
 */
export const FAKE_BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/** The public client an exchange token names by default. */
export const FAKE_DEFAULT_LOCAL_CLIENT_ID = 'ever-works-cli';

/** The person the provider approves when a spec configures nobody (§10.4). */
export const FAKE_DEFAULT_USER = {
	subject: 'ever-id-subject-1',
	email: 'person@example.com',
	emailVerified: true,
	name: 'A Person'
} as const;

/** The document fields a spec may ask the fake to leave out (FR-3's rows, FR-36's `null`). */
export type FakeOidcOmittableField =
	| 'authorization_endpoint'
	| 'token_endpoint'
	| 'jwks_uri'
	| 'end_session_endpoint'
	| 'device_authorization_endpoint'
	| 'code_challenge_methods_supported'
	| 'backchannel_logout_supported';

/** The person this provider signs in. */
export interface FakeOidcUser {
	readonly subject: string;
	readonly email: string;
	readonly emailVerified?: boolean;
	readonly name?: string;
}

/** Construction options for {@link FakeOidcProvider.start}. */
export interface FakeOidcProviderOptions {
	/** The person auto-approved at `/authorize` and at device authorization. */
	readonly user?: FakeOidcUser;
	/** The relying party's client id. Default `ever-works-web`. */
	readonly clientId?: string;
	/**
	 * The `client_secret_basic` secret the token endpoint requires, or `null` to
	 * accept any (a spec that is not exercising client authentication).
	 */
	readonly clientSecret?: string | null;
	/** The audience a minted access token carries. Default `ever-works`. */
	readonly apiAudience?: string;
	/** The public clients an exchange token may name in `azp`. */
	readonly localClients?: readonly { readonly kind: 'cli' | 'node'; readonly clientId: string }[];
	/** FR-44's scope a delegated access token carries. Default `apps:read`. */
	readonly delegatedScope?: string;
	/** FR-39/FR-40's scope an exchange access token carries. Default `ever-works:session`. */
	readonly exchangeScope?: string;
	/** How long a minted access token lives when the caller does not say. Default 300. */
	readonly accessTokenLifetimeSeconds?: number;
	/** FR-41's poll interval the device endpoint returns, in seconds. Default 5. */
	readonly devicePollIntervalSeconds?: number;
	/** How long a device code lives. Default 900 (FR-41). */
	readonly deviceCodeLifetimeSeconds?: number;
	/** How long an authorization code lives. Default 60. */
	readonly authorizationCodeLifetimeSeconds?: number;
	/** Document fields to leave out, so a spec can drive the rows and the `null` answers. */
	readonly omit?: readonly FakeOidcOmittableField[];
	/** The clock, in epoch milliseconds. Defaults to `Date.now`. */
	readonly now?: () => number;
}

/** One request the provider received, so a spec can assert on what actually went out. */
export interface FakeOidcCall {
	readonly method: string;
	readonly path: string;
	/** The query string, as a plain object (a repeated key keeps its first value). */
	readonly query: Record<string, string>;
	/** The `application/x-www-form-urlencoded` body, as a plain object. */
	readonly form: Record<string, string>;
	/** The request headers, lower-cased. */
	readonly headers: Record<string, string>;
}

/** What a device-code poll answered. */
export interface FakeDevicePoll {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

/** What {@link FakeOidcProvider.start} resolves to. */
export type FakeOidcProviderStarted = FakeOidcProvider;

/** One signing key the provider publishes. */
interface FakeSigningKey {
	readonly kid: string;
	readonly jwk: Record<string, unknown>;
	readonly privateKey: KeyObject;
}

/** An approved-or-pending device grant (RFC 8628 §3.2's state machine, as far as FR-41 reads it). */
interface FakeDeviceGrant {
	readonly deviceCode: string;
	readonly userCode: string;
	readonly clientId: string;
	readonly scope: string;
	readonly expiresAtSeconds: number;
	readonly intervalSeconds: number;
	approved: boolean;
	lastPolledAtSeconds: number | null;
}

/** An issued authorization code, with everything the token endpoint has to check. */
interface FakeAuthorizationCode {
	readonly code: string;
	readonly clientId: string;
	readonly redirectUri: string;
	readonly codeChallenge: string;
	readonly nonce: string | null;
	readonly scope: string;
	readonly expiresAtSeconds: number;
}

/**
 * A local OpenID Connect provider, for specs.
 *
 * `start()` binds an ephemeral port on the loopback interface and answers on
 * `http://localhost:<port>` — the one non-TLS issuer `settings.schema.ts` accepts
 * and the one the plugin's configuration tells `openid-client` about
 * (`isInsecureIssuer`). The issuer therefore depends on the port and is only known
 * after the server is listening, which is why construction goes through `start()`.
 */
export class FakeOidcProvider {
	/** Every request, in order — method, path, query, form and headers. */
	readonly calls: FakeOidcCall[] = [];

	private readonly options: FakeOidcProviderOptions;
	private readonly keys: FakeSigningKey[] = [];
	private readonly codes = new Map<string, FakeAuthorizationCode>();
	private readonly devices = new Map<string, FakeDeviceGrant>();
	private server: Server | null = null;
	private issuerUrl = '';
	private keySequence = 0;

	private constructor(options: FakeOidcProviderOptions) {
		this.options = options;
	}

	/** Bind a port and answer the discovery document a relying party will read. */
	static async start(options: FakeOidcProviderOptions = {}): Promise<FakeOidcProvider> {
		const provider = new FakeOidcProvider(options);
		provider.rotateKeysSync({ keepPrevious: false });
		await provider.listen();
		return provider;
	}

	/**
	 * Bind an ephemeral loopback port and answer `/…/.well-known/openid-configuration`.
	 *
	 * Kept additive and public so a caller that wants a provider on a **fixed** port
	 * (a Playwright lane that must tell the API where to find it before the process
	 * starts) can build one; `start()` is the ordinary entry point.
	 */
	async listen(port = 0): Promise<void> {
		if (this.server !== null) throw new Error('FakeOidcProvider is already listening.');
		const server = createServer((request, response) => {
			void this.handle(request, response);
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => {
				server.removeListener('error', reject);
				resolve();
			});
		});
		this.server = server;
		const address = server.address();
		// `localhost` rather than `127.0.0.1`: the settings schema accepts both, and
		// `localhost` is the spelling a developer's own ZITADEL runs on.
		this.issuerUrl = `http://localhost:${typeof address === 'object' && address !== null ? address.port : port}`;
	}

	/** The issuer the discovery document advertises, and the settings' `issuerUrl`. */
	get issuer(): string {
		return this.issuerUrl;
	}

	/** The bound port. */
	get port(): number {
		const address = this.server?.address();
		return typeof address === 'object' && address !== null ? address.port : 0;
	}

	get discoveryUrl(): string {
		return `${this.issuer}/.well-known/openid-configuration`;
	}

	get jwksUri(): string {
		return `${this.issuer}/jwks`;
	}

	get authorizationEndpoint(): string {
		return `${this.issuer}/authorize`;
	}

	get tokenEndpoint(): string {
		return `${this.issuer}/token`;
	}

	get endSessionEndpoint(): string {
		return `${this.issuer}/end_session`;
	}

	get deviceAuthorizationEndpoint(): string {
		return `${this.issuer}/device_authorization`;
	}

	/** The relying party's client id the token endpoint expects. */
	get clientId(): string {
		return this.options.clientId ?? 'ever-works-web';
	}

	/** The `client_secret_basic` secret the token endpoint expects, or `null` for "any". */
	get clientSecret(): string | null {
		return this.options.clientSecret === undefined ? 'fake-client-secret' : this.options.clientSecret;
	}

	/** The API audience a minted access token carries. */
	get apiAudience(): string {
		return this.options.apiAudience ?? 'ever-works';
	}

	/** The `azp` a minted access token carries when the caller does not say. */
	get defaultAuthorizedParty(): string {
		return this.options.localClients?.[0]?.clientId ?? FAKE_DEFAULT_LOCAL_CLIENT_ID;
	}

	/** The document this provider publishes, with the fields `omit` removed. */
	discoveryDocument(): Record<string, unknown> {
		const document: Record<string, unknown> = {
			issuer: this.issuer,
			authorization_endpoint: this.authorizationEndpoint,
			token_endpoint: this.tokenEndpoint,
			jwks_uri: this.jwksUri,
			end_session_endpoint: this.endSessionEndpoint,
			device_authorization_endpoint: this.deviceAuthorizationEndpoint,
			userinfo_endpoint: `${this.issuer}/userinfo`,
			code_challenge_methods_supported: ['S256'],
			id_token_signing_alg_values_supported: ['ES256'],
			backchannel_logout_supported: true,
			backchannel_logout_session_supported: true,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'],
			subject_types_supported: ['public'],
			scopes_supported: ['openid', 'email', 'profile', this.delegatedScope, this.exchangeScope]
		};
		for (const field of this.options.omit ?? []) delete document[field];
		return document;
	}

	/** FR-44's delegated scope this provider mints. */
	get delegatedScope(): string {
		return this.options.delegatedScope ?? 'apps:read';
	}

	/** FR-39/FR-40's exchange scope this provider mints. */
	get exchangeScope(): string {
		return this.options.exchangeScope ?? 'ever-works:session';
	}

	/** The current clock, in epoch milliseconds. */
	now(): number {
		return (this.options.now ?? Date.now)();
	}

	/** The current clock, in whole seconds — the unit every JWT time claim uses. */
	nowSeconds(): number {
		return Math.floor(this.now() / 1_000);
	}

	/**
	 * Replace the signing key, the way a provider rotates one (FR-13, ACC-12-08).
	 *
	 * `keepPrevious` publishes the old key alongside the new one, which is what a
	 * rollover looks like while tokens signed with it are still in flight; the
	 * default is the harder case, where the old key is **gone** and a token signed
	 * with it must stop validating.
	 */
	async rotateKeys(options: { keepPrevious?: boolean } = {}): Promise<void> {
		this.rotateKeysSync(options);
	}

	/** The current key id, so a spec can name what it is signing with. */
	get currentKeyId(): string {
		return this.keys[this.keys.length - 1]?.kid ?? '';
	}

	/**
	 * Sign an ID token for the configured person — what the token endpoint answers
	 * with, and what a spec can use to drive `exchangeAuthorizationCode` directly.
	 */
	async mintIdToken(overrides: Record<string, unknown> = {}): Promise<string> {
		const user = this.user();
		const issuedAt = this.nowSeconds();
		return this.sign({
			iss: this.issuer,
			sub: user.subject,
			aud: this.clientId,
			exp: issuedAt + 300,
			iat: issuedAt,
			email: user.email,
			email_verified: user.emailVerified ?? true,
			name: user.name ?? 'A Person',
			auth_time: issuedAt,
			sid: 'ever-id-session-1',
			jti: randomId('id-token'),
			...overrides
		});
	}

	/**
	 * Sign an access token — the artifact FR-40's exchange and FR-45's delegated read
	 * are handed.
	 *
	 * The defaults are a **valid** token for the configured installation: `aud` is
	 * the API audience, `azp` is the first configured local client,
	 * `scope` is the exchange scope, `iat` is now and `exp` is now plus
	 * {@link FakeOidcProviderOptions.accessTokenLifetimeSeconds}. Every case in a
	 * spec is therefore "everything is valid, except this", and the literal numbers
	 * a case wants are passed in rather than derived from the plugin.
	 */
	async mintAccessToken(
		overrides: {
			readonly scopes?: readonly string[];
			readonly authorizedParty?: string | null;
			readonly audience?: string | readonly string[];
			readonly subject?: string;
			readonly issuedAt?: number;
			readonly expiresAt?: number;
			readonly jti?: string | null;
			readonly claims?: Record<string, unknown>;
		} = {}
	): Promise<string> {
		const issuedAt = overrides.issuedAt ?? this.nowSeconds();
		const claims: Record<string, unknown> = {
			iss: this.issuer,
			sub: overrides.subject ?? this.user().subject,
			aud: overrides.audience ?? this.apiAudience,
			scope: (overrides.scopes ?? [this.exchangeScope]).join(' '),
			iat: issuedAt,
			exp: overrides.expiresAt ?? issuedAt + (this.options.accessTokenLifetimeSeconds ?? 300),
			jti: overrides.jti === undefined ? randomId('jti') : overrides.jti,
			...overrides.claims
		};
		if (overrides.authorizedParty !== null) {
			claims.azp = overrides.authorizedParty ?? this.defaultAuthorizedParty;
		}
		return this.sign(claims);
	}

	/**
	 * Sign a back-channel logout notice (FR-33).
	 *
	 * The default is a **valid** notice about the configured person's session:
	 * the event member, an `iat` of now, a fresh `jti`, `sid` and no `nonce`, `exp`
	 * or `sub`. `extraClaims` is how a spec adds the claims FR-33 forbids (or
	 * removes the ones it requires), so every case reads as one deliberate change.
	 */
	async mintLogoutToken(
		overrides: {
			readonly subject?: string | null;
			readonly sid?: string | null;
			readonly jti?: string | null;
			readonly issuedAt?: number;
			readonly expiresAt?: number | null;
			readonly events?: Record<string, unknown> | null;
			readonly extraClaims?: Record<string, unknown>;
		} = {}
	): Promise<string> {
		const issuedAt = overrides.issuedAt ?? this.nowSeconds();
		const claims: Record<string, unknown> = {
			iss: this.issuer,
			aud: this.clientId,
			iat: issuedAt,
			jti: overrides.jti === undefined ? randomId('logout') : overrides.jti,
			events: overrides.events === undefined ? { [FAKE_BACKCHANNEL_LOGOUT_EVENT]: {} } : overrides.events,
			sid: overrides.sid === undefined ? 'ever-id-session-1' : overrides.sid,
			...overrides.extraClaims
		};
		if (overrides.subject !== undefined && overrides.subject !== null) claims.sub = overrides.subject;
		if (overrides.expiresAt !== undefined && overrides.expiresAt !== null) claims.exp = overrides.expiresAt;
		return this.sign(claims);
	}

	/**
	 * Post a signed notice to a relying party's back-channel endpoint, the way the
	 * provider does (FR-33's "one public endpoint", form-encoded).
	 *
	 * Answers the status and the body text rather than throwing, so a spec can assert
	 * FR-34's "an invalid notice answers 400" — and FR-34's "200 with
	 * `Cache-Control: no-store`" — on a real HTTP exchange. A token is minted first
	 * when the caller does not pass one.
	 */
	async postBackchannelLogout(
		url: string,
		token?: string,
		overrides: Parameters<FakeOidcProvider['mintLogoutToken']>[0] = {}
	): Promise<{ readonly status: number; readonly body: string; readonly cacheControl: string | null }> {
		const logoutToken = token ?? (await this.mintLogoutToken(overrides));
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ logout_token: logoutToken }).toString()
		});
		return {
			status: response.status,
			body: await response.text(),
			cacheControl: response.headers.get('cache-control')
		};
	}

	/**
	 * Approve a pending device grant — what the person does in the browser at
	 * `verification_uri` (FR-39).
	 *
	 * With no argument every pending grant is approved, which is what a spec that has
	 * just asked for one wants; the `userCode` form is there for the case that reads
	 * the code off the wire.
	 */
	approveDeviceAuthorization(userCode?: string): number {
		let approved = 0;
		for (const grant of this.devices.values()) {
			if (userCode !== undefined && grant.userCode !== userCode) continue;
			grant.approved = true;
			approved += 1;
		}
		return approved;
	}

	/** Every device grant this provider has issued, approved or not. */
	get deviceGrants(): readonly {
		readonly userCode: string;
		readonly deviceCode: string;
		readonly approved: boolean;
	}[] {
		return [...this.devices.values()].map((grant) => ({
			userCode: grant.userCode,
			deviceCode: grant.deviceCode,
			approved: grant.approved
		}));
	}

	/** The last authorization request's query, or `null` when none has been made. */
	lastAuthorizationRequest(): Record<string, string> | null {
		for (let index = this.calls.length - 1; index >= 0; index -= 1) {
			const call = this.calls[index];
			if (call.path === '/authorize') return call.query;
		}
		return null;
	}

	/** Stop listening. Safe to call twice, and safe to call after a failed start. */
	async stop(): Promise<void> {
		const server = this.server;
		if (server === null) return;
		this.server = null;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			// Keep-alive sockets would otherwise hold `close()` open; destroying them
			// is what keeps a spec's teardown from outliving its cases.
			server.closeAllConnections();
		});
	}

	// ---------------------------------------------------------------- internals

	private user(): FakeOidcUser {
		return this.options.user ?? FAKE_DEFAULT_USER;
	}

	private rotateKeysSync(options: { keepPrevious?: boolean }): void {
		this.keySequence += 1;
		const key = makeSigningKey(`fake-key-${this.keySequence}`);
		if (options.keepPrevious !== true) this.keys.length = 0;
		this.keys.push(key);
	}

	private currentKey(): FakeSigningKey {
		const key = this.keys[this.keys.length - 1];
		if (key === undefined) throw new Error('FakeOidcProvider has no signing key.');
		return key;
	}

	private sign(payload: Record<string, unknown>): string {
		return signCompactJws(this.currentKey(), payload);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? '/', this.issuer || 'http://localhost');
		const form = await readForm(request);
		const call: FakeOidcCall = {
			method: request.method ?? 'GET',
			path: url.pathname,
			query: Object.fromEntries(url.searchParams.entries()),
			form,
			headers: Object.fromEntries(
				Object.entries(request.headers).flatMap(([name, value]) =>
					value === undefined ? [] : [[name.toLowerCase(), Array.isArray(value) ? value.join(', ') : value]]
				)
			)
		};
		this.calls.push(call);

		try {
			switch (url.pathname) {
				case '/.well-known/openid-configuration':
					return sendJson(response, 200, this.discoveryDocument());
				case '/jwks':
					return sendJson(response, 200, { keys: this.keys.map((key) => key.jwk) });
				case '/authorize':
					return this.handleAuthorize(call, response);
				case '/token':
					return this.handleToken(call, response);
				case '/device_authorization':
					return this.handleDeviceAuthorization(call, response);
				case '/end_session':
					return this.handleEndSession(call, response);
				case '/userinfo':
					return sendJson(response, 200, { sub: this.user().subject, email: this.user().email });
				default:
					return sendJson(response, 404, { error: 'not_found' });
			}
		} catch (error) {
			// A fake that threw inside a request handler would hang the socket and look
			// like a slow provider rather than a bug in the spec.
			return sendJson(response, 500, { error: 'fake_provider_error', error_description: String(error) });
		}
	}

	/** §10.4's "authorize (auto-approve a configured user)", with S256 required. */
	private handleAuthorize(call: FakeOidcCall, response: ServerResponse): void {
		const { query } = call;
		if (query.response_type !== 'code') {
			return sendJson(response, 400, { error: 'unsupported_response_type' });
		}
		if (query.code_challenge_method !== 'S256' || (query.code_challenge ?? '') === '') {
			// FR-8/FR-3: this provider offers S256 and nothing else, so `plain` — and a
			// missing challenge — are refused here rather than at the token endpoint.
			return sendJson(response, 400, { error: 'invalid_request', error_description: 'PKCE S256 is required' });
		}
		if (query.client_id !== this.clientId) {
			return sendJson(response, 400, { error: 'invalid_request', error_description: 'unknown client' });
		}
		const redirectUri = query.redirect_uri ?? '';
		if (redirectUri === '') {
			return sendJson(response, 400, { error: 'invalid_request', error_description: 'redirect_uri is required' });
		}

		const code = randomId('code');
		this.codes.set(code, {
			code,
			clientId: query.client_id,
			redirectUri,
			codeChallenge: query.code_challenge ?? '',
			nonce: query.nonce ?? null,
			scope: query.scope ?? 'openid email profile',
			expiresAtSeconds: this.nowSeconds() + (this.options.authorizationCodeLifetimeSeconds ?? 60)
		});

		const target = new URL(redirectUri);
		target.searchParams.set('code', code);
		if (query.state !== undefined) target.searchParams.set('state', query.state);
		// RFC 9207's authorization-response `iss`: this provider always names itself,
		// which is the case FR-12 checks first and offline.
		target.searchParams.set('iss', this.issuer);
		response.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
		response.end();
	}

	/** RFC 6749 §4.1.3 and RFC 8628 §3.4–3.5: two grants, both checked. */
	private handleToken(call: FakeOidcCall, response: ServerResponse): void {
		const { form } = call;
		if (this.clientSecret !== null && !this.credentialsAccepted(call)) {
			return sendJson(response, 401, { error: 'invalid_client' });
		}

		if (form.grant_type === 'authorization_code') return this.handleAuthorizationCodeGrant(form, response);
		if (form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
			return this.handleDeviceCodeGrant(form, response);
		}
		return sendJson(response, 400, { error: 'unsupported_grant_type' });
	}

	private handleAuthorizationCodeGrant(form: Record<string, string>, response: ServerResponse): void {
		const stored = this.codes.get(form.code ?? '');
		if (stored === undefined) {
			return sendJson(response, 400, { error: 'invalid_grant', error_description: 'unknown code' });
		}
		// Single use: FR-19's "a sign-in transaction completes at most once" seen from
		// the provider's side, which is why the code is removed before it is judged.
		this.codes.delete(stored.code);
		if (stored.expiresAtSeconds < this.nowSeconds()) {
			return sendJson(response, 400, { error: 'invalid_grant', error_description: 'expired code' });
		}
		if (form.redirect_uri !== stored.redirectUri) {
			return sendJson(response, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
		}
		// The check this endpoint exists for: the verifier must hash to the challenge
		// the authorization request sent.
		if (s256(form.code_verifier ?? '') !== stored.codeChallenge) {
			return sendJson(response, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
		}

		void this.tokensFor(stored.nonce, stored.scope).then(
			(tokens) => sendJson(response, 200, tokens),
			(error: unknown) => sendJson(response, 500, { error: 'server_error', error_description: String(error) })
		);
	}

	private handleDeviceCodeGrant(form: Record<string, string>, response: ServerResponse): void {
		const grant = this.devices.get(form.device_code ?? '');
		if (grant === undefined) {
			return sendJson(response, 400, { error: 'invalid_grant', error_description: 'unknown device code' });
		}
		const nowSeconds = this.nowSeconds();
		if (grant.expiresAtSeconds < nowSeconds) {
			this.devices.delete(grant.deviceCode);
			return sendJson(response, 400, { error: 'expired_token' });
		}
		// FR-41: "clients poll no faster than the interval Ever ID returns (at least 5
		// seconds), add 5 seconds on every `slow_down`". The provider is the only side
		// that can see the interval, so it is enforced here.
		if (grant.lastPolledAtSeconds !== null && nowSeconds - grant.lastPolledAtSeconds < grant.intervalSeconds) {
			grant.lastPolledAtSeconds = nowSeconds;
			return sendJson(response, 400, { error: 'slow_down' });
		}
		grant.lastPolledAtSeconds = nowSeconds;

		if (!grant.approved) return sendJson(response, 400, { error: 'authorization_pending' });

		this.devices.delete(grant.deviceCode);
		void this.tokensFor(null, grant.scope).then(
			(tokens) => sendJson(response, 200, tokens),
			(error: unknown) => sendJson(response, 500, { error: 'server_error', error_description: String(error) })
		);
	}

	/** RFC 8628 §3.2's device authorization response. */
	private handleDeviceAuthorization(call: FakeOidcCall, response: ServerResponse): void {
		if (this.clientSecret !== null && !this.credentialsAccepted(call)) {
			return sendJson(response, 401, { error: 'invalid_client' });
		}
		const intervalSeconds = this.options.devicePollIntervalSeconds ?? 5;
		const grant: FakeDeviceGrant = {
			deviceCode: randomId('device'),
			userCode: randomUserCode(),
			clientId: call.form.client_id ?? this.clientId,
			scope: call.form.scope ?? 'openid email profile',
			expiresAtSeconds: this.nowSeconds() + (this.options.deviceCodeLifetimeSeconds ?? 900),
			intervalSeconds,
			approved: false,
			lastPolledAtSeconds: null
		};
		this.devices.set(grant.deviceCode, grant);
		return sendJson(response, 200, {
			device_code: grant.deviceCode,
			user_code: grant.userCode,
			verification_uri: `${this.issuer}/device`,
			verification_uri_complete: `${this.issuer}/device?user_code=${grant.userCode}`,
			expires_in: this.options.deviceCodeLifetimeSeconds ?? 900,
			interval: intervalSeconds
		});
	}

	/** RP-Initiated Logout 1.0 §2: back to the relying party, with `state` preserved. */
	private handleEndSession(call: FakeOidcCall, response: ServerResponse): void {
		const redirectUri = call.query.post_logout_redirect_uri;
		if (redirectUri === undefined || redirectUri === '') {
			// FR-36's caller always sends one; a person landing here directly gets an
			// answer rather than an error, which is what a real provider does.
			return sendJson(response, 200, { signedOut: true });
		}
		const target = new URL(redirectUri);
		if (call.query.state !== undefined) target.searchParams.set('state', call.query.state);
		response.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
		response.end();
	}

	private async tokensFor(nonce: string | null, scope: string): Promise<Record<string, unknown>> {
		const user = this.user();
		const idToken = await this.mintIdToken({ nonce, sid: 'ever-id-session-1', sub: user.subject });
		const accessToken = await this.mintAccessToken({
			scopes: scope.split(/\s+/u).filter((entry) => entry.length > 0),
			authorizedParty: this.clientId
		});
		return {
			access_token: accessToken,
			id_token: idToken,
			token_type: 'Bearer',
			expires_in: this.options.accessTokenLifetimeSeconds ?? 300,
			scope
		};
	}

	/** `client_secret_basic` (RFC 6749 §2.3.1), which is what plan §4.2 registers. */
	private credentialsAccepted(call: FakeOidcCall): boolean {
		const header = call.headers.authorization;
		if (header === undefined || !header.toLowerCase().startsWith('basic ')) return false;
		const raw = header.slice('basic '.length);
		const decoded = Buffer.from(raw, 'base64').toString('utf8');
		const separator = decoded.indexOf(':');
		if (separator < 0) return false;
		const username = decoded.slice(0, separator);
		// The username is the *form*-encoded client id, per RFC 6749 §2.3.1; a spec
		// that needs the credential's exact spelling reads it from `calls`. Both the
		// encoded and the verbatim spelling are accepted, because the ecosystem
		// disagrees about the encoding and this fake exists to test the relying party
		// rather than to settle that argument (C31 measures which one we send).
		const decodedUsername = decodeURIComponent(username.replace(/\+/gu, ' '));
		const password = decodeURIComponent(decoded.slice(separator + 1).replace(/\+/gu, ' '));
		const usernameMatches = username === this.clientId || decodedUsername === this.clientId;
		return usernameMatches && password === (this.clientSecret ?? '');
	}
}

/** S256: `BASE64URL(SHA256(ASCII(code_verifier)))` (RFC 7636 §4.6). */
export function s256(codeVerifier: string): string {
	return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

/** A key pair the provider signs with — ES256 over P-256, generated by `node:crypto`. */
function makeSigningKey(kid: string): FakeSigningKey {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
	return { kid, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' }, privateKey };
}

/**
 * A compact JWS, signed with ES256 by `node:crypto` (plan §10.4).
 *
 * `createSign('SHA256')` over an EC key produces ECDSA-SHA256 in **DER**; JOSE
 * wants the fixed-width `R || S` concatenation (RFC 7518 §3.4), so
 * {@link derToJoseSignature} converts. Doing this by hand rather than with `jose`
 * is deliberate: the fake is the thing the real verifier is tested against, and a
 * fake that shared the library under test could hide a bug in it.
 */
function signCompactJws(key: FakeSigningKey, payload: Record<string, unknown>): string {
	const header = { alg: 'ES256', kid: key.kid, typ: 'JWT' };
	const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
	const signature = createSign('SHA256').update(signingInput).sign(key.privateKey);
	return `${signingInput}.${base64Url(derToJoseSignature(signature))}`;
}

/**
 * DER `SEQUENCE { INTEGER r, INTEGER s }` → the 64-byte `R || S` JOSE expects.
 *
 * Each integer is stripped of its DER sign byte and left-padded to the curve's
 * coordinate width (32 bytes for P-256). A signature that is not in the shape this
 * function expects throws rather than producing a token nothing can verify — a
 * fake that silently signed garbage would be much harder to debug.
 */
function derToJoseSignature(der: Buffer, partLength = 32): Buffer {
	if (der.length < 8 || der[0] !== 0x30) throw new Error('unexpected ECDSA signature encoding');
	let offset = 1;
	// Short form (`< 0x80`) is what a 70-byte P-256 signature uses; the long form is
	// handled so the function is not wrong for a larger curve.
	if (der[offset] !== undefined && (der[offset] & 0x80) !== 0) {
		offset += 1 + (der[offset] & 0x7f);
	} else {
		offset += 1;
	}
	const readInteger = (): Buffer => {
		if (der[offset] !== 0x02) throw new Error('unexpected ECDSA signature encoding');
		const length = der[offset + 1];
		if (length === undefined) throw new Error('unexpected ECDSA signature encoding');
		const value = der.subarray(offset + 2, offset + 2 + length);
		offset += 2 + length;
		return value;
	};
	const r = readInteger();
	const s = readInteger();
	return Buffer.concat([leftPadUnsigned(r, partLength), leftPadUnsigned(s, partLength)]);
}

/** Strip DER's leading zero byte(s), then left-pad to exactly `length` bytes. */
function leftPadUnsigned(value: Buffer, length: number): Buffer {
	let start = 0;
	while (start < value.length - 1 && value[start] === 0) start += 1;
	const trimmed = value.subarray(start);
	if (trimmed.length > length) throw new Error('ECDSA coordinate wider than the curve');
	return Buffer.concat([Buffer.alloc(length - trimmed.length, 0), trimmed]);
}

/** Base64url without padding (RFC 4648 §5). */
function base64Url(value: string | Buffer): string {
	return Buffer.from(value).toString('base64url');
}

/** A short, unique, human-readable identifier for a code or a token id. */
function randomId(prefix: string): string {
	return `${prefix}-${randomBytes(12).toString('hex')}`;
}

/** RFC 8628 §6.1's `user_code`: readable, and not too short to be guessable. */
function randomUserCode(): string {
	const alphabet = 'BCDFGHJKLMNPQRSTVWXZ';
	const bytes = randomBytes(8);
	let code = '';
	for (let index = 0; index < 8; index += 1) {
		if (index === 4) code += '-';
		code += alphabet[bytes[index] % alphabet.length];
	}
	return code;
}

/** Send a JSON body with `no-store`, the way every token response must be cached. */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(payload),
		'cache-control': 'no-store'
	});
	response.end(payload);
}

/** Read an `application/x-www-form-urlencoded` body, or `{}` for anything else. */
async function readForm(request: IncomingMessage): Promise<Record<string, string>> {
	if (request.method !== 'POST') return {};
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
	const body = Buffer.concat(chunks).toString('utf8');
	if (body === '') return {};
	return Object.fromEntries(new URLSearchParams(body).entries());
}
