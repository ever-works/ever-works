import 'server-only';
import { serverFetch } from './server-api';
import type { AppsCatalogListingResponse } from '@ever-works/contracts';
import type { AppsCatalogBlueprintList } from './apps-catalog.types';

/**
 * Server-only client for the create form's Apps catalog tab —
 * `GET /api/apps-catalog/blueprints` (lane aw-web-2): the public `ever-works`
 * repositories carrying the `ever-works-app-blueprint` topic. Not the APW-03
 * manifest catalog (`GET /api/apps-catalog`), which is not built yet.
 */
export const appsCatalogAPI = {
    /**
     * APW-03 — `GET /api/apps-catalog`: the curated catalog read from the
     * catalog repository's `manifest.json` (lane aw-web-3). Preferred; the
     * topic listing below is the fallback when it is not available.
     */
    list: async (query?: string): Promise<AppsCatalogListingResponse> => {
        const q = query?.trim();
        const qs = q && q.length >= 2 ? `&q=${encodeURIComponent(q.slice(0, 100))}` : '';
        return serverFetch<AppsCatalogListingResponse>(`/apps-catalog?limit=100${qs}`);
    },

    listBlueprints: async (query?: string): Promise<AppsCatalogBlueprintList> => {
        const q = query?.trim();
        const qs = q && q.length >= 2 ? `?q=${encodeURIComponent(q.slice(0, 100))}` : '';
        return serverFetch<AppsCatalogBlueprintList>(`/apps-catalog/blueprints${qs}`);
    },
};
