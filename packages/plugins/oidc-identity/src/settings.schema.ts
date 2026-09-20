import type { JsonSchema } from '@ever-works/plugin';

/**
 * APW-12 T5 — the `oidc-identity` plugin settings (plan §4.2, setting key by
 * setting key; spec FR-2 holds the same list in prose).
 *
 * Every constraint below is transcribed from plan §4.2's table — the same
 * numbers as `EVER_ID_LIMITS` in `packages/contracts/src/apps/ever-id.ts`,
 * which plan §4.3 makes the single source for the *runtime* checks. Nothing is
 * invented here: no key, bound, default or requirement appears that the table
 * does not state, so a tightening of the schema cannot silently refuse a
 * configuration the plan allows.
 *
 * Three properties of this schema are load-bearing, and are pinned by
 * `src/__tests__/settings.schema.spec.ts` rather than asserted in prose here:
 *
 *   - **`clientSecret` is `x-secret`** (Constitution VII, spec FR-16 / ACC-12-03).
 *     The marker is the only thing that makes the platform treat the value as a
 *     secret: `packages/plugin/src/api/api-response.types.ts:129` turns it into
 *     `secret: true` on the descriptor every API response is built from, and
 *     `packages/agent/src/plugins/services/plugin-operations.service.ts:1792`
 *     and `:1932` mask exactly those fields. Drop the marker and the secret
 *     becomes an ordinary setting, readable back out of the settings API.
 *   - **every key is `x-scope: 'global'`** (plan §4.2, FR-7). One issuer set per
 *     installation, configured by a platform admin: the schema is admin-tier, so
 *     `SettingsSchemaValidatorService.filterSchemaByScope`
 *     (`packages/agent/src/plugins/services/settings-schema-validator.service.ts:247`)
 *     never offers these keys to a user- or work-scoped read or write.
 *   - **the issuer rule is split across schema and runtime.** JSON Schema is
 *     static, so the schema carries the half that does not depend on the
 *     environment — `https` anywhere, `http` only for `localhost`/`127.0.0.1` —
 *     while the plan's remaining half (`http` is refused outside development)
 *     is a `NODE_ENV` check.
 *
 *     **That runtime half now exists** (2026-09-21), in
 *     `oidc-identity.plugin.ts`: `allowsInsecureIssuer` is an allow-list of
 *     `development` / `test`, applied in `resolveSettings` (the chokepoint every
 *     public method goes through, so a refused issuer refuses discovery, the key
 *     fetch, the code exchange, both verifiers and `testConnection` together) and
 *     again where `allowInsecureRequests` is called. Until then the sentence above
 *     said T6 owned the check, T6 never wrote it, and a comment at the
 *     `allowInsecureRequests` call site asserted the gate as though it were in
 *     place — which is what kept it unnoticed. Do not restate a gate here without
 *     naming the function that enforces it.
 */

/**
 * `https://…`, or `http://localhost…` / `http://127.0.0.1…` with an optional
 * port and path (plan §4.2 `issuerUrl`, spec FR-2). Anything else is refused by
 * the settings validator before it is ever persisted.
 */
export const oidcIdentityIssuerUrlPattern =
	'^(https://[^\\s]+|http://(localhost|127\\.0\\.0\\.1)(:\\d{1,5})?(/[^\\s]*)?)$';

/** `https://…` only — the **Manage in Ever ID ↗** target (plan §4.2). */
export const oidcIdentityHttpsUrlPattern = '^https://[^\\s]+$';

/** One local client allowed to exchange an Ever ID token for a session (FR-39). */
export interface OidcIdentityLocalClient {
	kind: 'cli' | 'node';
	clientId: string;
}

/** A remembered delegated client and the name the card shows it under (FR-48). */
export interface OidcIdentityDelegatedClientName {
	clientId: string;
	displayName?: string;
}

/**
 * Platform-written availability state (plan §4.2, §9.2). Stored in the plugin's
 * own settings row so every replica reads the same state — a re-test on one
 * replica clears the flag on all of them (FR-5). Never user-writable: the
 * property is `x-hidden`.
 */
export interface OidcIdentityAvailability {
	unavailableSince?: string;
	discoveryRefreshedAt?: string;
	jwksRefreshedAt?: string;
	lastLogoutNoticeAt?: string;
}

/** The settings this plugin reads once resolved (plan §4.2). */
export interface OidcIdentitySettings {
	issuerUrl: string;
	clientId: string;
	clientSecret: string;
	allowedIssuers?: string[];
	apiAudience?: string;
	localClients?: OidcIdentityLocalClient[];
	delegatedClientNames?: OidcIdentityDelegatedClientName[];
	accountManagementUrl?: string;
	signUpAllowed?: boolean;
	clockSkewSeconds?: number;
	displayName?: string;
	availability?: OidcIdentityAvailability;
}

/** Every top-level key of plan §4.2, in the table's own order. */
export const OIDC_IDENTITY_SETTING_KEYS = [
	'issuerUrl',
	'clientId',
	'clientSecret',
	'allowedIssuers',
	'apiAudience',
	'localClients',
	'delegatedClientNames',
	'accountManagementUrl',
	'signUpAllowed',
	'clockSkewSeconds',
	'displayName',
	'availability'
] as const;

/** Union of {@link OIDC_IDENTITY_SETTING_KEYS}. */
export type OidcIdentitySettingKey = (typeof OIDC_IDENTITY_SETTING_KEYS)[number];

