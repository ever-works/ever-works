/**
 * Identity provider — the `identity-provider` capability's plugin contract
 * (APW-12 plan §4.1, tasks T4).
 *
 * Owning epic: **APW-12 (Ever ID)**. Spec:
 * `docs/specs/features/app-works/APW-12-ever-id/spec.md` — the availability rules
 * (FR-1, FR-2), the one configuration and its **Test connection** checks (FR-3),
 * authorization-code flow with PKCE S256 (FR-8…FR-10), the ID-token acceptance
 * rules (FR-11…FR-13), the discovery and key caches (FR-14, FR-15), "no token,
 * code, verifier or nonce ever appears in a log, an error message or a response"
 * (FR-16, FR-17), device sign-in and the local-client exchange (FR-39…FR-43),
 * the App Launcher's delegated read (FR-44…FR-48) and the back-channel sign-out
 * notice (FR-33…FR-35). Plan: §4.1 (this file), §4.2 (the `oidc-identity`
 * package that implements it, APW-12 T5/T6), §4.4 (`IdentityProviderFacadeService`,
 * the only thing that resolves a plugin through this capability).
 *
 * ## What is declared here, and what is not
 *
 * Everything in this file is plugin-facing: the seven methods a provider
 * implements, the shapes they answer with, the seven checks **Test connection**
 * renders, and the closed token-rejection code set. Nothing here reaches a
 * database row or a wire response, so — unlike `build.interface.ts` and
 * `app-dependency.interface.ts` — there is no `@ever-works/contracts` type to
 * re-export instead (Resolution R-1). The one neighbouring declaration is
 * `EverIdErrorCode` (`packages/contracts/src/apps/ever-id.ts`, APW-12 T3), which
 * is the **platform's** error vocabulary for the API and the web i18n leaves;
 * `IdentityTokenRejectedError.code` below is the **token-validation** vocabulary
 * the facade maps onto it (plan §5.2). They are two different closed sets on
 * purpose, and neither restates the other.
 *
 * ## Additive only (CONTRACTS R-26)
 *
 * `identity-provider` is appended to `PLUGIN_CAPABILITIES` and `identity` to
 * `PLUGIN_CATEGORIES` (plan §4.1:335–337); no existing capability, category,
 * contract or plugin changes, and a plugin that never declares
 * `identity-provider` compiles and behaves exactly as before.
 *
 * ## Who calls this
 *
 * `IdentityProviderFacadeService` resolves the plugin by capability and passes
 * every method through (plan §4.4:470–476), so no plugin id appears outside the
 * plugin. The facade — never the caller — holds the resolved settings, which is
 * why no method below takes a configuration object: a plugin is configured
 * before it is called, and a caller can never hand it a different issuer, client
 * id or secret than the one an administrator saved (FR-7: one issuer set per
 * installation).
 *
 * The seven methods are transcribed verbatim from plan §4.1:340–412 — member
 * names, nullability and parameter lists are the contract — with one deliberate
 * addition: the plan's prose paragraph on the rejection error
 * (§4.1:414–417) is realised here as an exported `const` **and** a class, because
 * a TypeScript union alone cannot be enforced at runtime and the facade has to
 * branch on a code it received from a third-party provider's claims.
 */

import type { IPlugin } from '../plugin.interface.js';
import { PLUGIN_CAPABILITIES } from '../facade-capabilities.js';

/**
 * One row of **Test connection** (plan §4.1:340–351, spec FR-3).
 *
 * The seven ids are the closed set FR-3 names, in its order: the discovery
 * document is read within 5 seconds and each row reports what was found. `ok`
 * is the verdict and `detail` is the one-line explanation an administrator
 * reads — a check that fails carries why it failed, and a check the provider
 * cannot answer (back-channel logout and device authorization are optional in
 * OpenID Connect) reports `ok: false` with `detail` rather than being omitted,
 * so the admin surface has exactly one row per id and never a varying list
 * (plan §6.4).
 *
 * `detail` must never contain token material, a client secret or a raw provider
 * response body (FR-16): it names what was missing, not what was received.
 */
export interface IdentityProviderCheck {
	id:
		| 'discovery'
		| 'issuerMatch'
		| 'endpoints'
		| 'pkceS256'
		| 'signingAlg'
		| 'backchannelLogout'
		| 'deviceAuthorization';
	ok: boolean;
	detail?: string;
}

