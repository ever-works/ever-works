import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { RRule } from 'rrule';
import { parseCron } from '../missions/cron-matcher';
import type {
    ScheduleHealth,
    ScheduleHealthReason,
    ScheduleRepairClass,
    ScheduleRepairProposal,
    ScheduleSourceType,
} from './schedule-view.types';

/**
 * Schedules — "can this ever fire?" (the NEVER RUNS verdict).
 *
 * SATISFIABILITY, never look-ahead. `computeNextCronFire` walks at most 31
 * days and legitimately returns null for a yearly or a 29-February cadence;
 * deriving a defect from that null would flag healthy, merely infrequent
 * Schedules. Every reason below is a structural fact about the cadence, its
 * bounds or its owner — never "nothing in the window".
 *
 * Pure: no clock (`now` is an input), no repository. The projection gathers
 * the facts, this decides.
 */

/** Maximum number of flagged rows one health summary returns. */
export const SCHEDULE_HEALTH_FLAG_CAP = 200;

/** Upper bound of each month's length in ANY year (February: 29). */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Length of each month in EVERY year (February: 28) — the repair target. */
const MONTH_SAFE_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** How a source expresses its cadence. */
export type ScheduleCadenceKind = 'cron' | 'rrule' | 'interval' | 'work-cadence' | 'event';

/** Everything the verdict needs to know about one Schedule. */
export interface ScheduleHealthInput {
    sourceType: ScheduleSourceType;
    cadenceKind: ScheduleCadenceKind;
    /** Raw cadence string; null when the source stores none. */
    cadence: string | null;
    /** A pause the owner chose — never a defect (FR-41). */
    paused: boolean;
    /** The owner finished this on purpose (a completed Mission) — Ended, not NEVER RUNS. */
    ownerCompleted?: boolean;
    /** The owning Agent / Work is archived or no longer exists. */
    ownerArchived?: boolean;
    endsAt?: Date | null;
    maxOccurrences?: number | null;
    occurredCount?: number | null;
    /** A one-time instant this Schedule is bound to, when the source has one. */
    oneShotAt?: Date | null;
    oneShotClaimed?: boolean;
    /** The source needs an Agent to execute a fire. */
    requiresAgent?: boolean;
    /** At least one usable Agent resolved. Only read when `requiresAgent`. */
    agentResolved?: boolean;
    now: Date;
}

const REPAIR_CLASS: Record<ScheduleHealthReason, ScheduleRepairClass> = {
    'impossible-date': 'automatic',
    ended: 'automatic',
    exhausted: 'automatic',
    'past-one-shot': 'automatic',
    'no-agent': 'choice',
    'owner-archived': 'choice',
    unparseable: 'none',
};

const REASON_KEY: Record<ScheduleHealthReason, string> = {
    'impossible-date': 'impossibleDate',
    ended: 'ended',
    exhausted: 'exhausted',
    'past-one-shot': 'pastOneShot',
    unparseable: 'unparseable',
    'no-agent': 'noAgent',
    'owner-archived': 'ownerArchived',
};

export function repairClassFor(reason: ScheduleHealthReason): ScheduleRepairClass {
    return REPAIR_CLASS[reason];
}

function ok(now: Date): ScheduleHealth {
    return {
        ok: true,
        reason: null,
        reasonKey: null,
        repair: 'none',
        checkedAt: now.toISOString(),
    };
}

function flagged(reason: ScheduleHealthReason, now: Date): ScheduleHealth {
    return {
        ok: false,
        reason,
        reasonKey: REASON_KEY[reason],
        repair: REPAIR_CLASS[reason],
        checkedAt: now.toISOString(),
    };
}

type RRuleOrigOptions = RRule['origOptions'];

function parseRrule(rule: string): RRuleOrigOptions | null {
    try {
        const parsed = RRule.fromString(rule);
        if (parsed.options.freq === undefined || parsed.options.freq === null) return null;
        return parsed.origOptions;
    } catch {
        return null;
    }
}