export const oidcIdentitySettingsSchema: JsonSchema = {
	type: 'object',
	title: 'Ever ID',
	description:
		'OpenID Connect relying-party configuration for Ever ID. One issuer set per installation: browser sign-in, connected identities and delegated reads all use it (FR-2, FR-7).',
	properties: {
		issuerUrl: {
			type: 'string',
			title: 'Issuer address',
			description:
				'The provider issuer, e.g. https://auth.ever.co. Must be https; http is accepted only for localhost and is refused outside development (FR-2). Register exactly one redirect address at the provider (FR-10).',
			pattern: oidcIdentityIssuerUrlPattern,
			'x-envVar': 'EVER_ID_ISSUER_URL',
			'x-scope': 'global'
		},
		clientId: {
			type: 'string',
			title: 'Client ID',
			description: 'The relying-party client identifier Ever ID issued to this installation (FR-2).',
			maxLength: 255,
			'x-envVar': 'EVER_ID_CLIENT_ID',
			'x-scope': 'global'
		},
		clientSecret: {
			type: 'string',
			title: 'Client secret',
			description:
				'The client secret used with client_secret_basic. Write-only: never returned by any response, log, Activity row or telemetry payload (FR-16, ACC-12-03).',
			'x-secret': true,
			'x-envVar': 'EVER_ID_CLIENT_SECRET',
			'x-scope': 'global'
		},
		allowedIssuers: {
			type: 'array',
			title: 'Allowed issuers',
			description:
				'1–3 exact issuer strings accepted at once, so a planned provider move stays reversible. Defaults to the configured issuer address when unset (FR-2, FR-14).',
			items: { type: 'string' },
			minItems: 1,
			maxItems: 3,
			'x-envVar': 'EVER_ID_ALLOWED_ISSUERS',
			'x-scope': 'global'
		},
		apiAudience: {
			type: 'string',
			title: 'API audience',
			description:
				'The audience a delegated or exchanged access token must contain (FR-40, FR-45). Defaults to ever-works.',
			maxLength: 255,
			default: 'ever-works',
			'x-envVar': 'EVER_ID_API_AUDIENCE',
			'x-scope': 'global'
		},
		localClients: {
			type: 'array',
			title: 'Local clients',
			description:
				'Public clients (CLI, node) allowed to exchange an Ever ID access token for an Ever Works session, at most 5 (FR-2, FR-39, FR-40).',
			items: {
				type: 'object',
				properties: {
					kind: {
						type: 'string',
						title: 'Client kind',
						description: 'Which local client this entry configures.',
						enum: ['cli', 'node']
					},
					clientId: {
						type: 'string',
						title: 'Client ID',
						description: 'The public client identifier registered at the provider.'
					}
				},
				required: ['kind', 'clientId']
			},
			maxItems: 5,
			default: [],
			'x-scope': 'global'
		},
		delegatedClientNames: {
			type: 'array',
			title: 'Delegated client names',
			description:
				'The names the Connected identities card shows for apps that used a delegated read, at most 10 (FR-48). A client id with no name here is shown as the client id itself.',
			items: {
				type: 'object',
				properties: {
					clientId: {
						type: 'string',
						title: 'Client ID',
						maxLength: 255
					},
					displayName: {
						type: 'string',
						title: 'Display name',
						maxLength: 60
					}
				},
				required: ['clientId']
			},
			maxItems: 10,
			default: [],
			'x-scope': 'global'
		},
		accountManagementUrl: {
			type: 'string',
			title: 'Account management address',
			description:
				'The target of the Manage in Ever ID link on the Connected identities card (FR-48). Must be https; when unset the link is hidden.',
			pattern: oidcIdentityHttpsUrlPattern,
			'x-scope': 'global'
		},
		signUpAllowed: {
			type: 'boolean',
			title: 'Allow sign-up with Ever ID',
			description:
				'Whether an unknown, verified Ever ID identity may create an account (FR-2, FR-23). Defaults to on.',
			default: true,
			'x-envVar': 'EVER_ID_SIGN_UP_ALLOWED',
			'x-scope': 'global'
		},
		clockSkewSeconds: {
			type: 'integer',
			title: 'Clock skew tolerance (seconds)',
			description: 'Tolerance applied to every token time check, 0–120 seconds (FR-2, FR-11). Defaults to 60.',
			minimum: 0,
			maximum: 120,
			default: 60,
			'x-envVar': 'EVER_ID_CLOCK_SKEW_SECONDS',
			'x-scope': 'global'
		},
		displayName: {
			type: 'string',
			title: 'Display name',
			description: 'The button and heading label, at most 40 characters (FR-2). Defaults to Ever ID.',
			maxLength: 40,
			default: 'Ever ID',
			'x-scope': 'global'
		},
		availability: {
			type: 'object',
			title: 'Availability',
			description:
				'Platform-written availability state: when the provider was last seen unavailable and when discovery, the key set and the last sign-out notice were refreshed. Not user-writable; stored so every replica agrees within 60 seconds (FR-5, plan §9.2).',
			properties: {
				unavailableSince: {
					type: 'string',
					description: 'Set when Test connection fails; cleared by the next passing run (FR-3, FR-5).',
					format: 'date-time'
				},
				discoveryRefreshedAt: {
					type: 'string',
					description: 'When the discovery document was last fetched successfully (FR-14).',
					format: 'date-time'
				},
				jwksRefreshedAt: {
					type: 'string',
					description: 'When the provider key set was last fetched successfully (FR-13).',
					format: 'date-time'
				},
				lastLogoutNoticeAt: {
					type: 'string',
					description: 'When the last back-channel logout notice was accepted (FR-33).',
					format: 'date-time'
				}
			},
			'x-hidden': true,
			'x-scope': 'global'
		}
	},
	required: ['issuerUrl', 'clientId', 'clientSecret']
};
