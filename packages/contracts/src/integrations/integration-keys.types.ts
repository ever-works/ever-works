/**
 * EW-P1-2 — integration API keys and the integration principal.
 *
 * Spec: `docs/specs/features/integration-keys/spec.md` (plan doc 02 §2–3 of the
 * Gauzy ↔ Ever Works integration). One vocabulary for the API (the key
 * validator, the `@RequireScopes` guard), the web settings dialog and the
 * integration contract (`docs/specs/features/integrations-api-v1/`).
 *
 * An integration key (`ew_int_…`) is a third `api_keys.kind`. Unlike a personal
 * `ew_live_` key it does NOT act as its creator on every route: it is pinned to
 * one or more Organizations of the creator's Tenant, it carries scopes, it may
 * reach only routes that declare `@RequireScopes(...)`, and it can never manage
 * keys, accounts, security, billing or Ever ID.
 */

/** The `api_keys.kind` discriminator of an integration key. */
export const INTEGRATION_API_KEY_KIND = 'integration';

/**
 * Prefix of the raw secret. 7 characters + 4 hex characters = 11, inside the
 * 12-character `api_keys.prefix` fingerprint budget shared with `ew_live_` and
 * `ew_run_`. Never a prefix of either, and neither is a prefix of it.
 */
export const INTEGRATION_KEY_PREFIX = 'ew_int_';

/** Integration keys a Tenant may hold at once (personal keys keep their own cap of 10). */
export const INTEGRATION_KEYS_MAX_PER_TENANT = 20;

/** Organizations one key may be pinned to. */
export const INTEGRATION_KEY_MAX_ORGANIZATIONS = 50;

/** Default grace period during which a rotated key's previous secret still works. */
export const API_KEY_ROTATION_DEFAULT_GRACE_HOURS = 24;

/** Upper bound for the grace period a caller may ask for on rotation (7 days). */
export const API_KEY_ROTATION_MAX_GRACE_HOURS = 168;

/** Integration-principal throttle tier defaults (per key, per minute). */
export const INTEGRATION_THROTTLE_DEFAULT_WRITES_PER_MIN = 600;
export const INTEGRATION_THROTTLE_DEFAULT_READS_PER_MIN = 3000;

/** Who the key is for. Drives labels ("Ever Gauzy (<key name>)") and presets. */
export const INTEGRATION_KINDS = ['ever-gauzy', 'generic'] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/**
 * Scope vocabulary v1 (plan doc 02 §3). `goals:activate`, `missions:activate`
 * and `ideas:build` are deliberately absent: they are never grantable to an
 * integration key (spend safety, decision D9).
 */
export const INTEGRATION_SCOPES = [
	'org:read',
	'org:write',
	'members:read',
	'members:write',
	'agents:read',
	'teams:read',
	'teams:write',
	'works:read',
	'works:write',
	'missions:read',
	'missions:write',
	'goals:read',
	'goals:write',
	'ideas:read',
	'ideas:write',
	'tasks:read',
	'tasks:write',
	'inbox:read',
	'inbox:write',
	'kb:read',
	'kb:write',
	'email:read',
	'email:write',
	'events:read',
	'webhooks:manage',
	'links:write'
] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];

/** Scopes that are opt-in even under the "Ever Gauzy" preset. */
export const INTEGRATION_OPT_IN_SCOPES: readonly IntegrationScope[] = ['org:write', 'email:write'];

/** The "Ever Gauzy" preset: every v1 scope except the opt-in ones. */
export const EVER_GAUZY_PRESET_SCOPES: readonly IntegrationScope[] = INTEGRATION_SCOPES.filter(
	(scope) => !INTEGRATION_OPT_IN_SCOPES.includes(scope)
);

/** Presets the settings dialog offers (deep link `?new=integration&preset=<id>`). */
export const INTEGRATION_KEY_PRESETS = {
	'ever-gauzy': {
		integrationKind: 'ever-gauzy',
		scopes: EVER_GAUZY_PRESET_SCOPES
	}
} as const satisfies Record<string, { integrationKind: IntegrationKind; scopes: readonly IntegrationScope[] }>;
export type IntegrationKeyPresetId = keyof typeof INTEGRATION_KEY_PRESETS;

