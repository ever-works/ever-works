/**
 * Costs dashboard — client-safe wire types + pure helpers for the
 * Settings → Usage & Credits → Costs tab.
 *
 * Mirrors `apps/api/src/subscriptions/costs.controller.ts`; kept apart
 * from `costs.ts` (which is `server-only`) so `'use client'` components
 * can import types and helpers without pulling the server guard into the
 * client bundle — same split as `credits.shared.ts`.
 */

// ── Window vocabulary ───────────────────────────────────────────────

/**
 * The rolling windows the Costs tab offers. Pinned to the API's
 * `COSTS_WINDOW_DAYS`: the DTO rejects anything else, so a value added
 * here without the API moving first would 400 every request.
 */
export const COSTS_WINDOW_DAYS = [7, 30, 90] as const;
export type CostsWindowDays = (typeof COSTS_WINDOW_DAYS)[number];

export const COSTS_DEFAULT_WINDOW_DAYS: CostsWindowDays = 30;

/** Series keys that are not an Agent id (mirrors the API sentinels). */
export const COSTS_UNATTRIBUTED_SERIES_KEY = 'unattributed';
export const COSTS_OTHER_SERIES_KEY = 'other';

/** The sections of the Costs API, used by the proxy route's allow-list. */
export const COSTS_SECTIONS = ['summary', 'daily', 'by-agent', 'by-model', 'top-runs'] as const;
export type CostsSection = (typeof COSTS_SECTIONS)[number];

// ── Wire types ──────────────────────────────────────────────────────

interface CostsWindowEcho {
    status: string;
    windowDays: CostsWindowDays;
    from: string;
    to: string;
}

export interface CostsSummary extends CostsWindowEcho {
    totalCostCents: number;
    runsCount: number;
    avgPerRunCents: number;
}

export interface CostsDailySeries {
    key: string;
    /** Agent name; null for the sentinel series (localized by the UI). */
    label: string | null;
    costCents: number;
}

export interface CostsDailyBucket {
    day: string;
    totalCostCents: number;
    costs: Record<string, number>;
}

export interface CostsDaily extends CostsWindowEcho {
    series: CostsDailySeries[];
    days: CostsDailyBucket[];
}

export interface CostsByAgentRow {
    agentId: string | null;
    name: string | null;
    costCents: number;
    runs: number;
    avgPerRunCents: number;
}

export interface CostsByAgent extends CostsWindowEcho {
    rows: CostsByAgentRow[];
}

export interface CostsByModelRow {
    modelId: string | null;
    units: number;
    costCents: number;
    sharePercent: number;
}

export interface CostsByModel extends CostsWindowEcho {
    totalCostCents: number;
    rows: CostsByModelRow[];
}

export interface CostsTopRunRow {
    runId: string;
    costCents: number;
    agentId: string;
    agentName: string | null;
    taskId: string | null;
    taskTitle: string | null;
    modelId: string | null;
    status: string;
    triggerKind: string;
    startedAt: string | null;
}

export interface CostsTopRuns extends CostsWindowEcho {
    rows: CostsTopRunRow[];
}

/** Everything the Costs tab renders for ONE window. */
export interface CostsSnapshot {
    summary: CostsSummary | null;
    daily: CostsDaily | null;
    byAgent: CostsByAgent | null;
    byModel: CostsByModel | null;
    topRuns: CostsTopRuns | null;
}

// ── Pure helpers (unit-tested in costs.shared.unit.spec.ts) ─────────

/** Runtime guard for anything a URL param or a `<select>` yields. */
export function isCostsWindowDays(value: unknown): value is CostsWindowDays {
    return typeof value === 'number' && (COSTS_WINDOW_DAYS as readonly number[]).includes(value);
}

/**
 * Normalize an untrusted value (URL param, storage) to a window.
 * Returns `undefined` rather than throwing so callers can fall back to
 * their own default — a bad `?windowDays=` must never blank the page.
 */
export function parseCostsWindowDays(value: unknown): CostsWindowDays | undefined {
    if (Array.isArray(value)) {
        return parseCostsWindowDays(value[0]);
    }
    if (typeof value === 'number') {
        return isCostsWindowDays(value) ? value : undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        return undefined;
    }
    // `Number('')` is 0 and `Number(' 7 ')` is 7 — the empty check above
    // handles the first, and the allow-list handles everything else.
    const parsed = Number(value);
    return isCostsWindowDays(parsed) ? parsed : undefined;
}

/** Build the `/usage/costs/<section>` query string (omits defaults). */
export function buildCostsQuery(
    params: { windowDays?: CostsWindowDays; limit?: number } = {},
): string {
    const search = new URLSearchParams();
    if (params.windowDays) {
        search.set('windowDays', String(params.windowDays));
    }
    if (params.limit) {
        search.set('limit', String(params.limit));
    }
    const qs = search.toString();
    return qs ? `?${qs}` : '';
}

/**
 * `sharePercent` → a bar width clamped into 0..100.
 *
 * A single model always renders a FULL bar (its share is 100), and a
 * rounding artifact just above 100 can never overflow its track.
 */
export function shareBarWidth(sharePercent: number): string {
    if (!Number.isFinite(sharePercent) || sharePercent <= 0) {
        return '0%';
    }
    return `${Math.min(100, sharePercent)}%`;
}

/** `12.5` → `12.5%`; whole numbers drop the decimal. */
export function formatSharePercent(sharePercent: number): string {
    if (!Number.isFinite(sharePercent)) {
        return '0%';
    }
    const rounded = Math.round(sharePercent * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/** `2026-08-14` → `08-14` for a dense chart axis. */
export function formatCostsDayTick(day: string): string {
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(5) : day;
}

/**
 * Deterministic series colour. Keyed by INDEX, not by a hash of the id:
 * the series array is already ordered by spend, so the biggest spender
 * keeps the same colour between windows, and two adjacent stack segments
 * can never collide the way hashed colours occasionally do.
 */
const COSTS_SERIES_COLORS = [
    '#3b82f6',
    '#8b5cf6',
    '#14b8a6',
    '#f59e0b',
    '#ec4899',
    '#22c55e',
] as const;

/** Muted grey for the folded / unattributed buckets, never a hue. */
export const COSTS_SENTINEL_SERIES_COLOR = '#94a3b8';

export function costsSeriesColor(key: string, index: number): string {
    if (key === COSTS_OTHER_SERIES_KEY || key === COSTS_UNATTRIBUTED_SERIES_KEY) {
        return COSTS_SENTINEL_SERIES_COLOR;
    }
    return COSTS_SERIES_COLORS[index % COSTS_SERIES_COLORS.length];
}
