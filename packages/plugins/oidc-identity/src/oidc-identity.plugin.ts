import { randomBytes } from 'node:crypto';

import type {
	IdentityProviderCheck,
	IPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginManifest,
	VerifiedIdTokenClaims
} from '@ever-works/plugin';
import { IdentityTokenRejectedError } from '@ever-works/plugin';
import {
	ClientSecretBasic,
	Configuration,
	allowInsecureRequests,
	buildAuthorizationUrl,
	calculatePKCECodeChallenge
} from 'openid-client';
import type { ServerMetadata } from 'openid-client';

import {
	OIDC_DISCOVERY_CACHE_SECONDS,
	OIDC_IDENTITY_SIGNING_ALGS,
	OIDC_OUTBOUND_TIMEOUT_MS,
	OidcDiscoveryReader,
	OidcProviderUnavailableError,
	fetchJsonOnce,
	type OidcDiscoveryDocument,
	type OidcDiscoveryFailure,
	type OidcDiscoveryRead,
	type OidcFetchImpl,
	type OidcProviderUnavailableReason
} from './discovery.js';
import { OidcJwksCache, OidcJwksVerificationError, type OidcJwksVerification } from './jwks-cache.js';
import { OIDC_SIGN_IN_SCOPE } from './scopes.js';
import {
	oidcIdentitySettingsSchema,
	type OidcIdentityLocalClient,
	type OidcIdentitySettings
} from './settings.schema.js';

/** Every FR-3 check id, in FR-3's own order (spec.md:183-186). */
export const FR3_CHECK_IDS: readonly IdentityProviderCheck['id'][] = [
	'discovery',
	'issuerMatch',
	'endpoints',
	'pkceS256',
	'signingAlg',
	'backchannelLogout',
	'deviceAuthorization'
];

/**
 * The five FR-3 checks that gate availability; the other two only report.
 *
 * FR-3 asks **Test connection** to report "whether back-channel logout and device
 * authorization are supported" — both are optional in OpenID Connect, and a
 * provider without them is a provider Ever Works can still sign people in with
 * (FR-33's notices are the only thing lost). Letting either row turn the plugin
 * off would make an optional feature's absence a sign-in outage, so plan §4.2's
 * `unavailableSince` is written and cleared by these five and by nothing else.
 */
export const FR3_REQUIRED_CHECK_IDS: readonly IdentityProviderCheck['id'][] = [
	'discovery',
	'issuerMatch',
	'endpoints',
	'pkceS256',
	'signingAlg'
];

/**
 * FR-9 — the `state` a sign-in carries is **at least 32 random bytes**
 * (`EVER_ID_LIMITS.stateBytes`; plan §3.5 seals it in the transaction cookie).
 *
 * Exported so the number is pinnable by a spec that reads the contract off disk,
 * exactly as T6 pinned FR-13's three numbers: the behavioural cases in
 * `src/__tests__/authorization-request.spec.ts` assert against the literals
 * `32`/`32`/`64` in FR-9's own words, and this constant is asserted against
 * `EVER_ID_LIMITS` separately.
 */
export const OIDC_STATE_BYTES = 32;

/** FR-9 — the `nonce` a sign-in carries is **at least 32 random bytes** (`EVER_ID_LIMITS.nonceBytes`). */
export const OIDC_NONCE_BYTES = 32;

/**
 * FR-9 — the PKCE code verifier is **64 characters** (`EVER_ID_LIMITS.codeVerifierLength`).
 *
 * Randomness is drawn as {@link OIDC_CODE_VERIFIER_BYTES} bytes and encoded
 * base64url, which is 64 characters for 48 bytes. The two constants are separate
 * because they are two different requirements — "64 characters" is FR-9's, and
 * the byte count is this package's choice of an encoding that produces exactly
 * that — and the spec asserts that the encoding of 48 bytes really is 64
 * characters rather than assuming it.
 */
export const OIDC_CODE_VERIFIER_LENGTH = 64;

/** How many random bytes base64url encode to {@link OIDC_CODE_VERIFIER_LENGTH} characters. */
export const OIDC_CODE_VERIFIER_BYTES = 48;

/**
 * FR-2 — the default clock-skew tolerance, in seconds
 * (`EVER_ID_LIMITS.defaultClockSkewSeconds`; the schema's `clockSkewSeconds`
 * default is the same number, and the spec asserts the two agree).
 */
export const OIDC_DEFAULT_CLOCK_SKEW_SECONDS = 60;

/**
 * FR-11 — an `iat` may be **no earlier than 600 seconds ago**
 * (`EVER_ID_LIMITS.idTokenMaxAgeSeconds`; plan §4.3's "ID token times" row).
 */
export const OIDC_ID_TOKEN_MAX_AGE_SECONDS = 600;

/**
 * FR-11 — `sub` is **1–255 characters**.
 *
 * The bound is asymmetric on purpose: an empty subject identifies nobody, and a
 * longer one is not a subject any provider's directory would mint — FR-31 stores
 * the value, so the column's width is a decision this check is allowed to make.
 */
export const OIDC_SUBJECT_MAX_LENGTH = 255;

/**
 * The seams a spec (or a future caller) may inject.
 *
 * All three are optional and all three default to the runtime: the plugin loader
 * constructs a plugin with no arguments (`PluginLoaderService.loadPluginModule`,
 * `plugin-loader.service.ts:364`), so nothing here is a production requirement.
 * They exist because T6's two properties — FR-3's 5-second bound and FR-13's
 * 600/30/21,600-second ladder — are only provable against a clock and a socket the
 * test owns; a spec that really waited 21,600 seconds is not a spec.
 *
 * `randomBytes` is T7's addition, and for the same reason: FR-9's "fresh `state`
 * and `nonce` of at least 32 random bytes each" is a claim about *freshness* and
 * *byte count*, and neither can be asserted against a value the spec cannot see
 * the source of. With the seam injected, a case can pin the exact bytes the
 * request was built from; with it left alone, the default is the platform
 * CSPRNG and the case asserts what can be asserted of any output — that two
 * calls never agree, and that each value decodes to 32 bytes.
 */
export interface OidcIdentityPluginOptions {
	/** The outbound HTTP seam; defaults to the runtime `fetch` (see `discovery.ts`). */
	readonly fetchImpl?: OidcFetchImpl;
	/** The clock, in epoch milliseconds; defaults to `Date.now`. */
	readonly now?: () => number;
	/** The randomness seam, in bytes; defaults to `node:crypto`'s `randomBytes`. */
	readonly randomBytes?: (length: number) => Uint8Array;
}

