import {
    isRunLedgerCalendarDate,
    RUN_LEDGER_GRANULARITIES,
    RUN_LEDGER_SEARCH_MAX_LENGTH,
    RUN_LEDGER_SEARCH_MIN_LENGTH,
    RUN_LEDGER_STATUSES,
    RUN_LEDGER_TRIGGER_KINDS,
    type RunLedgerFilters,
    type RunLedgerGranularity,
    type RunLedgerRow,
    type RunLedgerStatus,
    type RunLedgerTriggerKind,
    type RunLedgerWindow,
} from '@ever-works/contracts';

/**
 * Runs ledger (AW-09) — pure, client-safe helpers for the Runs page: the
 * URL ↔ view-state mapping, anchor-date stepping, and the formatters that
 * keep "not measured" distinct from zero. No React, no fetch.
 *
 * The server resolves the actual window (timezone, DST, the 12-month
 * reach); the client only moves an anchor date, so the two cannot disagree
 * about where a window starts.
 */

/** Per-viewer granularity preference (the window itself never persists). */
export const RUNS_GRANULARITY_STORAGE_KEY = 'runs-granularity';

/** Live refresh cadence while a listed run is still in flight. */
export const RUNS_POLL_INTERVAL_MS = 5_000;

export interface RunsViewState {
    granularity: RunLedgerGranularity;
    /** Anchor `YYYY-MM-DD`; null means "today" (resolved by the server). */
    date: string | null;
    filters: RunLedgerFilters;
    /** The run whose receipt is open, if any. */
    runId: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ParamSource = { get(name: string): string | null };

function list(source: ParamSource, name: string): string[] {
    const raw = source.get(name);
    if (!raw) return [];
    return Array.from(
        new Set(
            raw
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
        ),
    );
}

function isGranularity(value: unknown): value is RunLedgerGranularity {
    return (RUN_LEDGER_GRANULARITIES as readonly unknown[]).includes(value);
}

/** Read the view state from URL search params, dropping anything invalid. */
export function parseRunsViewState(
    source: ParamSource,
    fallbackGranularity: RunLedgerGranularity = 'day',
): RunsViewState {
    const g = source.get('g');
    const d = source.get('d');
    const q = source.get('q')?.trim() ?? '';
    const run = source.get('run');
    const filters: RunLedgerFilters = {};

    const agentIds = list(source, 'agent').filter((id) => UUID_PATTERN.test(id));
    if (agentIds.length > 0) filters.agentIds = agentIds;
    const kinds = list(source, 'kind').filter((kind): kind is RunLedgerTriggerKind =>
        (RUN_LEDGER_TRIGGER_KINDS as readonly string[]).includes(kind),
    );
    if (kinds.length > 0) filters.triggerKinds = kinds;
    const statuses = list(source, 'status').filter((status): status is RunLedgerStatus =>
        (RUN_LEDGER_STATUSES as readonly string[]).includes(status),
    );
    if (statuses.length > 0) filters.statuses = statuses;
    const work = source.get('work');
    if (work && UUID_PATTERN.test(work)) filters.workId = work;
    const mission = source.get('mission');
    if (mission && UUID_PATTERN.test(mission)) filters.missionId = mission;
    if (isSearchUsable(q)) filters.search = q;

    return {
        granularity: isGranularity(g) ? g : fallbackGranularity,
        // A well-shaped but impossible day (`2026-02-31`) is dropped like any
        // other invalid value — the API rejects it, so passing it on would
        // turn a mistyped link into an error instead of today's window.
        date: isRunLedgerCalendarDate(d) ? d : null,
        filters,
        runId: run && UUID_PATTERN.test(run) ? run : null,
    };
}

/** Serialise the view state to the URL query (without the leading `?`). */
export function buildRunsSearch(state: RunsViewState): string {
    const params = new URLSearchParams();
    params.set('g', state.granularity);
    if (state.date) params.set('d', state.date);
    const { filters } = state;
    if (filters.agentIds?.length) params.set('agent', filters.agentIds.join(','));
    if (filters.triggerKinds?.length) params.set('kind', filters.triggerKinds.join(','));
    if (filters.statuses?.length) params.set('status', filters.statuses.join(','));
    if (filters.workId) params.set('work', filters.workId);
    if (filters.missionId) params.set('mission', filters.missionId);
    if (filters.search) params.set('q', filters.search);
    if (state.runId) params.set('run', state.runId);
    return params.toString();
}

/** A search the API accepts: at least 2 and at most 200 characters. */
export function isSearchUsable(value: string): boolean {
    const trimmed = value.trim();
    return (
        trimmed.length >= RUN_LEDGER_SEARCH_MIN_LENGTH &&
        trimmed.length <= RUN_LEDGER_SEARCH_MAX_LENGTH
    );
}

/** How many filter dimensions are active. */
export function countActiveFilters(filters: RunLedgerFilters): number {
    return [
        filters.agentIds?.length,
        filters.triggerKinds?.length,
        filters.statuses?.length,
        filters.workId,
        filters.missionId,
        filters.search,
    ].filter(Boolean).length;
}

function parseDate(date: string): Date {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** Move an anchor date one granularity unit backward (-1) or forward (+1). */
export function stepAnchorDate(
    date: string,
    granularity: RunLedgerGranularity,
    direction: -1 | 1,
): string {
    const current = parseDate(date);
    if (granularity === 'day') {
        current.setUTCDate(current.getUTCDate() + direction);
        return formatDate(current);
    }
    if (granularity === 'week') {
        current.setUTCDate(current.getUTCDate() + 7 * direction);
        return formatDate(current);
    }
    // Month: land on the 1st so stepping from the 31st never skips a month.
    return formatDate(
        new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + direction, 1)),
    );
}

