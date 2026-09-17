import {
    ACTION_CATEGORY_CEILING,
    LADDERED_CATEGORIES,
    READINESS_MIN_APPROVAL_RATE,
    READINESS_MIN_DECISIONS,
    READINESS_WINDOW_DAYS,
    compareRung,
    isDraftableCategory,
    nextRungUp,
    type LadderedActionCategory,
    type ReadinessBlocker,
    type ReadinessDecisionSample,
    type ReadinessDto,
    type TrustRung,
} from '@ever-works/contracts';

/**
 * Safety rails (AW-24) — readiness, computed and NEVER applied.
 *
 * A category is Ready when, over the trailing 30 days: at least 20 decisions
 * in it were answered, at least 95% were approved, none were withdrawn, and
 * no other rail refused anything in it (FR-35).
 *
 * Pure, no-IO, no model. The four thresholds live in contracts so this
 * function and the screen cannot disagree about the arithmetic, and so a test
 * can pin each one at its boundary.
 *
 * 🛑 Nothing in this file writes a rung, and nothing that writes a rung reads
 * this file. Readiness is a statement about the record; promotion is a
 * decision a person makes. FR-36 makes that explicit, and it is the reason
 * "Nothing graduates itself" is on the promotion surface rather than being
 * left to be inferred.
 */

export interface ComputeReadinessInput {
    decisions: readonly ReadinessDecisionSample[];
    /** Refusals by any rail OTHER than the ladder, counted per category. */
    otherRefusalsByCategory?: Readonly<Partial<Record<LadderedActionCategory, number>>>;
    /** The rung each category is on now, so the panel can name the next one. */
    currentRungs?: Readonly<Partial<Record<LadderedActionCategory, TrustRung>>>;
    now?: Date;
}

/** Readiness for every laddered category, in ladder order. */
export function computeReadiness(input: ComputeReadinessInput): ReadinessDto[] {
    const now = input.now ?? new Date();
    const windowStart = now.getTime() - READINESS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const tallies = new Map<
        LadderedActionCategory,
        { approved: number; rejected: number; withdrawn: number }
    >();
    for (const decision of input.decisions) {
        const at = toMillis(decision.decidedAt);
        if (at === null || at < windowStart || at > now.getTime()) continue;
        const tally = tallies.get(decision.category) ?? {
            approved: 0,
            rejected: 0,
            withdrawn: 0,
        };
        tally[decision.outcome] += 1;
        tallies.set(decision.category, tally);
    }

    return LADDERED_CATEGORIES.map((category) => {
        const tally = tallies.get(category) ?? { approved: 0, rejected: 0, withdrawn: 0 };
        const answered = tally.approved + tally.rejected + tally.withdrawn;
        const approvalRate = answered === 0 ? 0 : tally.approved / answered;
        const otherRefusals = input.otherRefusalsByCategory?.[category] ?? 0;

        const ceiling = ACTION_CATEGORY_CEILING[category];
        const current = input.currentRungs?.[category] ?? null;
        const nextRung =
            current === null
                ? null
                : atCeiling(current, ceiling)
                  ? null
                  : nextRungUp(current, isDraftableCategory(category));

        const blockedBy = firstBlocker({
            atCeiling: current !== null && nextRung === null,
            answered,
            approvalRate,
            withdrawn: tally.withdrawn,
            otherRefusals,
        });

        return {
            category,
            ready: blockedBy === null,
            windowDays: READINESS_WINDOW_DAYS,
            answered,
            approved: tally.approved,
            rejected: tally.rejected,
            withdrawn: tally.withdrawn,
            approvalRate,
            otherRefusals,
            nextRung,
            blockedBy,
        };
    });
}

function atCeiling(current: TrustRung, ceiling: TrustRung): boolean {
    return compareRung(current, ceiling) >= 0;
}

/**
 * The first unmet condition, in a fixed order, so the panel names ONE thing to
 * fix rather than four. "Already at the ceiling" comes first because no amount
 * of record changes it.
 */
function firstBlocker(state: {
    atCeiling: boolean;
    answered: number;
    approvalRate: number;
    withdrawn: number;
    otherRefusals: number;
}): ReadinessBlocker | null {
    if (state.atCeiling) return 'at-ceiling';
    if (state.answered < READINESS_MIN_DECISIONS) return 'too-few-decisions';
    if (state.approvalRate < READINESS_MIN_APPROVAL_RATE) return 'approval-rate';
    if (state.withdrawn > 0) return 'withdrawn';
    if (state.otherRefusals > 0) return 'other-refusals';
    return null;
}

function toMillis(value: string | number | Date): number | null {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}
