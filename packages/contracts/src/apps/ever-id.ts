/**
 * App Works — the Ever ID model: the cross-platform SSO layer's shared
 * constants, provider configuration, identity shape and error vocabulary.
 *
 * Owning epic: **APW-12** (Ever ID).
 *
 * Spec: `docs/specs/features/app-works/APW-12-ever-id/spec.md`
 * Plan: `docs/specs/features/app-works/APW-12-ever-id/plan.md` §3.5 (shared
 * types), §4.1, §5.1-§5.3
 * Decision record: `APW-12-ever-id/idp-options.md` §6.1, §7
 * Bindings: `CONTRACTS.md` §0 (R-19 authMethod, R-28 provider/domain/posture),
 * §7, §12 (error codes are snake_case on the wire).
 *
 * The integration is **pure addition** (R-28, idp-options.md:233-239): every
 * platform keeps its own authentication and its own user database, Ever Works
 * keeps Better Auth, and nothing here replaces, deprecates or routes away a
 * method that works today. `AuthenticatedUser.authMethod` already exists
 * (`'session' | 'api-key'`, shipped by AW-24); this file adds the ONE value
 * APW-12 appends and no new field.
 *
 * No token, secret or host is ever stored in this file: the issuer address is
 * configuration (FR-2), and the only production value the programme fixes for it
 * lives in the decision record, not in shared types.
 */

// ---------------------------------------------------------------------------
// Vocabulary (plan.md:253-255, spec.md §4.6)
// ---------------------------------------------------------------------------

/** The `registrationProvider` an account created through Ever ID records (plan.md:519). */
export const EVER_ID_REGISTRATION_PROVIDER = 'ever-id';

/**
 * The two OAuth scopes Ever Works asks for (plan.md:254, idp-options.md:203).
 *
 * `APPS_READ` is the delegated-read scope another Ever platform presents to read
 * a person's App Works; `SESSION_EXCHANGE` is what a local client (CLI, node)
 * exchanges for an Ever Works session and is never a delegated read.
 */
export const EVER_ID_SCOPES = { APPS_READ: 'apps:read', SESSION_EXCHANGE: 'ever-works:session' } as const;

/** The audience an API token must contain (plan.md:255, spec.md:284-286). */
export const EVER_ID_DEFAULT_API_AUDIENCE = 'ever-works';

/** The display name shown when the administrator configures none (FR-2, spec.md:182). */
export const EVER_ID_DEFAULT_DISPLAY_NAME = 'Ever ID';

/**
 * The signing algorithms an ID token may use (FR-11, spec.md:207).
 *
 * One of these must also appear in the provider's discovery document, or **Test
 * connection** fails (FR-3).
 */
export const EVER_ID_SIGNING_ALGS = ['RS256', 'ES256', 'EdDSA'] as const;

/** Union derived from {@link EVER_ID_SIGNING_ALGS}. */
export type EverIdSigningAlg = (typeof EVER_ID_SIGNING_ALGS)[number];

/**
 * The query keys a token may never arrive in (FR-17, spec.md:223-224,
 * plan.md:526-527).
 *
 * Any Ever ID endpoint, and any endpoint accepting a delegated permission,
 * refuses a request carrying one of these with `400`. Shared so the guard, the
 * controller and the web client all read one list.
 */
export const EVER_ID_QUERY_TOKEN_PARAMS = [
	'access_token',
	'id_token',
	'logout_token',
	'token',
	'sessionToken',
	'code_verifier'
] as const;

/** Union derived from {@link EVER_ID_QUERY_TOKEN_PARAMS}. */
export type EverIdQueryTokenParam = (typeof EVER_ID_QUERY_TOKEN_PARAMS)[number];

/**
 * The scopes a route may be marked `@DelegatedRead(scope)` for (R-19,
 * CONTRACTS.md:62; APW-12 plan.md:14, spec.md:296-297).
 *
 * Exactly one member today, and deliberately separate from
 * {@link EVER_ID_SCOPES}: `ever-works:session` is a local-client exchange scope
 * and must never open a delegated read (FR-47).
 */
export const EVER_ID_DELEGATED_SCOPES = ['apps:read'] as const;

/** Union derived from {@link EVER_ID_DELEGATED_SCOPES}. */
export type EverIdDelegatedScope = (typeof EVER_ID_DELEGATED_SCOPES)[number];

/**
 * The ONE value APW-12 appends to the existing
 * `AuthenticatedUser.authMethod` union (R-19, CONTRACTS.md:62; plan.md:559-562).
 *
 * A delegated principal is admitted only on handlers carrying
 * `@DelegatedRead(scope)`; everywhere else it is answered exactly like an
 * invalid credential. `'session'` and `'api-key'` keep their meaning and their
 * stamps, and `@HumanOnly()` keeps refusing anything that is not `'session'`.
 */