/**
 * APW-12 T5 — the `oidc-identity` plugin, **scaffold only**.
 *
 * What exists here is the identity the platform's discovery path needs and
 * nothing more:
 *
 *   - the manifest the `everworks.plugin` block in `package.json` also declares
 *     (they must agree — `packages/agent/src/plugins/services/plugin-manifest-validator.service.ts`
 *     extracts the block from disk and `PluginClassValidatorService` compares the
 *     loaded class against it);
 *   - the settings schema of plan §4.2;
 *   - the two lifecycle hooks the loader calls. Both are **prototype methods on
 *     purpose**: `PluginClassValidatorService.isPluginClass`
 *     (`packages/agent/src/plugins/services/plugin-class-validator.service.ts:42-55`)
 *     accepts a class only when `onLoad` and `onUnload` sit on its prototype, so
 *     an arrow-function property would make this plugin undiscoverable.
 *
 * What does NOT exist yet, deliberately: three of the five sign-in methods of
 * `IIdentityProviderPlugin` — `verifyAccessToken`, `verifyLogoutToken` and
 * `buildEndSessionUrl` — and `healthCheck`, which T8 writes. T6 landed the two
 * configuration methods — `testConnection` (FR-3) and `getPublicConfig` (FR-2) —
 * plus the discovery reader and the key cache they and the flow share
 * (`src/discovery.ts`, `src/jwks-cache.ts`); **T7** landed the two sign-in
 * methods, `buildAuthorizationRequest` (FR-8/FR-9/FR-10) and
 * `exchangeAuthorizationCode` (FR-11/FR-12/FR-19's single completion is the
 * caller's), plus `src/scopes.ts`. The capability string below is the plan §4.2
 * contract — the manifest is fixed — and the class still does not claim the
 * interface: it implements `IPlugin` and five of the seven methods, so
 * `isIdentityProviderPlugin` (`packages/plugin/src/contracts/capabilities/identity-provider.interface.ts:284`)
 * keeps answering `false` for it — which is what keeps the façade (plan §4.4)
 * fail-closed for the two methods T8 has not written yet. Until then the plugin
 * is inert: `autoEnable: false`, so it is discovered and listed disabled.
 */
export class OidcIdentityPlugin implements IPlugin {
	readonly id = 'oidc-identity';
	readonly name = 'OpenID Connect identity (Ever ID)';
	readonly version = '1.0.0';

	/**
	 * The plan §4.2 category, `'identity'`.
	 *
	 * The assertion is needed only because this package lands **before T4**,
	 * which appends `'identity'` to `PLUGIN_CATEGORIES`
	 * (`packages/plugin/src/contracts/plugin-manifest.types.ts:5-117` — the tuple
	 * currently closes with `'build'`). Until that append lands the loader's own
	 * `isPluginCategory` check rejects the manifest, so this plugin is
	 * discoverable only after T4; the value itself is already exact, and the
	 * assertion is the one place the type union is narrower than the plan.
	 *
	 * **Landed 2026-09-18 (T4).** `'identity'` is now the **last** member of
	 * `PLUGIN_CATEGORIES`, so the loader's `isPluginCategory` accepts this
	 * manifest and discovery finds the package instead of skipping it with
	 * `Invalid category` (T4's report measures it: 103 → 104 plugins). The
	 * paragraph above is kept because that is what this file had to say while
	 * the append was missing, and the cast below stays — it resolves to the
	 * same member, and dropping it would remove an assertion for nothing.
	 */
	readonly category: PluginCategory = 'identity' as PluginCategory;

	/** Plan §4.2: exactly one capability, `identity-provider`. */
	readonly capabilities: readonly string[] = ['identity-provider'];

	/** One issuer set per installation, configured by a platform admin (FR-7, FR-2). */
	readonly configurationMode = 'admin-only';

	readonly settingsSchema: JsonSchema = oidcIdentitySettingsSchema;

	/**
	 * The context `onLoad` was handed — the only way this plugin reads its own
	 * resolved settings (plan §4.1: no method takes a configuration object, so a
	 * caller cannot hand the plugin a different issuer, client id or secret than the
	 * one an administrator saved; FR-7).
	 */
	private context?: PluginContext;

	/** The discovery reader for the currently configured issuer (FR-14's cache lives in it). */
	private discoveryReader?: OidcDiscoveryReader;

	/** Which issuer {@link discoveryReader} was built for — a settings change replaces it. */
	private discoveryIssuerUrl?: string;

	/** The key cache for the currently configured `jwks_uri` (FR-13's ladder lives in it). */
	private jwksCache?: OidcJwksCache;

	/** Which `jwks_uri` {@link jwksCache} was built for — a provider that moves its keys replaces it. */
	private jwksUri?: string;

	/** FR-13 / plan §9.2: when the key set was last fetched successfully, in epoch ms. T32 persists it. */
	private jwksRefreshedAtMs: number | null = null;

	/** FR-14/FR-5: when the provider was first seen unusable, in epoch ms. T32 persists it. */
	private unavailableSinceMs: number | null = null;

	/** Which rule made it unusable — a closed set, never a provider's own text (FR-16). */
	private unavailableReason: OidcProviderUnavailableReason | null = null;

	private readonly fetchImpl?: OidcFetchImpl;
	private readonly now: () => number;
	private readonly randomBytes?: (length: number) => Uint8Array;

	constructor(options: OidcIdentityPluginOptions = {}) {
		this.fetchImpl = options.fetchImpl;
		this.now = options.now ?? Date.now;
		this.randomBytes = options.randomBytes;
	}

	async onLoad(context: PluginContext): Promise<void> {
		// The context is held, not copied into a settings field: settings are resolved
		// per call (`context.getSettings()`), so an administrator's change takes effect
		// without a reload — which is what FR-5's 60-second bound needs.
		this.context = context;
		context.logger.log(
			'OpenID Connect identity (Ever ID) plugin loaded — discovery, key cache, Test connection and the sign-in flow have landed; the token verifiers land in APW-12 T8'
		);
	}

	async onUnload(): Promise<void> {
		// Drop what onLoad held, so a reloaded plugin cannot answer from the previous
		// context's settings — and so the discovery cache does not outlive the
		// configuration it was read for. The key cache goes with it for the same
		// reason: its `jwks_uri` came from that discovery document.
		this.context = undefined;
		this.discoveryReader = undefined;
		this.discoveryIssuerUrl = undefined;
		this.jwksCache = undefined;
		this.jwksUri = undefined;
		this.jwksRefreshedAtMs = null;
	}

