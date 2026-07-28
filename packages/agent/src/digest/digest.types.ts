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

/**
 * What a digest aggregates over.
 *
 * `personal`     — the original briefing: one user's own runs, tasks,
 *                  PRs, events and goals. Unchanged.
 * `organization` — the same window computed over every row stamped with
 *                  an `organizationId`, so a team sees one shared
 *                  briefing instead of N personal ones.
 *
 * The two are ADDITIVE, never exclusive: an org digest does not
 * suppress, replace or alter any member's personal digest.
 */
export type DigestScope = 'personal' | 'organization';

export const DIGEST_SCOPES: readonly DigestScope[] = ['personal', 'organization'];

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
    /**
     * Judgment layer G3 - OPEN escalations raised in the window: the
     * things an agent gave up on and a human still owes a decision.
     *
     * Deliberately part of the quiet calculation, unlike `goalsTracked`:
     * a window in which nothing else happened BUT an agent stopped and
     * asked for a decision is the opposite of quiet, and suppressing that
     * digest would hide exactly the signal the digest exists to carry.
     */
    escalationsOpen: number;
}

/**
 * Outcome of the OPTIONAL LLM narrative pass.
 *
 * `generated`   — a summary was produced through the AI facade.
 * `disabled`    — the caller / org settings asked for no narrative.
 * `unavailable` — no AI provider is configured for this install.
 * `failed`      — a provider is configured but the call errored.
 *
 * Every non-`generated` status carries a human-readable `reason` that
 * is rendered INTO the digest markdown. The narrative never silently
 * disappears: the deterministic digest is always intact, and the reader
 * is told, in the digest itself, why the prose is missing.
 */
export type DigestNarrativeStatus = 'generated' | 'disabled' | 'unavailable' | 'failed';

export interface DigestNarrative {
    status: DigestNarrativeStatus;
    /** The generated prose, or `null` for every other status. */
    text: string | null;
    /** Why there is no narrative. Absent when `status === 'generated'`. */
    reason?: string;
    /** Provider that produced the summary, when known. */
    provider?: string;
}

export interface ComposeDigestOptions {
    period: DigestPeriod;
    /** Injected clock for deterministic composition (tests, backfills). */
    now?: Date;
    /**
     * Ask for the LLM narrative on top of the deterministic counts.
     * Default `true`; a missing/failing provider degrades to the
     * non-narrative digest with a visible note (never a hard failure).
     */
    narrative?: boolean;
}

/**
 * Options for an ORGANIZATION-scoped composition. `metricsUserId` is
 * the identity the AI facade meters the narrative call against — the
 * cron has no session, so the caller resolves an authorized user (the
 * tenant owner) and passes it in.
 */
export interface ComposeOrgDigestOptions extends ComposeDigestOptions {
    metricsUserId?: string;
}

export interface ComposedDigest {
    /** `personal` for the per-user digest, `organization` for an org one. */
    scope: DigestScope;
    /** The user id (personal) or organization id (organization) it covers. */
    subjectId: string;
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
    /** LLM narrative outcome — always present, often not `generated`. */
    narrative: DigestNarrative;
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

/** Why one organization was not sent a digest on this pass. */
export type OrgDigestSkipReason =
    | 'org-not-found'
    | 'digest-off'
    | 'period-mismatch'
    | 'quiet-period'
    | 'no-recipient';

export interface DeliverOrgDigestResult {
    delivered: boolean;
    reason?: OrgDigestSkipReason;
    digest?: ComposedDigest;
    /** Users the briefing was delivered to (the tenant owner today). */
    recipients?: string[];
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

export interface OrgDigestDispatchSummary {
    period: DigestPeriod;
    /** Organizations that carried digest settings at all. */
    selected: number;
    delivered: number;
    skippedQuiet: number;
    skipped: number;
    failed: number;
}