export const EVER_ID_DELEGATED_AUTH_METHOD = 'ever-id-delegated';

/** The appended `authMethod` value as a type. */
export type EverIdDelegatedAuthMethod = typeof EVER_ID_DELEGATED_AUTH_METHOD;

/** How a connected identity came to exist (plan.md:190, FR-31). */
export const EVER_ID_LINKED_VIA = ['sign-up', 'settings'] as const;

/** Union derived from {@link EVER_ID_LINKED_VIA}. */
export type EverIdLinkedVia = (typeof EVER_ID_LINKED_VIA)[number];

// ---------------------------------------------------------------------------
// Limits (plan.md:256-286 — the single validation source of APW-12 §4.3)
// ---------------------------------------------------------------------------

/**
 * Every bound the protocol layer validates against (plan.md:256-286, §4.3
 * "single source: `EVER_ID_LIMITS`").
 *
 * Each number traces to a requirement: FR-9 (state/nonce/verifier/transaction),
 * FR-23 (sign-up pending), FR-26 (connect pending), FR-25 (fresh auth and
 * session age), FR-2 (clock skew), FR-13 (key cache and staleness), FR-14
 * (discovery cache), FR-15 (outbound timeout), FR-33 (logout token and replay
 * window), FR-40 (exchange token age), FR-45 (delegated token lifetime), FR-31
 * and FR-48 (the ≤ 10 delegated clients and their 30-day window), FR-5
 * (availability cache) and FR-41 (device polling).
 */
export const EVER_ID_LIMITS = {
	/** FR-9 — fresh random bytes per sign-in. */
	stateBytes: 32,
	/** FR-9 — fresh random bytes per sign-in. */
	nonceBytes: 32,
	/** FR-9 — the PKCE code verifier is 64 characters. */
	codeVerifierLength: 64,
	/** FR-9 — the transaction cookie lives 600 seconds. */
	transactionTtlSeconds: 600,
	/** FR-23 — a pending account creation expires after 600 seconds and is single-use. */
	signUpPendingTtlSeconds: 600,
	/** FR-26 — a pending connection expires after 300 seconds and is single-use. */
	connectPendingTtlSeconds: 300,
	/** FR-11 — `iat` may be no earlier than 600 seconds ago. */
	idTokenMaxAgeSeconds: 600,
	/** FR-25 — `auth_time` no older than 300 seconds plus the skew. */
	connectMaxAuthAgeSeconds: 300,
	/** FR-25 — connecting needs a session opened at most 12 hours ago. */
	connectMaxSessionAgeSeconds: 43_200,
	/** FR-2 — the default clock-skew tolerance. */
	defaultClockSkewSeconds: 60,
	/** FR-2 — the highest clock-skew tolerance an administrator may configure. */
	maxClockSkewSeconds: 120,
	/** FR-13 — signing keys are cached for 600 seconds. */
	jwksCacheSeconds: 600,
	/** FR-13 — an unknown key id triggers at most one refresh per 30 seconds. */
	jwksUnknownKidCooldownSeconds: 30,
	/** FR-13 — cached keys stay usable for at most 21 600 seconds, then validation fails closed. */
	jwksMaxStaleSeconds: 21_600,
	/** FR-14 — the discovery document is cached for 3 600 seconds. */
	discoveryCacheSeconds: 3_600,
	/** FR-15 — calls to the provider time out after 5 seconds. */
	outboundTimeoutMs: 5_000,
	/** FR-33 — a sign-out notice's `iat` may be no older than 300 seconds. */
	logoutTokenMaxAgeSeconds: 300,
	/** FR-33 — a `jti` not seen in the last 600 seconds. */
	replayWindowSeconds: 600,
	/** FR-40 — an exchange token's `iat` may be no older than 300 seconds. */
	exchangeTokenMaxAgeSeconds: 300,
	/** FR-45 — a delegated token's lifetime (`exp` − `iat`) is at most 3 600 seconds. */
	delegatedTokenMaxLifetimeSeconds: 3_600,
	/** FR-2 — 1–3 allowed issuers, so a provider move stays reversible (R-28). */
	allowedIssuersMax: 3,
	/** FR-2 — 0–5 local-client ids allowed to exchange for a session. */
	localClientsMax: 5,
	/** FR-31/FR-48 — at most 10 apps whose delegated reads are remembered. */
	delegatedClientsMax: 10,
	/** FR-48 — the Connected identities card lists apps seen in the last 30 days. */
	delegatedClientsWindowDays: 30,
	/** FR-5 — the availability answer is cached for 60 seconds. */
	availabilityCacheSeconds: 60,
	/** FR-31 — the names kept per delegated client. */
	delegatedClientNamesMax: 10,
	/** FR-41 — clients poll no faster than the interval the provider returns, at least 5 seconds. */
	devicePollMinIntervalSeconds: 5,
	/** FR-41 — add 5 seconds on every `slow_down`. */
	devicePollSlowDownStepSeconds: 5,
	/** FR-41 — a device code expires in at most 900 seconds. */
	deviceCodeMaxLifetimeSeconds: 900
} as const;