	/**
	 * FR-3 — read the provider's discovery document and report every check.
	 *
	 * The rules this method exists to keep, in the order they matter:
	 *
	 *   - **5 seconds, always** (FR-3, ACC-12-03). The read is handed a deadline
	 *     computed when the run starts, so FR-15's single retry can only ever fit
	 *     inside that budget, and the answer is reported at the deadline whether or
	 *     not the provider answered in time.
	 *   - **A row per check, always** — the same seven ids in FR-3's order, an
	 *     unconfigured integration and an unreachable provider included. A short or
	 *     varying list would make spec §6.7's admin surface render differently
	 *     depending on what went wrong.
	 *   - **Never the secret** (FR-16). No `detail` quotes a value the provider sent
	 *     except a numeric HTTP status; every one of them names a field, and the
	 *     settings object — which is where `clientSecret` lives — is never returned,
	 *     logged or embedded.
	 *
	 * The run also writes the availability record plan §4.2 keeps: the five checks
	 * of {@link FR3_REQUIRED_CHECK_IDS} passing clears `unavailableSince`, any of them
	 * failing sets it (FR-14's "until an administrator re-tests"). T32 persists it;
	 * {@link getAvailability} is the in-process view until then.
	 */
	async testConnection(): Promise<IdentityProviderCheck[]> {
		const resolved = await this.resolveSettings();
		if (!resolved.ok) {
			// Fail closed, and name the fields rather than the values (FR-4's "field
			// names only", FR-16's no-material rule applied to the admin surface).
			this.recordUnavailable('notConfigured');
			return unavailableRows(
				`Not configured: ${resolved.missing.join(', ')}.`,
				'Not checked — the integration is not configured.'
			);
		}

		const issuerUrl = resolved.settings.issuerUrl;
		// FR-3's bound starts here, not inside the fetch: everything the run does has
		// to fit inside it.
		const deadlineAt = this.now() + OIDC_OUTBOUND_TIMEOUT_MS;
		const read = await this.readerFor(issuerUrl).read({ deadlineAt });

		const checks = read.ok
			? checksFromDocument(read.document, issuerUrl)
			: unavailableRows(
					discoveryFailureDetail(read.failure, read.status),
					'Not checked — the discovery document could not be read.'
				);

		this.applyAvailability(checks);
		this.logChecks(checks);
		return checks;
	}

	/**
	 * FR-2's non-secret projection — what the web needs to render the button and
	 * what a local client needs before it can sign in.
	 *
	 * The contract's five fields and nothing else: the client secret is not among
	 * them (FR-16), and neither is anything that would let a caller address the
	 * provider differently from the configuration an administrator saved (FR-7). The
	 * defaults are FR-2's: display name `Ever ID`, audience `ever-works`, sign-up on.
	 */
	async getPublicConfig(): Promise<{
		issuer: string;
		displayName: string;
		localClients: OidcIdentityLocalClient[];
		apiAudience: string;
		signUpAllowed: boolean;
	}> {
		const resolved = await this.resolveSettings();
		if (!resolved.ok) {
			// The one honest answer for "what should the web show?" on an integration
			// with no issuer, client id or secret. The message is the code: the missing
			// field names are for the admin surface, which reads them from the settings
			// response, not from an error (FR-16).
			throw new OidcProviderUnavailableError('notConfigured');
		}

		const settings = resolved.settings;
		return {
			issuer: settings.issuerUrl,
			displayName: nonEmpty(settings.displayName) ?? 'Ever ID',
			localClients: localClientsOf(settings.localClients),
			apiAudience: nonEmpty(settings.apiAudience) ?? 'ever-works',
			// FR-2's default is on, so only an explicit `false` turns sign-up off.
			signUpAllowed: settings.signUpAllowed !== false
		};
	}

	/**
	 * FR-8/FR-9/FR-10/FR-12's first half — the authorization request a browser is
	 * sent to, and the three secrets the transaction cookie carries.
	 *
	 * What this method is responsible for, and what it is deliberately not:
	 *
	 *   - **PKCE S256 only** (FR-8). `code_challenge_method=S256` is a literal in
	 *     the parameters below and the challenge is the SHA-256 of the verifier,
	 *     computed by `openid-client`'s `calculatePKCECodeChallenge` — the same
	 *     transformation the provider will apply to the verifier at the token
	 *     endpoint. `plain` is never offered and never sent; a provider that
	 *     advertises only `plain` is refused by FR-3's check row and by the
	 *     availability record, not by this method.
	 *   - **Fresh `state` and `nonce` of 32 random bytes, and a 64-character
	 *     verifier, per call** (FR-9). Every call draws new bytes from
	 *     {@link OidcIdentityPluginOptions.randomBytes} (the platform CSPRNG by
	 *     default) and encodes them base64url: 32 bytes → a 43-character value
	 *     whose decoded length is exactly the 32 FR-9 asks for, 48 bytes → exactly
	 *     the 64 characters FR-9 asks of the verifier. Nothing is reused between
	 *     calls and nothing is derived from the clock, the issuer or the client
	 *     id — a `state` an attacker can predict is a `state` that binds nothing.
	 *   - **The exact redirect address, never rebuilt** (FR-10). `redirectUri` is
	 *     copied into the query parameter byte-for-byte: no trailing-slash
	 *     normalisation, no parsing and re-serialising, no default. Deriving that
	 *     address from the configured public web address — and refusing anything
	 *     that came from request input — is the caller's rule (plan §5.1's
	 *     `POST /authorize`), and this method cannot enforce it because the
	 *     address is not part of the plugin's settings (plan §4.2 has no redirect
	 *     key: the one address per deployment lives in platform configuration).
	 *   - **`openid email profile`, and never `offline_access`** (plan §4.2,
	 *     FR-38) — the scope comes from `src/scopes.ts` as one constant rather
	 *     than being assembled here.
	 *
	 * The endpoint comes from the discovery document this plugin already read
	 * (FR-14's 3,600-second cache, and its issuer-drift refusal): a request is
	 * never built against an issuer whose document advertises a different issuer,
	 * so a provider cannot move this installation's sign-in by publishing a
	 * document somewhere else.
	 *
	 * Errors are T6's availability vocabulary rather than token rejections —
	 * nothing here verifies a token, and a caller needs to know *which*
	 * configuration or document problem stopped the sign-in from starting:
	 * `notConfigured`, `discoveryFailed`, `issuerDrift` or `discoveryIncomplete`
	 * (a document with no `authorization_endpoint`). Every one of them maps to
	 * plan §5.2's `404 everIdDisabled` / `503 providerUnavailable` at the façade.
	 */
	async buildAuthorizationRequest(input: {
		redirectUri: string;
		prompt?: 'login';
		maxAgeSeconds?: number;
	}): Promise<{ url: string; state: string; nonce: string; codeVerifier: string }> {
		const resolved = await this.resolveSettings();
		if (!resolved.ok) throw new OidcProviderUnavailableError('notConfigured');
		const settings = resolved.settings;

		const document = await this.readerFor(settings.issuerUrl).get();
		if (typeof document.authorization_endpoint !== 'string' || document.authorization_endpoint.length === 0) {
			// FR-3's `endpoints` row reports this too; here it is fatal, because a
			// request without an endpoint is a request to nowhere.
			throw new OidcProviderUnavailableError('discoveryIncomplete');
		}

		const state = encodeBase64Url(this.random(OIDC_STATE_BYTES));
		const nonce = encodeBase64Url(this.random(OIDC_NONCE_BYTES));
		const codeVerifier = encodeBase64Url(this.random(OIDC_CODE_VERIFIER_BYTES));
		const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);

