// Security (EW-718) — co-located pure helper for the KB document server
// actions in `kb-document.ts`.
//
// This lives in its OWN module (not the `'use server'` action file) on
// purpose: Next.js requires every *exported* member of a `'use server'`
// module to be an async server action, so a synchronous, unit-testable
// mapper cannot be exported from there. Keeping it here gives the action a
// clean import and gives tests a direct unit seam.
import { ApiResponseError } from '@/lib/api/server-api';

/**
 * Map a caught error to a SAFE, user-facing string so raw API error messages
 * (internal paths, DB/connection detail, upstream provider strings) never
 * surface to the browser. Defense-in-depth: every catch block in
 * `kb-document.ts` routes through here instead of echoing `error.message`.
 *
 * Routing (mirrors the `toBudgetClientError` pattern in
 * `app/actions/dashboard/budgets.ts`):
 *   - Known `ApiResponseError`:
 *       - 4xx → a curated, business-safe message for the well-known codes
 *         (401/403/404/409/400); any other 4xx → generic "Request failed.".
 *       - 5xx (and anything >= 500) → generic
 *         "Something went wrong, please try again.".
 *   - Anything else (plain Error, opaque throw) → the per-action `fallback`.
 *
 * NOTE: this intentionally never returns `error.message` for 5xx/unknown
 * errors. The full error is still logged server-side at each call site.
 */
export function toSafeActionError(error: unknown, fallback: string): string {
    if (error instanceof ApiResponseError) {
        const status = error.statusCode;
        // Client errors (4xx): surface a curated, business-safe message for
        // the codes the KB flows actually produce; never echo the raw string.
        if (status >= 400 && status < 500) {
            if (status === 401) {
                return 'You must be signed in to do that.';
            }
            if (status === 403) {
                return 'You do not have permission to do that.';
            }
            if (status === 404) {
                return 'The requested document was not found.';
            }
            if (status === 409) {
                return 'A document already exists at this location.';
            }
            if (status === 400) {
                return 'Invalid request. Please check your input and try again.';
            }
            return 'Request failed.';
        }
        // Server errors (5xx) and any other status: stay generic.
        return 'Something went wrong, please try again.';
    }
    // Non-ApiResponseError (plain Error, string throw, etc.): never leak the
    // raw message — fall back to the action-specific generic copy.
    return fallback;
}
