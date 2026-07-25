/**
 * Digest briefings (Wave 7) — shared types for the digest composer,
 * delivery path, and dispatcher.
 */

/** A digest run always covers exactly one of these windows. */
export type DigestPeriod = 'daily' | 'weekly';

/**
 * Per-user cadence preference (`users.digestFrequency`). Default
 * `'off'` — existing users see nothing new until they opt in.
 */
export type DigestFrequency = 'off' | DigestPeriod;

export const DIGEST_FREQUENCIES: readonly DigestFrequency[] = ['off', 'daily', 'weekly'];

export const DIGEST_PERIODS: readonly DigestPeriod[] = ['daily', 'weekly'];

/** Deterministic per-section counts — never fabricated, always from rows. */
export interface DigestCounts {
    runsCompleted: number;
    runsFailed: number;
    tasksDone: number;
    tasksInReview: number;
    prsOpened: number;
    /** Ingested-event counts keyed by producing plugin id (source). */
    eventsBySource: Record<string, number>;
    /** Total ingested events in the window (sum of eventsBySource). */
    eventsTotal: number;
    /** Active goals included in the progress snapshot. */
    goalsTracked: number;
}

export interface ComposeDigestOptions {
    period: DigestPeriod;
    /** Injected clock for deterministic composition (tests, backfills). */
    now?: Date;
}

export interface ComposedDigest {
    period: DigestPeriod;
    /** Window start (ISO). */
    since: string;
    /** Window end (ISO). */
    until: string;
    /** True when the window contains no activity at all. */
    quiet: boolean;
    /** Rendered markdown body (sections; capped item lists). */
    markdown: string;
    /** One-line plain-text summary (notification message body). */
    text: string;
    counts: DigestCounts;
}

export interface DeliverDigestOptions {
    /** Bypass the per-user cadence gate (manual/chat-triggered sends). */
    force?: boolean;
    /** Injected clock, forwarded to the composer. */
    now?: Date;
}

export type DigestSkipReason = 'user-not-found' | 'digest-off' | 'period-mismatch' | 'quiet-period';

export interface DeliverDigestResult {
    delivered: boolean;
    reason?: DigestSkipReason;
    digest?: ComposedDigest;
}

export interface DispatchDueOptions {
    /** Max users per dispatch pass (bounds a single cron run). */
    limit?: number;
    /** Injected clock, forwarded to per-user delivery. */
    now?: Date;
}

export interface DigestDispatchSummary {
    period: DigestPeriod;
    /** Users whose preference matched the period. */
    selected: number;
    delivered: number;
    /** Skipped because the window had no activity. */
    skippedQuiet: number;
    /** Skipped for any other reason (preference changed mid-flight, …). */
    skipped: number;
    /** Per-user failures (logged; never abort the pass). */
    failed: number;
}