/** Union of the keys of {@link EVER_ID_LIMITS}. */
export type EverIdLimitKey = keyof typeof EVER_ID_LIMITS;

/**
 * Whether a configured clock-skew tolerance is accepted (FR-2: 0–120 s).
 *
 * Fails closed: a missing, negative, fractional or oversized value is refused
 * rather than clamped silently.
 */
export function isEverIdClockSkewAllowed(seconds: number): boolean {
	return Number.isInteger(seconds) && seconds >= 0 && seconds <= EVER_ID_LIMITS.maxClockSkewSeconds;
}

/**
 * Whether an allowed-issuer list is accepted (FR-2: 1–3 exact strings).
 *
 * Fails closed: an empty list would disable sign-in silently and a longer one
 * would break the reversibility R-28 depends on.
 */
export function isEverIdAllowedIssuerCountAllowed(count: number): boolean {
	return Number.isInteger(count) && count >= 1 && count <= EVER_ID_LIMITS.allowedIssuersMax;
}

// ---------------------------------------------------------------------------
// Relying-party configuration (FR-2, FR-3, FR-6; plan.md:486-499)
// ---------------------------------------------------------------------------

/**
 * What an administrator configures for the identity provider (FR-2,
 * spec.md:179-182).
 *
 * `clientSecret` is write-only: it travels one way and is never returned —
 * **Test connection** reports every check without it (FR-3).
 */
export interface EverIdProviderConfig {
	/** The issuer address; `https`, or `http` only for localhost outside production. */
	issuer: string;
	clientId: string;
	/** Write-only. Never echoed by any read or log (FR-16). */
	clientSecret?: string;
	/** 1–3 issuer strings accepted at once, so two providers can run side by side. */
	allowedIssuers: string[];
	/** Defaults to {@link EVER_ID_DEFAULT_API_AUDIENCE}. */
	apiAudience: string;
	/** 0–{@link EVER_ID_LIMITS.localClientsMax} ids allowed to exchange for a session. */
	localClientIds: string[];
	/** Default on (FR-2). */
	signUpAllowed: boolean;
	/** 0–{@link EVER_ID_LIMITS.maxClockSkewSeconds} seconds; default 60. */
	clockSkewSeconds: number;
	/** Default {@link EVER_ID_DEFAULT_DISPLAY_NAME}. */
	displayName: string;
}

/** One local client allowed to exchange an Ever ID token for a session (plan.md:382, FR-39). */
export interface EverIdLocalClient {
	kind: 'cli' | 'node';
	clientId: string;
}

/**
 * The public client configuration (plan.md:497 — `GET /client-config`).
 *
 * Public because a local client needs it before it can sign in, and it carries
 * no secret: the issuer, the local clients and the scopes only.
 */
export interface EverIdClientConfig {
	issuer: string;
	localClients: EverIdLocalClient[];
	scopes: string[];
}

/**
 * The additive availability field the existing providers list gains
 * (FR-6, plan.md:486).
 *
 * Additive on purpose: every existing sign-in method, route and response is
 * unchanged whether Ever ID is on or off, and this is the one new field the web
 * app reads.
 */
export interface EverIdAvailability {
	enabled: boolean;
	displayName: string;
}

// ---------------------------------------------------------------------------
// Identity (FR-21, FR-31; plan.md:180-195)
// ---------------------------------------------------------------------------

/** One app that used a delegated read, with when it was last seen (FR-31, FR-48). */
export interface EverIdDelegatedClient {
	clientId: string;
	/** ISO timestamp of the last delegated read by this client. */
	lastSeenAt: string;
}

/**
 * A connected identity — the pair (issuer, subject) and nothing else (FR-21,
 * FR-31; the entity is `ExternalIdentity`, plan.md:180-199).
 *
 * The pair, never the e-mail, selects an account (FR-22), and **no Ever ID token
 * is stored** — only what FR-31 lists. A disconnect removes the row and never
 * deletes an account (FR-30).
 */
