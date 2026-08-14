import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Environments (Settings → Environments) — web client for the
 * `api/environments` controller (apps/api/src/environments). Named,
 * reusable runtime recipes (pip/npm packages + networking posture)
 * managed under Settings and assigned per-Agent.
 */

export type EnvironmentNetworkingMode = 'unrestricted' | 'limited';
export type EnvironmentStatus = 'draft' | 'published';

export interface Environment {
    id: string;
    userId: string;
    name: string;
    slug: string;
    description: string | null;
    pipPackages: string[];
    npmPackages: string[];
    networkingMode: EnvironmentNetworkingMode;
    allowedHosts: string[] | null;
    allowPackageManagers: boolean;
    status: EnvironmentStatus;
    availableInAllProjects: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface CreateEnvironmentPayload {
    name: string;
    description?: string;
    pipPackages?: string[];
    npmPackages?: string[];
    networkingMode?: EnvironmentNetworkingMode;
    allowedHosts?: string[];
    allowPackageManagers?: boolean;
    availableInAllProjects?: boolean;
}

export type UpdateEnvironmentPayload = Partial<CreateEnvironmentPayload>;

// NOTE: no leading `/api` here — `serverFetch` prepends `API_URL`, which
// already ends in `/api` (see the tenant-job-runtime helper's note).
const BASE = '/environments';

export const environmentsAPI = {
    list: async (status?: EnvironmentStatus): Promise<Environment[]> => {
        const query = status ? `?status=${status}` : '';
        const response = await serverFetch<{ data: Environment[] }>(`${BASE}${query}`);
        return response?.data ?? [];
    },

    get: async (id: string): Promise<Environment> => {
        return serverFetch<Environment>(`${BASE}/${id}`);
    },

    create: async (payload: CreateEnvironmentPayload): Promise<Environment> => {
        return serverMutation<Environment>({
            endpoint: BASE,
            data: payload,
            method: 'POST',
            wrapInData: false,
        });
    },

    update: async (id: string, payload: UpdateEnvironmentPayload): Promise<Environment> => {
        return serverMutation<Environment>({
            endpoint: `${BASE}/${id}`,
            data: payload,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    publish: async (id: string): Promise<Environment> => {
        return serverMutation<Environment>({
            endpoint: `${BASE}/${id}/publish`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    remove: async (id: string): Promise<void> => {
        await serverMutation<void>({
            endpoint: `${BASE}/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