		const url = buildAuthorizationUrl(this.configurationFor(document, settings), {
			response_type: 'code',
			client_id: settings.clientId,
			redirect_uri: input.redirectUri,
			scope: OIDC_SIGN_IN_SCOPE,
			state,
			nonce,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
			// FR-25's connect path asks for a fresh authentication (`prompt=login`) and
			// bounds how old it may be (`max_age`); a plain sign-in sends neither, and
			// an absent parameter is not the same wire value as an empty one.
			...(input.prompt === undefined ? {} : { prompt: input.prompt }),
			...(input.maxAgeSeconds === undefined ? {} : { max_age: String(input.maxAgeSeconds) })
		});

		return { url: url.toString(), state, nonce, codeVerifier };
	}

	/**
	 * FR-11/FR-12 — redeem an authorization code and answer the ID token's claims,
	 * or refuse.
	 *
	 * The order below is the spec's order, and each step is load-bearing:
	 *
	 *   1. **the settings resolve** — an unconfigured integration cannot exchange
	 *      anything, and this method has no way to say so except
	 *      `providerUnavailable` (see the error contract below);
	 *   2. **FR-12's `iss` equality, before anything is redeemed.** When the
	 *      authorization response carries `iss`, it must equal the configured
	 *      issuer exactly. Checking it first is not an optimisation: a code whose
	 *      response named another issuer is a code this installation must not
	 *      spend, and a refusal here touches the network zero times;
	 *   3. **the discovery document** (FR-14's cache, and its issuer-drift
	 *      refusal) — the token endpoint and `jwks_uri` come from it;
	 *   4. **the code exchange** — one POST, `client_secret_basic`, 5,000 ms, and
	 *      **no retry** (FR-15's "the code exchange is never retried": a second
	 *      attempt would be a second redemption of a single-use code, which is
	 *      FR-19's "a sign-in transaction completes at most once" seen from the
	 *      provider's side);
	 *   5. **the signature and the algorithm**, through T6's key cache
	 *      (`jwks-cache.ts`), whose three codes and whose 21,600-second
	 *      fail-closed end are reported with the same codes here;
	 *   6. **FR-11's claim rules** (plan §4.3), against the injected clock and the
	 *      administrator's `clockSkewSeconds` (default
	 *      {@link OIDC_DEFAULT_CLOCK_SKEW_SECONDS}).
	 *
	 * ## The error contract, and why it differs from {@link buildAuthorizationRequest}
	 *
	 * **Everything this method throws is an `IdentityTokenRejectedError`** — the
	 * contract's single refusal type, `message` equal to `code` and nothing else
	 * (FR-16). That includes the provider-unavailable conditions: T6's discovery
	 * and key-cache errors are caught below and rethrown as
	 * `providerUnavailable`, and any `jwks-cache` refusal keeps its own code
	 * (`badAlg`, `badSignature`). The reason is the caller: the callback handler
	 * has one decision to make — plan §5.2's "ID token rejected → 401" versus
	 * "endpoint unavailable → 503" — and one error type with a closed code set is
	 * the shape that decision is written against. The builder, which answers a
	 * question rather than a verdict, keeps the precise availability reason
	 * instead.
	 *
	 * A refusal never partially succeeds: nothing is returned, nothing is stored,
	 * and no claim of a refused token reaches the caller.
	 *
	 * ## `maxAuthAgeSeconds` (FR-25)
	 *
	 * Supplied, it applies FR-25's rule — `auth_time` no older than 300 seconds
	 * plus the skew — and answers `tooOld`, including when the token carries no
	 * `auth_time` at all: a connect flow that cannot show the authentication was
	 * recent must re-authenticate rather than proceed. Absent (a plain sign-in),
	 * `auth_time` is not required and is passed through as `null` when missing.
	 */
	async exchangeAuthorizationCode(input: {
		code: string;
		redirectUri: string;
		codeVerifier: string;
		expectedNonce: string;
		receivedIssuer?: string;
		maxAuthAgeSeconds?: number;
	}): Promise<VerifiedIdTokenClaims> {
		const resolved = await this.resolveSettings();
		if (!resolved.ok) throw new IdentityTokenRejectedError('providerUnavailable');
		const settings = resolved.settings;

		// FR-12, first and offline (see the order above). The comparison is exact:
		// the allow-list (`allowedIssuers`) widens which `iss` a *token* may carry
		// (FR-11), never which issuer the authorization response may name.
		if (input.receivedIssuer !== undefined && input.receivedIssuer !== settings.issuerUrl) {
			throw new IdentityTokenRejectedError('badIssuer');
		}

		const document = await this.discoveryForExchange(settings.issuerUrl);
		const tokenEndpoint = nonEmpty(document.token_endpoint);
		const jwksUri = nonEmpty(document.jwks_uri);
		if (tokenEndpoint === undefined || jwksUri === undefined) {
			// FR-3's `endpoints` row: without both, no exchange can be completed or
			// verified, and the provider is unavailable rather than the token bad.
			throw new IdentityTokenRejectedError('providerUnavailable');
		}

		const idToken = await this.redeemAuthorizationCode(input, settings, tokenEndpoint);
		const verification = await this.verifyIdTokenSignature(idToken, jwksUri);

		return idTokenClaims(verification.payload, {
			issuer: document.issuer,
			clientId: settings.clientId,
			// FR-2's default when an administrator configured no allow-list: the one
			// issuer this installation accepts is its own.
			allowedIssuers: settings.allowedIssuers ?? [settings.issuerUrl],
			expectedNonce: input.expectedNonce,
			skewSeconds: settings.clockSkewSeconds ?? OIDC_DEFAULT_CLOCK_SKEW_SECONDS,
			nowSeconds: Math.floor(this.now() / 1_000),
			maxAuthAgeSeconds: input.maxAuthAgeSeconds
		});
	}

	/**
	 * The in-process availability record plan §4.2 stores under `availability`.
	 *
	 * Additive surface for T32, which persists these into the plugin's settings row so
	 * every replica agrees within 60 seconds (FR-5): this is the same record one
	 * process holds, exposed so the persistence task does not have to re-derive when a
	 * run passed.
	 *
	 * `jwksRefreshedAt` is T7's addition — plan §9.2's health view has carried the
	 * field since T5 wrote it into the settings schema
	 * (`settings.schema.ts:262`) and nothing produced it until the key cache was
	 * wired to the flow; it is `null` until a key set has been fetched, which is
	 * exactly what plan §9.2's admin surface renders as "unknown".
	 */
	getAvailability(): {
		unavailableSince: string | null;
		unavailableReason: OidcProviderUnavailableReason | null;
		discoveryRefreshedAt: string | null;
		jwksRefreshedAt: string | null;
		discoveryCacheSeconds: number;
	} {
		const refreshedAt = this.discoveryReader?.lastRefreshedAt ?? null;
		return {
			unavailableSince: this.unavailableSinceMs === null ? null : new Date(this.unavailableSinceMs).toISOString(),
			unavailableReason: this.unavailableReason,
			discoveryRefreshedAt: refreshedAt === null ? null : new Date(refreshedAt).toISOString(),
			jwksRefreshedAt: this.jwksRefreshedAtMs === null ? null : new Date(this.jwksRefreshedAtMs).toISOString(),
			discoveryCacheSeconds: OIDC_DISCOVERY_CACHE_SECONDS
		};
	}

	/**
	 * The settings this plugin reads, or the field names that are missing.
	 *
	 * `context.getSettings()` resolves the admin-tier values, secrets included
	 * (`SettingsSchemaValidatorService`, plan §4.2); a throw from the platform is
	 * treated exactly like an absent configuration, because the fail-closed answer is
	 * the same and neither path may surface the platform's own error text (FR-16).
	 */
	private async resolveSettings(): Promise<
		{ ok: true; settings: OidcIdentitySettings } | { ok: false; missing: string[] }
	> {
		let raw: Record<string, unknown> = {};
		try {
			raw = (await this.context?.getSettings()) ?? {};
		} catch {
			raw = {};
		}

		const missing = REQUIRED_SETTING_KEYS.filter(
			(key) => typeof raw[key] !== 'string' || (raw[key] as string).trim() === ''
		);
		if (missing.length > 0) return { ok: false, missing: [...missing] };
		return { ok: true, settings: raw as unknown as OidcIdentitySettings };
	}

	/** One reader per configured issuer: a settings change starts a fresh cache (FR-14). */
	private readerFor(issuerUrl: string): OidcDiscoveryReader {
		if (this.discoveryReader === undefined || this.discoveryIssuerUrl !== issuerUrl) {
			this.discoveryReader = new OidcDiscoveryReader({ issuerUrl, fetchImpl: this.fetchImpl, now: this.now });
			this.discoveryIssuerUrl = issuerUrl;
		}
		return this.discoveryReader;
	}

	/**
	 * The discovery document the exchange runs against, with T6's availability
	 * errors translated to the one refusal type this method's caller branches on
	 * (see {@link exchangeAuthorizationCode}'s error contract).
	 */
	private async discoveryForExchange(issuerUrl: string): Promise<OidcDiscoveryDocument> {
		try {
			return await this.readerFor(issuerUrl).get();
		} catch (error) {
			if (error instanceof OidcProviderUnavailableError) {
				throw new IdentityTokenRejectedError('providerUnavailable');
			}
			throw error;
		}
	}

	/**
	 * The one POST of the sign-in flow (FR-15, FR-19).
	 *
	 * `client_secret_basic` is plan §4.2's authentication method for this provider,
	 * and `ClientSecretBasic` from `openid-client` is what produces the header —
	 * the same function the library's own grant calls use, so the encoding of the
	 * credentials (`application/x-www-form-urlencoded` then base64, RFC 6749
	 * §2.3.1) is not re-implemented here. `client_id` is therefore **not** in the
	 * body: RFC 6749 §4.1.3 requires it only "if the client is not authenticating
	 * with the authorization server", and sending it twice is a habit providers
	 * tolerate rather than a requirement they state.
	 *
	 * The response is read as JSON and the `id_token` taken from it. Every way the
	 * call can fail is one code — `providerUnavailable` — because the closed
	 * vocabulary has no code for "the provider refused the grant" and a precise
	 * code with the wrong meaning is worse than a coarse one that is right (see the
	 * report for T4/T25: an `invalid_grant` therefore reaches the API as 503 today).
	 */
	private async redeemAuthorizationCode(
		input: { code: string; redirectUri: string; codeVerifier: string },
		settings: OidcIdentitySettings,
		tokenEndpoint: string
	): Promise<string> {
		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code: input.code,
			redirect_uri: input.redirectUri,
			code_verifier: input.codeVerifier
		});
		const headers = new Headers();
		ClientSecretBasic(settings.clientSecret)(
			{ issuer: settings.issuerUrl, token_endpoint: tokenEndpoint } as ServerMetadata,
			{ client_id: settings.clientId, token_endpoint_auth_method: 'client_secret_basic' },
			body,
			headers
		);

		const result = await fetchJsonOnce(
			{
				url: tokenEndpoint,
				method: 'POST',
				body: body.toString(),
				contentType: 'application/x-www-form-urlencoded',
				headers: { authorization: headers.get('authorization') ?? '' }
			},
			{ fetchImpl: this.fetchImpl, now: this.now }
		);
		if (!result.ok) throw new IdentityTokenRejectedError('providerUnavailable');

		const idToken = idTokenOf(result.body);
		// A 200 without an `id_token` is not a token we may refuse by its claims: it
		// is an answer this installation cannot use at all (FR-11's first clause).
		if (idToken === null) throw new IdentityTokenRejectedError('providerUnavailable');
		return idToken;
	}

	/**
	 * FR-11's first two clauses, through T6's key cache: the algorithm allow-list
	 * and the signature, with the cache's own ladder (600 s, 30 s, 21,600 s) and
	 * its `providerUnavailable` end.
	 *
	 * Both of T6's error types become `IdentityTokenRejectedError`: `badAlg` and
	 * `badSignature` keep their code, and anything the cache could not answer
	 * because the provider is unreachable or its keys are stale is
	 * `providerUnavailable`. An error that is neither is a bug in this package
	 * rather than a verdict about a token, so it propagates instead of being
	 * disguised as a provider outage — no claims are returned either way, which is
	 * what fail-closed means here.
	 */
	private async verifyIdTokenSignature(idToken: string, jwksUri: string): Promise<OidcJwksVerification> {
		try {
			return await this.jwksFor(jwksUri).verify(idToken);
		} catch (error) {
			if (error instanceof OidcJwksVerificationError) throw new IdentityTokenRejectedError(error.code);
			if (error instanceof OidcProviderUnavailableError) {
				throw new IdentityTokenRejectedError('providerUnavailable');
			}
			throw error;
		}
	}

	/** One key cache per resolved `jwks_uri`; a provider that moves its keys starts a fresh one (FR-13). */
	private jwksFor(jwksUri: string): OidcJwksCache {
		if (this.jwksCache === undefined || this.jwksUri !== jwksUri) {
			this.jwksCache = new OidcJwksCache({
				jwksUri,
				fetchImpl: this.fetchImpl,
				now: this.now,
				// Plan §9.2's `jwksRefreshedAt`, and nothing else: a *failed* fetch
				// does not move it, which is what makes FR-13's staleness window
				// readable from outside the cache.
				onRefreshed: (refreshedAt) => {
					this.jwksRefreshedAtMs = refreshedAt;
				}
			});
			this.jwksUri = jwksUri;
		}
		return this.jwksCache;
	}

	/**
	 * The `openid-client` configuration for one document and one resolved settings
	 * object — used for `buildAuthorizationUrl`, which is a pure URL builder (no
	 * socket, no timer), and for nothing else.
	 *
	 * The rest of the flow does not go through `openid-client`'s `authorizationCodeGrant`,
	 * and that is a measured decision rather than an omission: that call validates
	 * the ID token itself against its own remote key set, which caches for 600
	 * seconds and **keeps using a stale set indefinitely** — the opposite of FR-13's
	 * 21,600-second fail-closed end that `jwks-cache.ts` exists to enforce — and it
	 * applies its own `clockTolerance` to the time claims, which would decide
	 * FR-11's skew edges instead of the administrator's configured
	 * `clockSkewSeconds`. Plan §4.2 names the library for this flow; where its
	 * built-in policy contradicts the spec, the spec's own module wins and the
	 * library keeps the parts that are exactly right (`buildAuthorizationUrl`,
	 * `calculatePKCECodeChallenge`, `ClientSecretBasic`) — the same trade T6
	 * documented for `discovery()`.
	 */
	private configurationFor(document: OidcDiscoveryDocument, settings: OidcIdentitySettings): Configuration {
		const configuration = new Configuration(
			// The document was read from the wire, so the cast is the same one
			// `asDiscoveryDocument` makes on the way in: the fields this flow reads are
			// the ones typed above, and every other claim is passed through as published.
			document as unknown as ServerMetadata,
			settings.clientId,
			settings.clientSecret,
			// Plan §4.2's `client_secret_basic`. Passing the secret as metadata would
			// select `openid-client`'s default, which is `client_secret_post` — a
			// different authentication method than the one this installation registers.
			ClientSecretBasic(settings.clientSecret)
		);
		if (isInsecureIssuer(settings.issuerUrl)) {
			// `http://localhost` is the one non-TLS issuer the settings schema accepts,
			// and outside production (settings.schema.ts:41-42). `openid-client`
			// refuses a non-TLS endpoint unless it is told this is deliberate — and the
			// schema is where that decision was already made, so this mirrors it rather
			// than second-guessing it.
			allowInsecureRequests(configuration);
		}
		return configuration;
	}

	/** Exactly `length` random bytes, from the injected seam or the platform CSPRNG (FR-9). */
	private random(length: number): Uint8Array {
		return (this.randomBytes ?? defaultRandomBytes)(length);
	}

	/** Set or clear plan §4.2's `unavailableSince` from the five checks that gate it. */
	private applyAvailability(checks: IdentityProviderCheck[]): void {
		const failed = checks.find((check) => FR3_REQUIRED_CHECK_IDS.includes(check.id) && !check.ok);
		if (failed === undefined) {
			this.unavailableSinceMs = null;
			this.unavailableReason = null;
			return;
		}
		this.recordUnavailable(failed.id === 'issuerMatch' ? 'issuerDrift' : 'discoveryFailed');
	}

	/** FR-14/FR-5: the provider is off from the first failing run until a passing one. */
	private recordUnavailable(reason: OidcProviderUnavailableReason): void {
		// The instant of the *first* failure is kept (FR-5's 60-second bound is about
		// how long the provider has been unusable, not when it was last asked).
		if (this.unavailableSinceMs === null) this.unavailableSinceMs = this.now();
		this.unavailableReason = reason;
	}

	/**
	 * One log line per run, and it carries counts and check **ids** only.
	 *
	 * Ids come from the closed contract set, never from the provider, so nothing a
	 * provider chose to send can reach a log through this path (FR-16).
	 */
	private logChecks(checks: IdentityProviderCheck[]): void {
		const passed = checks.filter((check) => check.ok).length;
		const failing = checks.filter((check) => !check.ok).map((check) => check.id);
		const suffix = failing.length === 0 ? '' : ` — failing: ${failing.join(', ')}`;
		this.context?.logger.log(`Test connection: ${passed}/${checks.length} checks passed${suffix}`);
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'OpenID Connect relying party for Ever ID: browser sign-in, connected identities, delegated reads and back-channel logout',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			// The installation opts in explicitly: discovery lists it disabled (FR-5's
			// kill switch is the plugin toggle, plan §9.2).
			autoEnable: false
		};
	}
}

