/**
 * EW-658 (Tenants & Organizations Phase 6) — wire-types for the
 * Organization-create / list / update / upgrade-from-account API
 * surface.
 *
 * Plain TypeScript interfaces so the API package and the web package
 * speak the same shape over the wire without dragging NestJS / TypeORM
 * decorators across the workspace boundary.
 */

export interface CreateOrganizationRequest {
	/** Display name. 1-200 chars. */
	name: string;
	/** Optional slug override. If omitted, allocated from `name`. */
	slug?: string;
	/**
	 * PR-6 (domain-model evolution §23.5) — optional company vision
	 * statement. Trimmed + capped at 5000 chars server-side; empty /
	 * whitespace-only collapses to null.
	 */
	vision?: string | null;
}

/**
 * EW-662 (Tenants & Organizations Phase 10) — body for
 * `POST /api/organizations/register-company`.
 *
 * Driven by the Company chip on `+ New`. The service hard-codes
 * `registrationProvider = 'manual'` and `registrationStatus =
 * 'registered'` for v1 (Stripe Atlas integration is deferred); the
 * client only supplies the user-visible fields.
 */
export interface RegisterCompanyRequest {
	/** Display name. 1-200 chars. */
	name: string;
	/** Registered legal name. Defaults to `name` when omitted. */
	legalName?: string;
	/** ISO 3166-1 alpha-2 country code (e.g. `'US'`). */
	countryCode?: string;
	/** Optional slug override. If omitted, allocated from `name`. */
	slug?: string;
}

export interface UpdateOrganizationRequest {
	displayName?: string;
	legalName?: string;
	countryCode?: string;
	/**
	 * PR-6 — company vision. Omit to leave unchanged; explicit `null`
	 * clears it. Any present value (including `null`) bumps
	 * `visionUpdatedAt` to now.
	 */
	vision?: string | null;
}

export interface OrganizationResponse {
	id: string;
	tenantId: string;
	slug: string;
	legalName: string | null;
	displayName: string | null;
	countryCode: string | null;
	registrationProvider: string | null;
	registrationStatus: string | null;
	linkedWorkId: string | null;
	/** PR-6 — company vision statement (null = never set / cleared). */
	vision: string | null;
	/** PR-6 — ISO timestamp of the last vision change (null = never set). */
	visionUpdatedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CheckSlugAvailabilityResponse {
	/** True iff the slug collides with neither `users.slug` nor `organizations.slug`. */
	available: boolean;
	/** Echo of the normalized form of the input (for the caller to display). */
	normalized: string;
	/** If unavailable, a next-free `-N` suggestion. Omitted when available. */
	suggestion?: string;
}

export interface UpgradeFromAccountResponse {
	organizationId: string;
	tenantId: string;
	/** Total Tier A rows updated across all enumerated tables. */
	tierARowsUpdated: number;
	/** Total Tier B rows updated. */
	tierBRowsUpdated: number;
	/**
	 * EW-663 (Phase 11 follow-up) — total Tier C rows backfilled via the
	 * parent-FK join walk (e.g. `conversation_messages` whose parent
	 * `conversations` belongs to the user). Zero before Phase 11 ships
	 * and on second-call idempotency.
	 */
	tierCRowsUpdated: number;
}

/**
 * Error code returned with 409 Conflict when `upgrade-from-account` is
 * called after the user has created additional Organizations (spec §5.2,
 * "first-Org guard"). The endpoint is only callable while the user has
 * **exactly one** Organization under their Tenant.
 */
export const UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS = 'UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS' as const;
