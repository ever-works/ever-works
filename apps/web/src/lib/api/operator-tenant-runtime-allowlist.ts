import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type { TenantJobRuntimeProviderId } from './tenant-job-runtime';

/**
 * EW-742 P5.1 (T35a UI follow-up) — web client for the operator-scoped
 * per-tenant runtime provider allow-list REST API (mounted at
 * `/api/operator/tenants/:tenantId/runtime-allowlist` on the platform
 * API — see `apps/api/src/operator/tenant-runtime-allowlist/operator-tenant-runtime-allowlist.controller.ts`).
 *
 * Auth: gated by `IsPlatformAdminGuard` on the controller. This wrapper
 * is server-only (`'server-only'`); the caller's JWT cookie is attached
 * by `serverFetch` / `serverMutation`. There is no client-side fallback.
 *
 * Shape mirrors `lib/api/tenant-job-runtime.ts` (the tenant
 * self-service surface for the same overlay), but every endpoint here
 * is path-scoped to a specific `tenantId` because the caller is an
 * instance operator acting on ANOTHER tenant's row.
 */

export interface TenantRuntimeAllowlistResponse {
    /** Echoed back so the caller can correlate response with request. */
    tenantId: string;
    /**
     * Per-tenant allow-list rows. Empty means "tenant inherits the
     * global allow-list" (when gating is on) or "no per-tenant
     * restriction" (when gating is off — list is preserved but ignored).
     */
    providerIds: TenantJobRuntimeProviderId[];
    /**
     * Whether per-tenant gating is currently ON. Driven by env
     * `EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING`. Echoed so the
     * operator can tell at a glance whether the rows actually take
     * effect right now.
     */
    perTenantGatingEnabled: boolean;
}

const base = (tenantId: string) => `/api/operator/tenants/${tenantId}/runtime-allowlist`;

export const operatorTenantRuntimeAllowlistAPI = {
    list: async (tenantId: string) => {
        return serverFetch<TenantRuntimeAllowlistResponse>(base(tenantId));
    },

    replace: async (tenantId: string, providerIds: TenantJobRuntimeProviderId[]) => {
        return serverMutation<TenantRuntimeAllowlistResponse>({
            endpoint: base(tenantId),
            data: { providerIds },
            method: 'PUT',
            wrapInData: false,
        });
    },

    deleteEntry: async (tenantId: string, providerId: TenantJobRuntimeProviderId) => {
        return serverMutation<TenantRuntimeAllowlistResponse>({
            endpoint: `${base(tenantId)}/${providerId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};

/**
 * Convenience aliases mirroring the function shape called out in the
 * implementing prompt, so call sites that don't want to thread the
 * namespaced object can import these directly.
 */
export const getTenantRuntimeAllowlist = (tenantId: string) =>
    operatorTenantRuntimeAllowlistAPI.list(tenantId);
export const replaceTenantRuntimeAllowlist = (
    tenantId: string,
    providerIds: TenantJobRuntimeProviderId[],
) => operatorTenantRuntimeAllowlistAPI.replace(tenantId, providerIds);
export const deleteTenantRuntimeAllowlistEntry = (
    tenantId: string,
    providerId: TenantJobRuntimeProviderId,
) => operatorTenantRuntimeAllowlistAPI.deleteEntry(tenantId, providerId);