export default OidcIdentityPlugin;

/** FR-2's three required settings, in the schema's own order (`settings.schema.ts:277`). */
const REQUIRED_SETTING_KEYS = ['issuerUrl', 'clientId', 'clientSecret'] as const;

/**
 * FR-9's randomness, from the platform CSPRNG.
 *
 * `node:crypto`'s `randomBytes` rather than `Math.random` (which is neither
 * cryptographic nor a length contract) and rather than a hand-rolled accumulator:
 * the whole value of `state` is that nobody can predict it, so the one thing this
 * function may do is ask the platform for random bytes and hand them back
 * unmodified in a `Uint8Array` of exactly the requested length.
 */
const defaultRandomBytes = (length: number): Uint8Array => new Uint8Array(randomBytes(length));

/**
 * The base64url spelling of some bytes — RFC 4648 §5, no padding.
 *
 * Used for all three of FR-9's values, because base64url is what PKCE's
 * `code_challenge`/`code_verifier` grammar requires (RFC 7636 §4.1: the
 * unreserved set `A-Z a-z 0-9 - . _ ~`) and what an OAuth `state`/`nonce` is
 * conventionally carried as. `base64url` omits `=` padding, so 32 bytes are 43
 * characters and 48 are exactly 64.
 */
function encodeBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}

