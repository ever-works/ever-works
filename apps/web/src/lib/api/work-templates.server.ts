import 'server-only';
import { serverFetch } from './server-api';
import { listBuiltinWorkBlueprints, type WorkBlueprintEntry } from './work-templates';

/**
 * Server-only Work-blueprint catalog fetch (Works Templates spec, ADR-014).
 * Calls the API's `GET /api/work-templates?chipType=…` (backed by
 * `WorksTemplateCatalogService` reading `ever-works/works`) and falls back to
 * the built-in `listBuiltinWorkBlueprints` list on any error or empty response.
 *
 * Lives in a `server-only` module — never import it from a client component.
 * Client code (the Create-Work chips + selector) keeps importing the
 * isomorphic `listBuiltinWorkBlueprints` / `WorkBlueprintEntry` from
 * `./work-templates` directly, so the web client bundle stays free of
 * `server-only`.
 */
export async function fetchWorkTemplateCatalog(chipType?: string): Promise<WorkBlueprintEntry[]> {
    try {
        const query = chipType ? `?chipType=${encodeURIComponent(chipType)}` : '';
        // `API_URL` already includes the `/api` prefix, so the controller
        // route `/api/work-templates` is reached via `/work-templates`.
        const rows = await serverFetch<WorkBlueprintEntry[]>(`/work-templates${query}`);
        if (Array.isArray(rows) && rows.length > 0) {
            return rows;
        }
    } catch {
        // Cold / unauthenticated catalog, network blip, or non-array body —
        // fall through to the built-in list so chips never render empty.
    }
    return listBuiltinWorkBlueprints(chipType);
}
