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
	/** Optional human-readable description. Up to 1000 chars. */
	displayName?: string;
}

export interface UpdateOrganizationRequest {
	displayName?: string;
	legalName?: string;
	countryCode?: string;
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
}

/**
 * Error code returned with 409 Conflict when `upgrade-from-account` is
 * called after the user has created additional Organizations (spec §5.2,
 * "first-Org guard"). The endpoint is only callable while the user has
 * **exactly one** Organization under their Tenant.
 */
export const UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS = 'UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS' as const;