/**
 * Is the configured issuer one `openid-client` would refuse without being told
 * the choice was deliberate?
 *
 * `http:` and nothing else — the settings schema (`settings.schema.ts:41-42`)
 * admits `http` only for `localhost`/`127.0.0.1`, so by the time an issuer
 * reaches this function the "is this a development address" question has been
 * answered. A value that is not a URL at all answers `false` and is refused later
 * by the discovery reader's own `invalidIssuer`, which is where a bad address
 * belongs.
 */
function isInsecureIssuer(issuerUrl: string): boolean {
	try {
		return new URL(issuerUrl).protocol === 'http:';
	} catch {
		return false;
	}
}

/** The `id_token` a token response carries, or `null` when it carries none. */
function idTokenOf(body: unknown): string | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	return nonEmpty((body as { id_token?: unknown }).id_token) ?? null;
}

/**
 * The FR-11 claim rules of plan §4.3, applied to a payload whose signature and
 * algorithm have already been verified.
 *
 * Every refusal is an `IdentityTokenRejectedError`, and the code names which rule
 * failed — which is the only place that detail exists, because `message` is the
 * code and the API answers one opaque 401 for all of them except
 * `providerUnavailable` (plan §5.2: "detail code logged server-side only").
 *
 * The three readings that are not literally in FR-11's words, and why:
 *
 *   - **a multi-audience token whose `azp` is missing or different answers
 *     `badAuthorizedParty`, not `badAudience`.** Plan §4.3 puts the rule in the
 *     audience row ("`aud.length > 1` ⇒ `azp === clientId`"), but the closed
 *     vocabulary has a code that says exactly this, and the operator reading the
 *     server-side detail is better served by it. FR-11's rule is narrower than
 *     OpenID Connect Core's "SHOULD" in one respect that is kept deliberately: a
 *     **single**-valued `aud` equal to the client id is accepted even when `azp`
 *     names another party, because that is what the spec states and a stricter
 *     check than the spec is a behaviour nobody asked for.
 *   - **an unreadable `exp`/`iat`/`auth_time` fails closed**, as `expired` /
 *     `tooOld` / `tooOld`: a claim that is missing or is not a number cannot be
 *     shown to be inside its window, and "we could not check it" is not a pass.
 *   - **a `sub` that is not 1–255 characters answers `badSignature`.** The closed
 *     vocabulary has no code for a malformed subject, and `badSignature` is this
 *     package's established reading of "this is not a token we can accept" — T6
 *     uses it in `jwks-cache.ts:182` for a value that is not a compact JWS at all
 *     and at `:202` for a payload that will not parse, both of which are the same
 *     class of structural refusal. It is reported as a finding for T4/T25: a
 *     dedicated code would say more.
 *
 * The times are compared in whole seconds since the epoch — the unit every JWT
 * time claim uses — with the administrator's skew (FR-2, default 60, 0–120).
 * `iat`'s two bounds are not symmetric: the skew widens the future edge, while
 * the 600-second past edge (`idTokenMaxAgeSeconds`) is a fixed freshness rule
 * that no skew setting relaxes.
 */