/** True when `value` is a v1 scope. */
export function isIntegrationScope(value: unknown): value is IntegrationScope {
	return typeof value === 'string' && (INTEGRATION_SCOPES as readonly string[]).includes(value);
}

/** True when `value` is a known integration kind. */
export function isIntegrationKind(value: unknown): value is IntegrationKind {
	return typeof value === 'string' && (INTEGRATION_KINDS as readonly string[]).includes(value);
}

/**
 * The display label written as `activity_log.actorLabel` for an integration
 * write and shown wherever a record says who made it.
 */
export function integrationActorLabel(integrationKind: string | null | undefined, keyName: string): string {
	const product = integrationKind === 'ever-gauzy' ? 'Ever Gauzy' : 'Integration';
	return `${product} (${keyName})`.slice(0, 120);
}

/** Request headers the integration principal understands (contract v1 B.1). */
export const INTEGRATION_HEADERS = {
	/** Org pin by slug — the platform-wide scope header. */
	scopeSlug: 'x-scope-slug',
	/** Org pin by id — an alternative to `X-Scope-Slug` for integration keys. */
	organizationId: 'x-organization-id',
	/** Optional, writes only: the Ever Works user the write is made for. */
	actAsUser: 'x-act-as-user',
	/** Loop-prevention origin tag, e.g. `gauzy:<connectionId>`. */
	syncOrigin: 'x-sync-origin'
} as const;

/** Error codes of the integration error envelope (contract v1 B.1). */
export const INTEGRATION_ERROR_CODES = [
	'validation_failed',
	'invalid_key',
	'scope_missing',
	'org_not_pinned',
	'act_as_forbidden',
	'not_found',
	'transition_blocked',
	'duplicate_external_ref',
	'conflict',
	'cursor_expired',
	'version_mismatch',
	'domain_rule',
	'rate_limited',
	'internal_error'
] as const;
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

/** `{ error: { code, message, details? } }` — every integration error body. */
export interface IntegrationErrorEnvelope {
	error: {
		code: IntegrationErrorCode;
		message: string;
		details?: Record<string, unknown>;
	};
}

/** `POST /api/auth/api-keys/integration` request body. */
export interface CreateIntegrationKeyRequest {
	name: string;
	description?: string | null;
	integrationKind?: IntegrationKind;
	scopes: IntegrationScope[];
	organizationIds: string[];
	expiresAt?: string | null;
}

/** One pinned Organization as the key listing and `whoami` show it. */
export interface IntegrationKeyOrganization {
	id: string;
	slug: string;
	displayName: string;
}

/** An integration key as `GET /api/auth/api-keys/integration` lists it (never the secret). */
export interface IntegrationKeySummary {
	id: string;
	name: string;
	description: string | null;
	prefix: string;
	kind: typeof INTEGRATION_API_KEY_KIND;
	integrationKind: IntegrationKind;
	scopes: IntegrationScope[];
	organizationIds: string[];
	organizations: IntegrationKeyOrganization[];
	createdByUserId: string;
	createdAt: string;
	lastUsedAt: string | null;
	expiresAt: string | null;
	rotatedAt: string | null;
	previousKeyGraceUntil: string | null;
}

/** Create response: the summary plus the raw secret, returned exactly once. */
export interface CreateIntegrationKeyResponse extends IntegrationKeySummary {
	key: string;
}

/** `POST /api/auth/api-keys/:id/rotate` request body. */
export interface RotateApiKeyRequest {
	/** Hours the previous secret keeps working (0..168, default 24). */
	graceHours?: number;
}

/** `POST /api/auth/api-keys/:id/rotate` response: the new raw secret, returned once. */
export interface RotateApiKeyResponse {
	id: string;
	name: string;
	key: string;
	prefix: string;
	rotatedAt: string;
	previousKeyGraceUntil: string;
}

/** `GET /api/integrations/v1/whoami` (contract v1 B.2). */
export interface IntegrationWhoamiResponse {
	keyId: string;
	keyName: string;
	integrationKind: IntegrationKind;
	tenant: { id: string; slug: string };
	organizations: IntegrationKeyOrganization[];
	scopes: IntegrationScope[];
	apiVersion: '1';
	feedHead: string;
	limits: { readsPerMin: number; writesPerMin: number };
}
