import { Injectable, Logger } from '@nestjs/common';
import { CrmTenantContext } from '../types/twenty-crm.types';

/**
 * Service for managing CRM tenant context.
 *
 * Security (cross-tenant IDOR fix):
 * The companies/people controllers used to address records with bare,
 * caller-independent credentials, so any authenticated user could
 * read/mutate/delete EVERY tenant's records. The fix is to derive a real
 * per-caller tenant id from the authenticated user's Tenant and use it to
 * select that tenant's OWN Twenty workspace credentials (isolation model:
 * one Twenty workspace + API key per tenant — see
 * `CrmConfigService.configForTenant`). Twenty scopes an API key to a single
 * workspace, so a caller can only ever address rows in their own workspace.
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
     * The tenant id is validated before use: Tenant ids are UUIDs (hex +
     * hyphen) in production, but we defend in depth against any future id
     * source by rejecting separator / parent-dir / percent-encoding
     * metacharacters, exactly as `ClientService.safeId` does for record ids —
     * the tenant id is used as a credential-map key and is logged, so it must
     * never carry traversal/injection characters.
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

        // Defence-in-depth: reject separators / parent-dir / percent-encoding
        // smuggling so a crafted id can never be abused as a credential-map key
        // or traversal vector.
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