function idTokenClaims(payload: Record<string, unknown>, rules: IdTokenRules): VerifiedIdTokenClaims {
	const issuer = payload.iss;
	// FR-11: `iss` equals the configured issuer **and is allow-listed** (plan §4.3).
	// The first half is what binds the token to the document the keys came from; the
	// second is what makes a planned provider move reversible (FR-2).
	if (typeof issuer !== 'string' || issuer !== rules.issuer || !rules.allowedIssuers.includes(issuer)) {
		throw new IdentityTokenRejectedError('badIssuer');
	}

	const audiences = audiencesOf(payload.aud);
	if (audiences === null || !audiences.includes(rules.clientId)) {
		throw new IdentityTokenRejectedError('badAudience');
	}
	if (audiences.length > 1 && payload.azp !== rules.clientId) {
		throw new IdentityTokenRejectedError('badAuthorizedParty');
	}

	const expiresAt = secondsClaim(payload.exp);
	if (expiresAt === null || expiresAt <= rules.nowSeconds - rules.skewSeconds) {
		// FR-11: "`exp` is later than now minus the skew" — strict, so a token that
		// expired exactly `skew` seconds ago is refused.
		throw new IdentityTokenRejectedError('expired');
	}

	const issuedAt = secondsClaim(payload.iat);
	if (issuedAt === null) throw new IdentityTokenRejectedError('tooOld');
	if (issuedAt > rules.nowSeconds + rules.skewSeconds) throw new IdentityTokenRejectedError('notYetValid');
	if (issuedAt < rules.nowSeconds - OIDC_ID_TOKEN_MAX_AGE_SECONDS) {
		throw new IdentityTokenRejectedError('tooOld');
	}

	// FR-11's nonce rule: the value the transaction sealed must be the value that
	// came back, byte for byte. A token with no `nonce` at all is a token that
	// cannot match, so it is refused by the same comparison rather than by a
	// separate branch.
	if (payload.nonce !== rules.expectedNonce) throw new IdentityTokenRejectedError('badNonce');

	const subject = payload.sub;
	if (typeof subject !== 'string' || subject.length < 1 || subject.length > OIDC_SUBJECT_MAX_LENGTH) {
		throw new IdentityTokenRejectedError('badSignature');
	}

	const authTime = secondsClaim(payload.auth_time);
	if (rules.maxAuthAgeSeconds !== undefined) {
		// FR-25 / plan §4.3: `auth_time ≥ now − maxAuthAge − skew`, and a missing
		// `auth_time` is a refusal on the one path that asks for it.
		if (authTime === null || authTime < rules.nowSeconds - rules.maxAuthAgeSeconds - rules.skewSeconds) {
			throw new IdentityTokenRejectedError('tooOld');
		}
	}

	return {
		issuer,
		subject,
		// FR-23/FR-24/FR-25 branch on the pair (`email`, `email_verified`), and the
		// contract's "absent or unusable is `null`" is what makes `email: null` and
		// `emailVerified: false` two different states rather than one.
		email: nonEmpty(payload.email) ?? null,
		emailVerified: payload.email_verified === true,
		name: nonEmpty(payload.name) ?? null,
		authTime,
		sid: nonEmpty(payload.sid) ?? null
	};
}