/**
 * The ID token claims the platform keeps, after every FR-11 rule has passed
 * (plan §4.1:352–360).
 *
 * `email: null` and `emailVerified: false` are distinct states on purpose: an
 * `email` claim that is absent or unusable is `null`, while `emailVerified`
 * reflects the `email_verified` claim exactly — FR-23, FR-24 and FR-25 all
 * branch on the pair, and e-mail never selects an account (FR-22).
 *
 * `authTime` is the `auth_time` claim in seconds since the epoch, or `null` when
 * the provider did not send one; FR-25's connect path needs it to be no older
 * than 300 seconds plus the skew, and `null` there is a refusal rather than a
 * pass. `sid` is the optional session identifier FR-32 stores and FR-34 ends
 * sessions by — the one claim that travels to a row, and only when present.
 */
export interface VerifiedIdTokenClaims {
	issuer: string;
	subject: string;
	email: string | null;
	emailVerified: boolean;
	name: string | null;
	authTime: number | null;
	sid: string | null;
}

/**
 * The access-token claims the local-client exchange (FR-40) and the App
 * Launcher's delegated read (FR-45) branch on (plan §4.1:361–370).
 *
 * `scopes` is the parsed `scope` claim, `authorizedParty` the `azp` claim or
 * `null`, and `issuedAt` / `expiresAt` are seconds since the epoch — the pair
 * FR-45 caps at 3,600 seconds and FR-40 at 300 seconds of age. `jti` is the
 * replay identifier, or `null` when the provider sent none; the caller keeps the
 * 600-second replay window, not the plugin.
 */
export interface VerifiedAccessTokenClaims {
	issuer: string;
	subject: string;
	audience: string[];
	scopes: string[];
	authorizedParty: string | null;
	issuedAt: number;
	expiresAt: number;
	jti: string | null;
}

/**
 * The back-channel logout token's claims, after FR-33's extra rules have passed
 * (plan §4.1:371–376).
 *
 * `subject` and `sid` are both nullable because FR-33 requires **at least one**
 * of them rather than both; `jti` is required, because FR-33's 600-second replay
 * window is keyed on it — a logout token without a `jti` is rejected as
 * `badLogoutEvent` rather than treated as new.
 */
export interface VerifiedLogoutTokenClaims {
	issuer: string;
	subject: string | null;
	sid: string | null;
	jti: string;
}

/**
 * Every reason a provider refuses a token or an exchange (plan §4.1:414–417).
 *
 * Closed and append-only: the facade maps each code onto the platform's own
 * vocabulary (§5.2) and answers `400` with no detail, so a code it does not
 * recognise must degrade to a refusal, never to a pass. The names are the plan's
 * verbatim, including the two that are not about a signature at all —
 * `providerUnavailable` (discovery or the key set could not be reached, which
 * FR-15's single retry precedes) and `missingScope` (a valid token that lacks the
 * scope its caller needs, FR-46).
 */
export const IDENTITY_TOKEN_REJECTION_CODES = [
	'badSignature',
	'badIssuer',
	'badAudience',
	'expired',
	'notYetValid',
	'tooOld',
	'badNonce',
	'badAlg',
	'missingScope',
	'lifetimeTooLong',
	'badAuthorizedParty',
	'badLogoutEvent',
	'nonceInLogoutToken',
	'providerUnavailable'
] as const;

/** Union derived from {@link IDENTITY_TOKEN_REJECTION_CODES}. */
export type IdentityTokenRejectionCode = (typeof IDENTITY_TOKEN_REJECTION_CODES)[number];

/**
 * The single error every `verify*` and `exchange*` method throws (plan §4.1:414).
 *
 * `message` **is the code** and nothing else: FR-16 forbids a token, a code, a
 * verifier or a nonce from reaching a log, an Activity row, an analytics event,
 * an error message or a response, and the cheapest way to keep that promise in a
 * code path that receives raw token text is to have no other string to leak. A
 * provider's own error text, HTTP status or claim dump therefore never becomes
 * the message.
 *
 * Extending `Error` is load-bearing, exactly as it is for
 * `GitProviderRequestError`: callers catch it as an `Error`, and a `code` they do
 * not recognise must degrade to "the token was refused", never to a silently
 * swallowed object.
 */
export class IdentityTokenRejectedError extends Error {
	constructor(readonly code: IdentityTokenRejectionCode) {
		super(code);
		this.name = 'IdentityTokenRejectedError';
	}
}

