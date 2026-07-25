import 'server-only';
import { cache } from 'react';
import { serverFetch } from './server-api';
import { API_URL } from '../constants';

export interface HealthResponse {
    status: string;
    message: string;
}

export const healthAPI = {
    check: async () => {
        return serverFetch('/health');
    },

    /**
     * Best-effort read of the API's informational service health — the
     * `job_runtime` entry, which answers "can background agent runs
     * execute on this install at all?" (an unconfigured local install
     * otherwise fails runs with no visible explanation).
     *
     * Follows the `versionAPI` conventions: public endpoint, no auth
     * token, deduped per render via React.cache, short cross-request
     * revalidate, and `null` on ANY failure — a health banner must never
     * be the thing that breaks the dashboard.
     */
    getJobRuntimeConfigured: cache(async (): Promise<boolean | null> => {
        try {
            const res = await fetch(`${API_URL}/health/ready`, {
                next: { revalidate: 120 },
            });
            if (!res.ok) return null;
            const body = (await res.json()) as {
                info?: Record<string, { configured?: boolean }>;
                details?: Record<string, { configured?: boolean }>;
            };
            const entry = body.info?.job_runtime ?? body.details?.job_runtime;
            return typeof entry?.configured === 'boolean' ? entry.configured : null;
        } catch {
            return null;
        }
    }),
};