/** The rules {@link idTokenClaims} applies — everything it needs that the token itself does not carry. */
interface IdTokenRules {
	/** The issuer the discovery document advertises and the settings configured (FR-11, FR-12, FR-14). */
	readonly issuer: string;
	/** The relying party's client id (FR-2): the audience the ID token must carry. */
	readonly clientId: string;
	/** FR-2's 1–3 accepted issuer strings; defaults to `[issuerUrl]`. */
	readonly allowedIssuers: readonly string[];
	/** FR-9's `nonce`, as the transaction sealed it. */
	readonly expectedNonce: string;
	/** The injected clock, in whole seconds since the epoch. */
	readonly nowSeconds: number;
	/** FR-2's tolerance, 0–120 seconds. */
	readonly skewSeconds: number;
	/** FR-25's connect bound, when the caller asked for one. */
	readonly maxAuthAgeSeconds?: number | undefined;
}

/**
 * `aud` as a list, or `null` when it is neither a string nor an array of strings.
 *
 * Both spellings are legal JWT (RFC 7519 §4.1.3) and providers use both. A value
 * this function cannot read is `null` — a refusal — rather than an empty list,
 * which would read as "the audience is fine, it just does not name us".
 */
function audiencesOf(value: unknown): string[] | null {
	if (typeof value === 'string') return [value];
	if (!Array.isArray(value) || value.length === 0) return null;
	return value.every((entry) => typeof entry === 'string') ? [...(value as string[])] : null;
}

/** A JWT time claim in seconds, or `null` for anything missing or not a finite number. */
function secondsClaim(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One FR-3 row.
 *
 * `detail` is present **exactly** when `ok` is false: a passing check has nothing
 * to explain, and the contract's `detail?` is what spec §6.7 renders next to the
 * `✓`/`✗`. A failing row always carries one, so an administrator never sees a
 * bare cross.
 */
function row(id: IdentityProviderCheck['id'], ok: boolean, detail?: string): IdentityProviderCheck {
	if (ok) return { id, ok };
	return { id, ok, detail: detail ?? 'The check failed.' };
}

/** The seven rows FR-3 asks for, with `discovery` carrying one detail and the rest another. */
function unavailableRows(discoveryDetail: string, otherDetail: string): IdentityProviderCheck[] {
	return FR3_CHECK_IDS.map((id, index) => row(id, false, index === 0 ? discoveryDetail : otherDetail));
}

/**
 * The FR-3 rows a discovery document answers, in FR-3's order.
 *
 * Every value here comes from the document, and every *detail* is written by this
 * file: nothing a provider sent is echoed back into the admin surface, so a
 * provider cannot put text of its choosing in front of a platform administrator
 * (FR-16's no-material rule, read as far as reflecting arbitrary provider content).
 */
function checksFromDocument(document: OidcDiscoveryDocument, issuerUrl: string): IdentityProviderCheck[] {
	const missingEndpoints = (['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const).filter(
		(name) => typeof document[name] !== 'string' || (document[name] as string).length === 0
	);
	const challengeMethods = Array.isArray(document.code_challenge_methods_supported)
		? document.code_challenge_methods_supported
		: [];
	const signingAlgorithms = Array.isArray(document.id_token_signing_alg_values_supported)
		? document.id_token_signing_alg_values_supported
		: [];

	return [
		row('discovery', true),
		// FR-3's word is "exactly": no trailing-slash normalisation, no case folding.
		// The allow-list (`allowedIssuers`, FR-2) is what makes a planned provider
		// move reversible, and it is checked on the token's `iss` (§4.3), not here.
		row(
			'issuerMatch',
			document.issuer === issuerUrl,
			'The issuer the provider advertises does not match the configured issuer exactly.'
		),
		row(
			'endpoints',
			missingEndpoints.length === 0,
			`The discovery document is missing ${missingEndpoints.join(', ')}.`
		),
		row(
			'pkceS256',
			challengeMethods.includes('S256'),
			'The provider does not advertise S256 code challenge support.'
		),
		row(
			'signingAlg',
			OIDC_IDENTITY_SIGNING_ALGS.some((alg) => signingAlgorithms.includes(alg)),
			'The provider advertises none of RS256, ES256 or EdDSA.'
		),
		// FR-3 asks whether these two are supported; they are reported and never gate
		// availability (see FR3_REQUIRED_CHECK_IDS).
		row(
			'backchannelLogout',
			document.backchannel_logout_supported === true,
			'The provider does not advertise back-channel logout.'
		),
		row(
			'deviceAuthorization',
			typeof document.device_authorization_endpoint === 'string' &&
				document.device_authorization_endpoint.length > 0,
			'The provider does not advertise a device authorization endpoint.'
		)
	];
}

/**
 * Why the discovery read failed, in words an administrator can act on.
 *
 * One line per failure mode of `discovery.ts`, exhaustive on purpose: a new failure
 * mode must be given a sentence rather than falling through to a blank cross. The
 * HTTP status is the only provider-chosen value that appears, and it is a number.
 */
function discoveryFailureDetail(failure: OidcDiscoveryFailure, status?: number): string {
	switch (failure) {
		case 'timeout':
			return 'The discovery document did not answer within 5 seconds.';
		case 'httpStatus':
			return typeof status === 'number'
				? `The discovery document answered HTTP ${status}.`
				: 'The discovery document answered an error status.';
		case 'network':
			return 'The discovery document could not be reached.';
		case 'invalidBody':
			return 'The discovery document is not JSON.';
		case 'invalidDocument':
			return 'The discovery document carries no issuer.';
		case 'invalidIssuer':
			return 'The configured issuer address is not a valid URL.';
	}
}

/** A trimmed string, or `undefined` for anything absent, blank or not a string. */
function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

/**
 * FR-2's local clients, filtered to the shape the contract publishes.
 *
 * The schema already caps the list at five and constrains `kind`, so this is the
 * reader's fail-closed half: an entry that is not a `{ kind, clientId }` pair is
 * dropped rather than handed to a caller as a client id it might trust. Dropping
 * can only *remove* an allowance, never add one, so it cannot widen access —
 * `verifyAccessToken`'s `allowedAuthorizedParties` (T8, FR-40) is what refuses a
 * token whose `azp` is not in the surviving list.
 */
function localClientsOf(value: unknown): OidcIdentityLocalClient[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (typeof entry !== 'object' || entry === null) return [];
		const { kind, clientId } = entry as { kind?: unknown; clientId?: unknown };
		if (kind !== 'cli' && kind !== 'node') return [];
		const id = nonEmpty(clientId);
		return id === undefined ? [] : [{ kind, clientId: id }];
	});
}