/** Does the window contain `now`? Only then can a listed run still change. */
export function windowIncludesNow(
    window: Pick<RunLedgerWindow, 'from' | 'to'>,
    now: number = Date.now(),
): boolean {
    return now >= new Date(window.from).getTime() && now < new Date(window.to).getTime();
}

/** True while at least one listed run is queued or running. */
export function hasOpenRuns(rows: Pick<RunLedgerRow, 'status'>[]): boolean {
    return rows.some((row) => row.status === 'queued' || row.status === 'running');
}

/**
 * Merge a refreshed first page into the rows on screen, by id: refreshed
 * rows replace their stale copy in place, new rows are prepended, and rows
 * from pages the viewer already loaded further down are kept — so a live
 * refresh never reorders, shrinks or scrolls the list.
 */
export function mergeRefreshedRows(current: RunLedgerRow[], fresh: RunLedgerRow[]): RunLedgerRow[] {
    const freshById = new Map(fresh.map((row) => [row.id, row]));
    const known = new Set(current.map((row) => row.id));
    const added = fresh.filter((row) => !known.has(row.id));
    return [...added, ...current.map((row) => freshById.get(row.id) ?? row)];
}

/** `1h 04m`, `4m 55s`, `31s` — run-scale durations. */
export function formatRunDuration(ms: number | null | undefined): string | null {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Elapsed time of a run: its recorded duration, else start → end (or now). */
export function runElapsedMs(
    row: Pick<RunLedgerRow, 'durationMs' | 'startedAt' | 'finishedAt'>,
    now: number = Date.now(),
): number | null {
    if (row.durationMs != null) return row.durationMs;
    if (!row.startedAt) return null;
    const started = new Date(row.startedAt).getTime();
    if (Number.isNaN(started)) return null;
    const end = row.finishedAt ? new Date(row.finishedAt).getTime() : now;
    return Math.max(0, end - started);
}

/**
 * Integer cents → money text, or null when the value was not measured.
 * Callers render null as "—" with an explanation, never as `$0.00`.
 */
export function formatCents(cents: number | null | undefined, locale?: string): string | null {
    if (cents == null || !Number.isFinite(cents)) return null;
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(
        cents / 100,
    );
}

/** Compact token count (`412k`), or null when not measured. */
export function formatTokens(tokens: number | null | undefined, locale?: string): string | null {
    if (tokens == null || !Number.isFinite(tokens)) return null;
    return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
        tokens,
    );
}

/** Should a single-key shortcut be ignored because the user is typing? */
export function isTypingTarget(target: EventTarget | null): boolean {
    if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
    const element = target as HTMLElement;
    const tag = element.tagName.toLowerCase();
    return (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        element.isContentEditable === true ||
        element.getAttribute?.('contenteditable') === 'true'
    );
}