/**
 * An identity-provider plugin (plan §4.1:377–410).
 *
 * One plugin answers for one installation: FR-7 puts every issuer, client and
 * local-client id in the plugin's own admin-scoped settings, so no method takes
 * an issuer, a client id or a secret — a caller cannot ask a provider to validate
 * against anything but what an administrator configured.
 *
 * The methods fall into four groups, and the spec's own sections:
 *
 * - **configuration** — `testConnection` (FR-3) and `getPublicConfig` (FR-2's
 *   non-secret projection: issuer, display name, local-client ids, API audience
 *   and whether sign-up is offered; never the secret, FR-16);
 * - **sign-in** — `buildAuthorizationRequest` (FR-8's PKCE S256, FR-9's fresh
 *   `state` / `nonce` / 64-character verifier, FR-10's redirect address) and
 *   `exchangeAuthorizationCode` (FR-11's acceptance rules, FR-12's `iss`
 *   equality, FR-19's single completion);
 * - **token verification** — `verifyAccessToken` (FR-40's local-client exchange
 *   and FR-45's delegated read, including `maxAgeSeconds`, `requiredScopes`,
 *   `maxLifetimeSeconds` and the `azp` allow-list) and `verifyLogoutToken`
 *   (FR-33's back-channel notice);
 * - **sign-out** — `buildEndSessionUrl` (FR-36), which answers `null` when the
 *   provider publishes no end-session endpoint rather than inventing a URL.
 *
 * Every method that verifies anything throws {@link IdentityTokenRejectedError};
 * `null` is never a refusal. `buildEndSessionUrl`'s `null` is the one
 * non-throwing "nothing to do" answer, and it means "this provider has no
 * end-session endpoint", not "the call failed".
 */
export interface IIdentityProviderPlugin extends IPlugin {
	testConnection(): Promise<IdentityProviderCheck[]>;
	getPublicConfig(): Promise<{
		issuer: string;
		displayName: string;
		localClients: Array<{ kind: 'cli' | 'node'; clientId: string }>;
		apiAudience: string;
		signUpAllowed: boolean;
	}>;
	buildAuthorizationRequest(input: {
		redirectUri: string;
		prompt?: 'login';
		maxAgeSeconds?: number;
	}): Promise<{ url: string; state: string; nonce: string; codeVerifier: string }>;
	exchangeAuthorizationCode(input: {
		code: string;
		redirectUri: string;
		codeVerifier: string;
		expectedNonce: string;
		receivedIssuer?: string;
		maxAuthAgeSeconds?: number;
	}): Promise<VerifiedIdTokenClaims>;
	verifyAccessToken(
		token: string,
		input: {
			requiredScopes: string[];
			maxLifetimeSeconds: number;
			maxAgeSeconds?: number;
			allowedAuthorizedParties?: string[];
		}
	): Promise<VerifiedAccessTokenClaims>;
	verifyLogoutToken(token: string): Promise<VerifiedLogoutTokenClaims>;
	buildEndSessionUrl(input: { postLogoutRedirectUri: string; state: string }): Promise<string | null>;
}

/**
 * Is this plugin an identity provider? (plan §4.1:411)
 *
 * The capability is checked on the plugin's own `capabilities` array — through
 * `PLUGIN_CAPABILITIES.IDENTITY_PROVIDER`, so the guard and the resolution
 * `IdentityProviderFacadeService` performs cannot disagree — and then the
 * **methods** are checked as functions, because a manifest can claim a capability
 * its implementation does not have and the lazy-plugin proxy over-reports
 * optional members. All seven are checked: plan §4.1 makes none of them optional,
 * so a plugin missing one cannot serve a caller, and the honest answer for it is
 * "not an identity provider" rather than a call that fails later, half-way
 * through a sign-in.
 *
 * That is not hypothetical. `packages/plugins/oidc-identity` (APW-12 T5) declares
 * `category: 'identity'` and `capabilities: ['identity-provider']` with **no**
 * method implemented on purpose — nothing may pretend to answer Test connection
 * before T6 writes the real flow — so this guard answering `false` for it is what
 * keeps the facade fail-closed in the window between T4 and T6.
 */
export function isIdentityProviderPlugin(plugin: IPlugin): plugin is IIdentityProviderPlugin {
	if (!plugin || !Array.isArray(plugin.capabilities)) return false;
	if (!plugin.capabilities.includes(PLUGIN_CAPABILITIES.IDENTITY_PROVIDER)) return false;
	const candidate = plugin as Partial<IIdentityProviderPlugin>;
	return (
		typeof candidate.testConnection === 'function' &&
		typeof candidate.getPublicConfig === 'function' &&
		typeof candidate.buildAuthorizationRequest === 'function' &&
		typeof candidate.exchangeAuthorizationCode === 'function' &&
		typeof candidate.verifyAccessToken === 'function' &&
		typeof candidate.verifyLogoutToken === 'function' &&
		typeof candidate.buildEndSessionUrl === 'function'
	);
}