export interface EverIdConnectedIdentity {
	issuer: string;
	subject: string;
	/** Display only; never used to resolve an account (plan.md:188). */
	emailAtLink: string;
	emailVerifiedAtLink: boolean;
	linkedVia: EverIdLinkedVia;
	linkedAt: string;
	lastLoginAt?: string;
	/** At most {@link EVER_ID_LIMITS.delegatedClientsMax} entries, oldest evicted. */
	delegatedClients?: EverIdDelegatedClient[];
}

// ---------------------------------------------------------------------------
// Error vocabulary (plan.md:288-304 against CONTRACTS.md §12)
// ---------------------------------------------------------------------------

/**
 * The plan's member names for every situation Ever ID answers (plan.md:288-304).
 *
 * These are the **web i18n leaf names and the TypeScript member names**, kept
 * verbatim because a rename would remove a name other code already uses (R-26).
 * The wire values are {@link EVER_ID_WIRE_ERROR_CODES}: CONTRACTS.md §12 fixes
 * error codes as snake_case and keeps the camelCase form "only as the web i18n
 * leaf" (CONTRACTS.md:762-766, 792-795), so the two spellings coexist and
 * {@link EVER_ID_ERROR_CODE_WIRE_VALUES} is the one mapping between them.
 */
export type EverIdErrorCode =
	| 'everIdDisabled'
	| 'providerUnavailable'
	| 'transactionInvalid'
	| 'emailNotVerified'
	| 'emailInUse'
	| 'signUpNotAllowed'
	| 'subjectLinked'
	| 'userHasIssuer'
	| 'reauthRequired'
	| 'sessionRequired'
	| 'lastSignInMethod'
	| 'notConnected'
	| 'accountDisabled'
	| 'everIdSignedOut'
	| 'tokenInQuery'
	| 'insufficientScope';

/**
 * The snake_case wire codes.
 *
 * Four are registered by CONTRACTS.md §12 (`ever_id_disabled` 404,
 * `transaction_invalid` 400, `token_in_query` 400, `ever_id_signed_out` 401);
 * `insufficient_scope` belongs to APW-11's delegated read (CONTRACTS.md:555);
 * the rest are the situations of the APW-12 §5.2 error contract, spelled by the
 * §12 rule. Append-only, like every other error code.
 */
export const EVER_ID_WIRE_ERROR_CODES = [
	'ever_id_disabled',
	'provider_unavailable',
	'transaction_invalid',
	'email_not_verified',
	'email_in_use',
	'sign_up_not_allowed',
	'subject_linked',
	'user_has_issuer',
	'reauth_required',
	'session_required',
	'last_sign_in_method',
	'not_connected',
	'account_disabled',
	'ever_id_signed_out',
	'token_in_query',
	'insufficient_scope'
] as const;

/** Union derived from {@link EVER_ID_WIRE_ERROR_CODES}. */
export type EverIdWireErrorCode = (typeof EVER_ID_WIRE_ERROR_CODES)[number];

/**
 * Member → wire value, one to one.
 *
 * Total on purpose: an untyped `string` error body cannot be translated by the
 * web map, so every situation the API can answer has exactly one wire code.
 */
export const EVER_ID_ERROR_CODE_WIRE_VALUES: Readonly<Record<EverIdErrorCode, EverIdWireErrorCode>> = {
	everIdDisabled: 'ever_id_disabled',
	providerUnavailable: 'provider_unavailable',
	transactionInvalid: 'transaction_invalid',
	emailNotVerified: 'email_not_verified',
	emailInUse: 'email_in_use',
	signUpNotAllowed: 'sign_up_not_allowed',
	subjectLinked: 'subject_linked',
	userHasIssuer: 'user_has_issuer',
	reauthRequired: 'reauth_required',
	sessionRequired: 'session_required',
	lastSignInMethod: 'last_sign_in_method',
	notConnected: 'not_connected',
	accountDisabled: 'account_disabled',
	everIdSignedOut: 'ever_id_signed_out',
	tokenInQuery: 'token_in_query',
	insufficientScope: 'insufficient_scope'
};

/**
 * What the browser is told when it comes back from the provider (plan.md:305-309).
 *
 * A discriminated union so a caller cannot read `identity` off a `signedIn`
 * outcome. `emailInUse` carries the address only because the person just proved
 * control of it at the provider with `email_verified: true` — and it travels
 * inside the sealed `pending` value too, so the account-exists page reads it from
 * the cookie rather than from the query string.
 */
export type EverIdCallbackOutcome =
	| { outcome: 'signedIn'; access_token: string; user: { id: string; email: string | null; username: string } }
	| { outcome: 'confirmSignUp'; pending: string; identity: { email: string; name: string | null } }
	| { outcome: 'confirmConnect'; pending: string; identity: { email: string }; accountEmail: string }
	| { outcome: 'emailInUse'; email: string; pending: string };
