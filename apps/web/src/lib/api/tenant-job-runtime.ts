import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * EW-742 P2.1 — web client for the tenant job-runtime overlay admin API
 * (mounted at `/api/account/job-runtime` on the platform API — see
 * `apps/api/src/account/tenant-job-runtime/tenant-job-runtime.controller.ts`).
 *
 * Auth model is 1 User : 1 Tenant so every endpoint targets the
 * authenticated user's own tenant; there are no path params.
 *
 * Credential pointers are NEVER round-tripped through this wrapper.
 * The GET response is already redacted server-side
 * (`credentialsSecretRefRedacted`, `hasCredentials` only) and the PUT
 * payload accepts an opaque `credentialsSecretRef` that the controller
 * routes into the encrypted secrets store.
 */

export type TenantJobRuntimeProviderId = 'trigger' | 'temporal' | 'bullmq' | 'pgboss' | 'inngest';

export type TenantJobRuntimeMode = 'inherit' | 'byo' | 'override';

export interface TenantJobRuntimeConfigResponse {
    tenantId: string;
    providerId: TenantJobRuntimeProviderId | null;
    mode: TenantJobRuntimeMode;
    hasCredentials: boolean;
    credentialsSecretRefRedacted: string | null;
    credentialVersion: number | null;
    enabled: boolean;
    createdBy: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface TenantJobRuntimeRotateResponse {
    credentialVersion: number;
}

export interface UpsertTenantJobRuntimeConfigPayload {
    providerId: TenantJobRuntimeProviderId;
    mode: TenantJobRuntimeMode;
    credentialsSecretRef?: string | null;
    enabled?: boolean;
}

/**
 * EW-742 P5 (T34) — shape of `GET /api/account/job-runtime/available-providers`.
 * The picker fetches this server-side to know which provider ids the
 * operator allow-list permits. Empty / unset env returns ALL bundled
 * providers (fail-open default).
 */
export interface TenantJobRuntimeAvailableProvidersResponse {
    providers: TenantJobRuntimeProviderId[];
}

const BASE = '/api/account/job-runtime';

export const tenantJobRuntimeAPI = {
    getConfig: async () => {
        return serverFetch<TenantJobRuntimeConfigResponse>(`${BASE}/config`);
    },

    getAvailableProviders: async () => {
        return serverFetch<TenantJobRuntimeAvailableProvidersResponse>(
            `${BASE}/available-providers`,
        );
    },

    upsertConfig: async (payload: UpsertTenantJobRuntimeConfigPayload) => {
        return serverMutation<TenantJobRuntimeConfigResponse>({
            endpoint: `${BASE}/config`,
            data: payload,
            method: 'PUT',
            wrapInData: false,
        });
    },

    rotate: async () => {
        return serverMutation<TenantJobRuntimeRotateResponse>({
            endpoint: `${BASE}/rotate`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    forceInvalidate: async () => {
        return serverMutation<TenantJobRuntimeRotateResponse>({
            endpoint: `${BASE}/force-invalidate`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    revertToInherit: async () => {
        return serverMutation<TenantJobRuntimeConfigResponse>({
            endpoint: `${BASE}/config`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};

/**
 * Convenience aliases that match the function-name shape called out in
 * the implementing prompt (T15-T19), so call sites that don't want to
 * thread the namespaced object can `import { getJobRuntimeConfig } from
 * '@/lib/api/tenant-job-runtime'`.
 */
export const getJobRuntimeConfig = () => tenantJobRuntimeAPI.getConfig();
export const getAvailableJobRuntimeProviders = () => tenantJobRuntimeAPI.getAvailableProviders();
export const upsertJobRuntimeConfig = (payload: UpsertTenantJobRuntimeConfigPayload) =>
    tenantJobRuntimeAPI.upsertConfig(payload);
export const rotateJobRuntimeConfig = () => tenantJobRuntimeAPI.rotate();
export const forceInvalidateJobRuntimeConfig = () => tenantJobRuntimeAPI.forceInvalidate();
export const deleteJobRuntimeConfig = () => tenantJobRuntimeAPI.revertToInherit();
