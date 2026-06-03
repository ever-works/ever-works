import { Injectable, Logger } from '@nestjs/common';
import { CrmTenantContext } from '../types/twenty-crm.types';

/**
 * Service for managing CRM tenant context.
 *
 * Security (overnight-audit DEFERRED CRITICAL — cross-tenant IDOR):
 * Every Twenty-CRM record lives in ONE shared upstream workspace. The
 * companies/people controllers used to address records with bare paths
 * (`/companies/:id`), so any authenticated user could read/mutate/delete
 * EVERY tenant's records. The fix is to derive a real per-caller tenant
 * key from the authenticated user's Tenant id and prefix every outgoing
 * endpoint with `/tenants/{tenantId}/...` so a caller can only ever
 * address rows inside their own tenant partition.
 *
 * The authoritative per-caller key is the user's `users.tenantId` (the
 * same Tenant the platform-wide scope guards authorize against — see
 * `SessionScopeGuard` / `OrgKbController.assertOrgAccess`). It is NOT
 * derived from `workId` (attacker-controllable, and a Work is not a
 * tenant boundary) and NOT the old shared `global_everworks` fallback
 * (which collapsed every caller into one shared partition — the root
 * cause of the IDOR).
 */
@Injectable()
export class CrmTenantService {
    private readonly logger = new Logger(CrmTenantService.name);

    /**
     * Resolve tenant context from request headers or work.
     *
     * NOTE (security): this legacy resolver derives the tenant key from
     * `workId` / a caller-independent global fallback and MUST NOT be
     * used to scope the per-caller companies/people CRM endpoints — it
     * does not isolate callers from one another. Use
     * {@link resolveCallerTenantContext} for request-scoped, per-caller
     * isolation. This method is retained only for the existing internal
     * sync paths (and their tests) that key by Work, never by caller
     * identity.
     */
    resolveTenantContext(
        workId?: string,
        userId?: string,
        globalTenantId?: string,
    ): CrmTenantContext {
        const tenantId = workId ? `work_${workId}` : globalTenantId || 'global_everworks';
        const context: CrmTenantContext = {
            tenantId,
            workId,
            userId,
        };

        this.logger.debug(`Resolved tenant context: ${JSON.stringify(context)}`);

        return context;
    }

    /**
     * Security: derive the request-scoped, per-caller tenant context from
     * the authenticated user's real Tenant id.
     *
     * Returns `null` (fail-closed) when the caller has not been upgraded
     * to a Tenant (`tenantId` is `null`/`undefined`/empty). Such a caller
     * has no tenant partition, so the controllers MUST reject the request
     * (404/403) rather than fall back to a shared partition. A `null`
     * return is the signal to do exactly that.
     *
     * The tenant id is sanitised into a single safe path segment before
     * it is ever interpolated into an outgoing CRM path: Tenant ids are
     * UUIDs (hex + hyphen) in production, but we defend in depth against
     * any future id source by rejecting path-traversal / separator
     * metacharacters here too, exactly as `ClientService.safeId` does for
     * record ids.
     */
    resolveCallerTenantContext(
        userId: string,
        tenantId: string | null | undefined,
    ): CrmTenantContext | null {
        if (!tenantId) {
            this.logger.debug(
                `Caller ${userId} has no Tenant — refusing to scope CRM request (fail-closed)`,
            );
            return null;
        }

        // Defence-in-depth: a tenant id is only ever a single path segment.
        // Reject separators / parent-dir / percent-encoding smuggling so a
        // crafted id can never break out of the `/tenants/{id}` segment.
        if (typeof tenantId !== 'string' || /[/\\%]/.test(tenantId) || tenantId.includes('..')) {
            this.logger.error(`Refusing malformed tenant id for caller ${userId}`);
            return null;
        }

        return {
            tenantId,
            userId,
        };
    }

    /**
     * Get tenant-specific API endpoint prefix.
     *
     * Encodes the tenant id so it can only ever occupy a single path
     * segment. Legitimate UUID tenant ids pass through byte-for-byte.
     */
    getTenantEndpointPrefix(tenantContext: CrmTenantContext): string {
        return `/tenants/${encodeURIComponent(tenantContext.tenantId)}`;
    }

    /**
     * Validate tenant context
     */
    validateTenantContext(context: CrmTenantContext): boolean {
        if (!context.tenantId) {
            this.logger.error('Tenant ID is required');
            return false;
        }

        return true;
    }

    /**
     * Get tenant-specific configuration
     */
    getTenantConfig(tenantContext: CrmTenantContext): Record<string, any> {
        return {
            tenantId: tenantContext.tenantId,
            workId: tenantContext.workId,
            userId: tenantContext.userId,
        };
    }
}