function toNumberList(value: number | number[] | null | undefined): number[] {
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value : [value];
}

/** True when no named day-of-month exists in any named month, in any year. */
function daysImpossible(days: number[], months: number[]): boolean {
    const positive = days.filter((day) => day > 0);
    // A negative BYMONTHDAY counts from the end of the month and always
    // lands on a real day; an empty day set restricts nothing.
    if (positive.length === 0 || positive.length !== days.length) return false;
    const monthList = months.length > 0 ? months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    return monthList.every((month) =>
        positive.every((day) => day > (MONTH_MAX_DAYS[month - 1] ?? 31)),
    );
}

/** Cron impossibility: only when day-of-month alone narrows the day. */
function cronImpossible(expr: string): boolean {
    const parsed = parseCron(expr);
    // Standard cron OR semantics: a restricted day-of-week always fires somewhere.
    if (!parsed.domRestricted || parsed.dowRestricted) return false;
    return daysImpossible([...parsed.dayOfMonth], [...parsed.month]);
}

function rruleImpossible(options: RRuleOrigOptions): boolean {
    return daysImpossible(toNumberList(options.bymonthday), toNumberList(options.bymonth));
}

/**
 * The verdict: OK, or NEVER RUNS with exactly one reason. The checks run in
 * a fixed order so the reasons are mutually exclusive — the first structural
 * fact that makes the Schedule unfireable is the one reported.
 */
export function evaluateScheduleHealth(input: ScheduleHealthInput): ScheduleHealth {
    const { now } = input;
    if (input.paused || input.ownerCompleted) return ok(now);
    if (input.ownerArchived) return flagged('owner-archived', now);

    if (input.cadenceKind === 'cron') {
        if (!input.cadence) return flagged('unparseable', now);
        try {
            if (cronImpossible(input.cadence)) return flagged('impossible-date', now);
        } catch {
            return flagged('unparseable', now);
        }
    } else if (input.cadenceKind === 'rrule') {
        const options = input.cadence ? parseRrule(input.cadence) : null;
        if (!options) return flagged('unparseable', now);
        if (rruleImpossible(options)) return flagged('impossible-date', now);
        if (options.until && options.until.getTime() <= now.getTime()) {
            return flagged('ended', now);
        }
    }

    if (
        input.maxOccurrences !== null &&
        input.maxOccurrences !== undefined &&
        (input.occurredCount ?? 0) >= input.maxOccurrences
    ) {
        return flagged('exhausted', now);
    }
    if (input.endsAt && input.endsAt.getTime() <= now.getTime()) {
        return flagged('ended', now);
    }
    if (input.oneShotAt && !input.oneShotClaimed && input.oneShotAt.getTime() <= now.getTime()) {
        return flagged('past-one-shot', now);
    }
    if (input.requiresAgent && !input.agentResolved) {
        return flagged('no-agent', now);
    }
    return ok(now);
}

