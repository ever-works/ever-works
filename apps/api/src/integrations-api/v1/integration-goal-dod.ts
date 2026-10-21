import type { GoalDoDCriterion } from '@ever-works/agent/goals';

/**
 * Works-security lane (integration API gates, finding 1) — what an
 * integration key WITHOUT `X-Act-As-User` may do to a Goal's Definition of
 * Done: propose. Nothing else.
 *
 * A Definition of Done is the finish line of an autonomous loop: an approved
 * criterion is an instruction the next iteration brief hands the agent as the
 * owner's own words, and "every approved criterion done or waived" COMPLETES a
 * delivery Goal (COMPLETED / ACHIEVED) with no person involved. The core route
 * (`PUT /api/goals/:id/dod`) refuses machine principals and approving a
 * proposal needs a person's session; the integration route used to write the
 * whole set as the operator's own (approved, `source: operator`). This planner
 * splits a key-only `PUT /goals/:id/dod` body into:
 *
 * - **proposals**: criteria the Goal does not have yet, written OPEN through
 *   `GoalOrchestratorService.proposeDodCriteria` (inert until a person
 *   approves them: excluded from the completion rollup and the brief);
 * - **refusals**: everything a person decides — a new criterion that is
 *   already done or waived, any change to an approved criterion's text or
 *   status (or to evidence / note the body explicitly sends), removing an
 *   approved criterion (removing the last open one would complete the Goal),
 *   and any change to a pending proposal.
 *
 * An unchanged echo of an approved criterion or of a proposal is a no-op (a
 * full-set PUT that only mirrors state writes nothing), and naming a proposal
 * NEVER approves it. A pending proposal the body leaves out is kept, as before
 * (Gauzy CR-12).
 */

/** One body entry of `PUT /goals/:id/dod` (absent evidence / note = `undefined`). */
export interface IntegrationDodEntry {
    id: string;
    text: string;
    status: 'open' | 'done' | 'waived';
    evidence?: string | null;
    note?: string | null;
}

export type IntegrationDodRefusalReason =
    /** A NEW criterion sent as done or waived: signing it off is a person's call. */
    | 'closed_status'
    /** An approved criterion's text / status / evidence / note would change. */
    | 'approved_changed'
    /** An approved criterion is missing from the full set (it would be removed). */
    | 'approved_removed'
    /** A pending proposal would change (or be marked done / waived). */
    | 'proposal_changed';

export interface IntegrationDodRefusal {
    id: string;
    reason: IntegrationDodRefusalReason;
}

export interface IntegrationDodPlan {
    /** New criteria to propose (open, awaiting a person's approval). */
    proposals: GoalDoDCriterion[];
    /** What a key without a person may not do; non-empty = refuse the request. */
    refusals: IntegrationDodRefusal[];
}

/** Trimmed text / `null` for an empty optional field — the shape `normalizeDoDCriteria` stores. */
function optionalText(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
}

/** Whether the body entry changes `existing` (absent evidence / note = keep). */
function changes(entry: IntegrationDodEntry, existing: GoalDoDCriterion): boolean {
    if (entry.text.trim() !== (existing.text ?? '').trim()) return true;
    if (entry.status !== existing.status) return true;
    if (
        entry.evidence !== undefined &&
        optionalText(entry.evidence) !== optionalText(existing.evidence)
    ) {
        return true;
    }
    if (entry.note !== undefined && optionalText(entry.note) !== optionalText(existing.note)) {
        return true;
    }
    return false;
}

export function planKeyOnlyDodWrite(
    current: readonly GoalDoDCriterion[] | null | undefined,
    body: readonly IntegrationDodEntry[],
): IntegrationDodPlan {
    const existing = new Map<string, GoalDoDCriterion>();
    for (const criterion of current ?? []) existing.set(criterion.id.trim(), criterion);

    const proposals: GoalDoDCriterion[] = [];
    const refusals: IntegrationDodRefusal[] = [];
    const named = new Set<string>();

    for (const entry of body) {
        const id = entry.id.trim();
        named.add(id);
        const stored = existing.get(id);
        if (!stored) {
            if (entry.status !== 'open') {
                refusals.push({ id, reason: 'closed_status' });
                continue;
            }
            proposals.push({
                id,
                text: entry.text,
                status: 'open',
                evidence: entry.evidence ?? null,
                note: entry.note ?? null,
            });
            continue;
        }
        if (!changes(entry, stored)) continue;
        refusals.push({
            id,
            reason: stored.proposed === true ? 'proposal_changed' : 'approved_changed',
        });
    }

    for (const [id, stored] of existing) {
        if (stored.proposed !== true && !named.has(id)) {
            refusals.push({ id, reason: 'approved_removed' });
        }
    }

    return { proposals, refusals };
}

/** The 422 message for a refused key-only Definition-of-Done write. */
export function describeDodRefusals(refusals: readonly IntegrationDodRefusal[]): string {
    const ids = refusals.map((refusal) => refusal.id).join(', ');
    return (
        `An integration key without X-Act-As-User may only propose new open Definition-of-Done criteria; ` +
        `marking one done or waived, changing or removing an approved one, and changing or approving a ` +
        `proposal are a person's decisions (criteria: ${ids}). Send the person's decision with ` +
        'X-Act-As-User, or make it in Ever Works.'
    );
}
