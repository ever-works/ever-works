import { MEETING_SOURCES, type MeetingSource } from './meetings.shared';

/**
 * Meetings — search-param whitelisting and href building for whichever
 * surface renders the Meetings catalog.
 *
 * The catalog used to live on `/meetings`, which owned this parsing
 * inline. Navigation consolidation moved it onto the Memory page
 * (`/memory#meetings`) and turned `/meetings` into a redirect — two
 * callers, one contract, so the parsing lives here rather than being
 * copied (docs/specs/features/navigation-consolidation).
 *
 * Pure and client-safe: no `server-only` import, so the client panel can
 * import the same helpers a server page uses.
 */

/** Meetings shown per page in the Memory block (`+1` look-ahead on the fetch). */
export const MEETINGS_PAGE_SIZE = 12;

/** Canonical uuid shape — anything else is dropped before it reaches the API. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The three filters the catalog understands, already validated. */
export interface MeetingsPageQuery {
    source?: MeetingSource;
    workId?: string;
    offset: number;
}

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Whitelist the raw `searchParams` bag before anything reaches the API:
 *
 *   - `source` must be one of the closed `MeetingSource` set — the API
 *     silently ignores unknown values, so dropping it locally keeps the
 *     rendered filter chip and the actual query in agreement.
 *   - `workId` must look like a uuid. The API compares it straight
 *     against a uuid column, so an arbitrary string would be a Postgres
 *     cast error (a 500) rather than an empty result.
 *   - `offset` is clamped to a non-negative integer.
 *
 * A repeated param (`?source=a&source=b`) takes its first entry, which
 * is what a browser's own form submission would have produced.
 */
export function parseMeetingsSearchParams(
    params: Record<string, string | string[] | undefined>,
): MeetingsPageQuery {
    const sourceParam = firstParam(params.source);
    const source = MEETING_SOURCES.includes(sourceParam as MeetingSource)
        ? (sourceParam as MeetingSource)
        : undefined;
    const workIdParam = firstParam(params.workId);
    const workId = workIdParam && UUID_RE.test(workIdParam) ? workIdParam : undefined;
    const offset = Math.max(0, parseInt(firstParam(params.offset) ?? '0', 10) || 0);
    return { source, workId, offset };
}

/**
 * Build a catalog href on an arbitrary base path, optionally anchored.
 *
 *   buildMeetingsHref('/meetings', {})                        → '/meetings'
 *   buildMeetingsHref('/memory', {}, '#meetings')             → '/memory#meetings'
 *   buildMeetingsHref('/memory', { source: 'zoom' }, '#meetings')
 *                                              → '/memory?source=zoom#meetings'
 *
 * Defaults are omitted (no `offset=0`) so the "no filters" URL is the
 * bare page — a shareable link nobody has to trim by hand.
 */
export function buildMeetingsHref(
    basePath: string,
    input: { source?: MeetingSource; workId?: string; offset?: number },
    hash = '',
): string {
    const params = new URLSearchParams();
    if (input.source) params.set('source', input.source);
    if (input.workId) params.set('workId', input.workId);
    if (input.offset && input.offset > 0) params.set('offset', String(input.offset));
    const qs = params.toString();
    return `${basePath}${qs ? `?${qs}` : ''}${hash}`;
}