function hashState(state: unknown): string {
    return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

/** Rewrite a cron day-of-month field so it names only days every named month has. */
function clampCronDays(expr: string): string | null {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const parsed = parseCron(expr);
    const months = [...parsed.month];
    const limit = Math.min(...months.map((month) => MONTH_SAFE_DAYS[month - 1] ?? 28));
    const days = [...new Set([...parsed.dayOfMonth].map((day) => Math.min(day, limit)))].sort(
        (a, b) => a - b,
    );
    parts[2] = days.join(',');
    return parts.join(' ');
}

function clampRruleDays(rule: string): string | null {
    const options = parseRrule(rule);
    if (!options) return null;
    const months = toNumberList(options.bymonth);
    const monthList = months.length > 0 ? months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const limit = Math.min(...monthList.map((month) => MONTH_SAFE_DAYS[month - 1] ?? 28));
    const days = [
        ...new Set(toNumberList(options.bymonthday).map((day) => Math.min(day, limit))),
    ].sort((a, b) => a - b);
    return rule.replace(/BYMONTHDAY=[^;]*/i, `BYMONTHDAY=${days.join(',')}`);
}

/** What a repair would change, for one flagged Schedule. */
export interface ScheduleRepairInput {
    health: ScheduleHealth;
    cadenceKind: ScheduleCadenceKind;
    cadence: string | null;
    endsAt?: Date | null;
    maxOccurrences?: number | null;
    oneShotAt?: Date | null;
    now: Date;
}

/**
 * Propose — never apply — the repair for a flagged Schedule. `before` and
 * `after` are the exact values a repair would swap; `beforeHash` fingerprints
 * the before-state so an apply can refuse a Schedule that changed since it
 * was previewed. `choice` and `none` reasons carry no `after`.
 */
export function proposeScheduleRepair(input: ScheduleRepairInput): ScheduleRepairProposal {
    const reason = input.health.reason;
    if (input.health.ok || !reason) {
        return { repair: 'none', before: null, after: null, beforeHash: null };
    }
    const repair = REPAIR_CLASS[reason];
    const beforeState = {
        cadence: input.cadence,
        endsAt: input.endsAt ? input.endsAt.toISOString() : null,
        maxOccurrences: input.maxOccurrences ?? null,
        oneShotAt: input.oneShotAt ? input.oneShotAt.toISOString() : null,
    };
    const beforeHash = hashState(beforeState);

    if (repair !== 'automatic') {
        return { repair, before: input.cadence, after: null, beforeHash };
    }

    try {
        switch (reason) {
            case 'impossible-date': {
                if (!input.cadence) break;
                const after =
                    input.cadenceKind === 'rrule'
                        ? clampRruleDays(input.cadence)
                        : clampCronDays(input.cadence);
                return { repair, before: input.cadence, after, beforeHash };
            }
            case 'ended': {
                const until =
                    input.cadenceKind === 'rrule' && input.cadence
                        ? input.cadence.replace(/;?UNTIL=[^;]*/i, '').replace(/^;/, '')
                        : null;
                if (until && until !== input.cadence) {
                    return { repair, before: input.cadence, after: until, beforeHash };
                }
                return {
                    repair,
                    before: beforeState.endsAt,
                    after: null,
                    afterKey: 'clearEndDate',
                    beforeHash,
                };
            }
            case 'exhausted':
                return {
                    repair,
                    before:
                        input.maxOccurrences === null || input.maxOccurrences === undefined
                            ? null
                            : String(input.maxOccurrences),
                    after: null,
                    afterKey: 'clearOccurrenceCap',
                    beforeHash,
                };
            case 'past-one-shot': {
                if (!input.oneShotAt) break;
                const floor = input.now.getTime() + 5 * 60_000;
                const next = new Date(input.now);
                next.setUTCHours(
                    input.oneShotAt.getUTCHours(),
                    input.oneShotAt.getUTCMinutes(),
                    0,
                    0,
                );
                while (next.getTime() < floor) {
                    next.setUTCDate(next.getUTCDate() + 1);
                }
                return {
                    repair,
                    before: input.oneShotAt.toISOString(),
                    after: next.toISOString(),
                    beforeHash,
                };
            }
            default:
                break;
        }
    } catch {
        // A cadence that cannot be rewritten is reported without an `after`.
    }
    return { repair, before: input.cadence, after: null, beforeHash };
}

/**
 * Injectable face of the verdict so services and controllers can depend on
 * it (and tests can substitute it). Stateless — both methods delegate to the
 * pure functions above.
 */
@Injectable()
export class ScheduleHealthService {
    evaluate(input: ScheduleHealthInput): ScheduleHealth {
        return evaluateScheduleHealth(input);
    }

    proposeRepair(input: ScheduleRepairInput): ScheduleRepairProposal {
        return proposeScheduleRepair(input);
    }
}
