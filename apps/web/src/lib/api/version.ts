import 'server-only';
import { cache } from 'react';
import { API_URL } from '../constants';

/**
 * Build/release identity of the API, as returned by `GET /api/version`.
 * Shape mirrors the API's `BuildInfo` (apps/api/src/health/build-info.ts).
 */
export interface ApiVersion {
    name: string;
    version: string;
    gitSha: string;
    shortSha: string;
    gitRef: string;
    buildRun: string;
    buildTime: string;
    commitUrl: string | null;
}

export const versionAPI = {
    /**
     * Fetch the API build info once per render (deduped via React.cache) and
     * cached for 5 min across requests. `/api/version` is public + cheap, so
     * no auth token is attached. Returns `null` on any failure — the footer
     * just hides the API chip rather than erroring the whole layout.
     */
    get: cache(async (): Promise<ApiVersion | null> => {
        try {
            const res = await fetch(`${API_URL}/version`, {
                next: { revalidate: 300 },
            });
            if (!res.ok) return null;
            return (await res.json()) as ApiVersion;
        } catch {
            return null;
        }
    }),
};
