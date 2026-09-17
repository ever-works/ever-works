import type { WorkflowRunDetail } from '@/lib/api/workflows.shared';

/**
 * Capability catalogue (AW-21) — the pure rules behind the saved-workflow
 * screens: which page of workflows or runs is showing, where the pager
 * links go, and which run a detail page may render.
 *
 * Client-safe: no `server-only` import, so the helpers are unit-testable and
 * shareable with any client component.
 */

/** Workflows per page on `/catalog/workflows`. */
export const WORKFLOW_LIST_PAGE_SIZE = 50;

/** Runs per page in a workflow's run history. */
export const WORKFLOW_RUNS_PAGE_SIZE = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A repeated search param (`?a=1&a=2`) takes its first value. */
export function firstSearchParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/** True for a canonical UUID — anything else never reaches the API. */
export function isCatalogUuid(value: string | undefined | null): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** A raw `?offset=` as a non-negative whole number; anything malformed reads as 0. */
export function parseCatalogOffset(value: string | string[] | undefined): number {
    const raw = firstSearchParam(value);
    if (!raw || !/^\d+$/.test(raw)) return 0;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : 0;
}

export interface CatalogPageWindow {
    /** 1-based index of the first item shown; 0 when the page is empty. */
    readonly from: number;
    /** 1-based index of the last item shown; 0 when the page is empty. */
    readonly to: number;
    readonly total: number;
    /** Offset of the previous page, or `null` on the first page. */
    readonly previousOffset: number | null;
    /** Offset of the next page, or `null` when nothing follows. */
    readonly nextOffset: number | null;
}

/**
 * Where the current page sits in the whole list, and where Previous and Next
 * go. An offset past the end still offers Previous, landing on the last real
 * page, so a stale or hand-edited link is never a dead end.
 */
export function catalogPageWindow(input: {
    readonly offset: number;
    readonly pageSize: number;
    readonly itemCount: number;
    readonly total: number;
}): CatalogPageWindow {
    const offset = Math.max(0, Math.floor(input.offset));
    const pageSize = Math.max(1, Math.floor(input.pageSize));
    const itemCount = Math.max(0, input.itemCount);
    // Never report fewer items than the page itself proves exist.
    const total = Math.max(0, input.total, itemCount > 0 ? offset + itemCount : 0);
    const lastPageOffset = total === 0 ? 0 : Math.floor((total - 1) / pageSize) * pageSize;

    return {
        from: itemCount > 0 ? offset + 1 : 0,
        to: itemCount > 0 ? offset + itemCount : 0,
        total,
        previousOffset:
            offset > 0 ? Math.min(Math.max(0, offset - pageSize), lastPageOffset) : null,
        nextOffset: itemCount > 0 && offset + itemCount < total ? offset + itemCount : null,
    };
}

/**
 * A catalogue href on `basePath` with the given search params. Empty values
 * and zero offsets are omitted, so the first page is the bare path.
 */
export function catalogHref(
    basePath: string,
    params: Readonly<Record<string, string | number | null | undefined>>,
): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '' || value === 0) continue;
        search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * The run a workflow's page may render. Runs are fetched by their own id, so
 * a run that belongs to a different workflow — even one the same person owns
 * — is refused rather than shown under this workflow's name and graph.
 */
export function runForWorkflow<T extends Pick<WorkflowRunDetail, 'workflowId'>>(
    run: T | null | undefined,
    workflowId: string,
): T | null {
    return run && run.workflowId === workflowId ? run : null;
}
