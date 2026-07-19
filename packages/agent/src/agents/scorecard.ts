import type { AgentScorecardMetric } from '../entities/agent.entity';

/**
 * Agent Scorecards increment 1 — pure helpers over the
 * `agents.scorecard` JSON column (see `AgentScorecardMetric` on the
 * entity). No IO / no Nest deps so both the service layer and future
 * roll-up surfaces can reuse them.
 *
 * Follow-ups (NOT in this increment): auto-updating `current` from run
 * output, and the org-dashboard at-risk roll-up.
 */

/** Derived health of one metric. */
export type AgentScorecardStatus = 'exceeded' | 'on_track' | 'behind' | 'critical';

/** Aggregate counts returned by {@link summarizeScorecard}. */
export interface AgentScorecardSummary {
    total: number;
    exceeded: number;
    onTrack: number;
    behind: number;
    critical: number;
}

/** Hard cap on metrics per scorecard — keeps the JSON column bounded. */
export const SCORECARD_MAX_METRICS = 12;

/** Max length for a metric label. */
export const SCORECARD_LABEL_MAX_LENGTH = 80;

/** Kebab-case metric key: `prs-merged`, `nps`, `weekly-revenue-usd`. */
export const SCORECARD_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SCORECARD_PERIODS = ['weekly', 'monthly', 'quarterly'] as const;

/**
 * Classify one metric:
 *
 * - `critical`  — `floor` is set and `current` is below it.
 * - `exceeded`  — `stretch` is set and `current` is at/above it.
 * - `on_track`  — `current` is at/above `target`.
 * - `behind`    — everything else (below target, but not under the floor).
 */
export function scorecardStatus(metric: AgentScorecardMetric): AgentScorecardStatus {
    if (metric.floor != null && metric.current < metric.floor) return 'critical';
    if (metric.stretch != null && metric.current >= metric.stretch) return 'exceeded';
    if (metric.current >= metric.target) return 'on_track';
    return 'behind';
}

/** Roll a scorecard up into per-status counts (order-independent). */
export function summarizeScorecard(metrics: AgentScorecardMetric[]): AgentScorecardSummary {
    const summary: AgentScorecardSummary = {
        total: metrics.length,
        exceeded: 0,
        onTrack: 0,
        behind: 0,
        critical: 0,
    };
    for (const metric of metrics) {
        switch (scorecardStatus(metric)) {
            case 'exceeded':
                summary.exceeded += 1;
                break;
            case 'on_track':
                summary.onTrack += 1;
                break;
            case 'behind':
                summary.behind += 1;
                break;
            case 'critical':
                summary.critical += 1;
                break;
        }
    }
    return summary;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate a scorecard write. Returns the FIRST violation as a
 * human-readable message, or `null` when the array is acceptable.
 * The service wraps a non-null result in `BadRequestException`; the
 * API DTO layer enforces the same shape via class-validator, so this
 * is the defense-in-depth check for non-HTTP callers (tools, import).
 *
 * Rules: <= {@link SCORECARD_MAX_METRICS} metrics; kebab-case keys,
 * unique within the array; non-empty labels <= 80 chars; finite
 * numbers for target/current (and floor/stretch when set); a known
 * period.
 */
export function validateScorecard(metrics: AgentScorecardMetric[]): string | null {
    if (!Array.isArray(metrics)) {
        return 'scorecard must be an array of metrics.';
    }
    if (metrics.length > SCORECARD_MAX_METRICS) {
        return `scorecard supports at most ${SCORECARD_MAX_METRICS} metrics.`;
    }
    const seenKeys = new Set<string>();
    for (const metric of metrics) {
        if (typeof metric.key !== 'string' || !SCORECARD_KEY_RE.test(metric.key)) {
            return `scorecard metric key "${String(metric.key)}" must be kebab-case (a-z, 0-9, dashes).`;
        }
        if (seenKeys.has(metric.key)) {
            return `scorecard metric key "${metric.key}" is duplicated — keys must be unique.`;
        }
        seenKeys.add(metric.key);
        if (
            typeof metric.label !== 'string' ||
            metric.label.trim().length === 0 ||
            metric.label.length > SCORECARD_LABEL_MAX_LENGTH
        ) {
            return `scorecard metric "${metric.key}" needs a non-empty label of at most ${SCORECARD_LABEL_MAX_LENGTH} characters.`;
        }
        if (!isFiniteNumber(metric.target) || !isFiniteNumber(metric.current)) {
            return `scorecard metric "${metric.key}" target and current must be finite numbers.`;
        }
        if (metric.floor != null && !isFiniteNumber(metric.floor)) {
            return `scorecard metric "${metric.key}" floor must be a finite number when set.`;
        }
        if (metric.stretch != null && !isFiniteNumber(metric.stretch)) {
            return `scorecard metric "${metric.key}" stretch must be a finite number when set.`;
        }
        if (!SCORECARD_PERIODS.includes(metric.period)) {
            return `scorecard metric "${metric.key}" period must be one of: ${SCORECARD_PERIODS.join(', ')}.`;
        }
    }
    return null;
}
