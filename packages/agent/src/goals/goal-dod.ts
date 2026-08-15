import {
    GOAL_DOD_SOURCES,
    GOAL_DOD_STATUSES,
    type Goal,
    type GoalDoDCriterion,
    type GoalDoDStatus,
} from '../entities/goal.entity';

/**
 * Autonomy layer — pure helpers for the Definition-of-Done checklist.
 *
 * Side-effect free and taking plain row shapes, exactly like
 * `goal-criteria.ts`: the orchestrator, the write-path validator, the API
 * layer and the specs all share ONE set of rules rather than four
 * re-derivations that drift apart.
 */

/** Bounds on how much DoD structure one Goal may carry (simple-json is a text column). */
export const MAX_GOAL_DOD_CRITERIA = 50;
export const MAX_DOD_TEXT_CHARS = 500;
export const MAX_DOD_EVIDENCE_CHARS = 1000;
export const MAX_DOD_NOTE_CHARS = 500;
export const MAX_DOD_ID_CHARS = 64;

/** Serialized-size cap for the whole `dodCriteria` column. */
export const MAX_GOAL_DOD_JSON_CHARS = 64_000;

export interface GoalDoDValidationError {
    field: string;
    message: string;
}

/**
 * Rollup rendered as "N done · N waived · N open".
 *
 * `proposed` criteria are counted SEPARATELY and excluded from `total`,
 * `open` and `complete`. That is the whole safety property of the
 * planner-approval flow: a planning run that appends five criteria must
 * not be able to move the completion bar (in either direction) before an
 * operator has looked at them.
 */
export interface GoalDoDSummary {
    /** Approved criteria only. */
    total: number;
    done: number;
    waived: number;
    open: number;
    /** Awaiting operator approval; excluded from every other count. */
    proposed: number;
    /** `done + waived` — criteria that need no further work. */
    closed: number;
    /** True when there is at least one approved criterion and none is open. */
    complete: boolean;
}

/** A criterion is APPROVED unless it explicitly says it is still proposed. */
export function isApprovedDoDCriterion(criterion: Pick<GoalDoDCriterion, 'proposed'>): boolean {
    return criterion.proposed !== true;
}

/** Criteria declared on the Goal, defensively normalized to an array. */
export function resolveDoDCriteria(
    goal: Pick<Goal, 'dodCriteria'> | null | undefined,
): GoalDoDCriterion[] {
    return Array.isArray(goal?.dodCriteria) ? goal.dodCriteria : [];
}

/** Does this Goal carry a Definition of Done at all (approved entries only)? */
export function hasDefinitionOfDone(goal: Pick<Goal, 'dodCriteria'> | null | undefined): boolean {
    return resolveDoDCriteria(goal).some(isApprovedDoDCriterion);
}

export function summarizeDoD(criteria: GoalDoDCriterion[] | null | undefined): GoalDoDSummary {
    const list = Array.isArray(criteria) ? criteria : [];
    const summary: GoalDoDSummary = {
        total: 0,
        done: 0,
        waived: 0,
        open: 0,
        proposed: 0,
        closed: 0,
        complete: false,
    };
    for (const criterion of list) {
        if (!isApprovedDoDCriterion(criterion)) {
            summary.proposed += 1;
            continue;
        }
        summary.total += 1;
        if (criterion.status === 'done') summary.done += 1;
        else if (criterion.status === 'waived') summary.waived += 1;
        else summary.open += 1;
    }
    summary.closed = summary.done + summary.waived;
    summary.complete = summary.total > 0 && summary.open === 0;
    return summary;
}

/**
 * A stable fingerprint of "how much of the DoD is closed".
 *
 * Stuck detection compares this across iterations: when it is unchanged,
 * the loop spent an iteration without moving the finish line. It
 * deliberately ignores `evidence`/`note` edits — rewording why something
 * was waived is not progress — and ignores ORDER, so re-sorting the
 * checklist does not read as work.
 */
export function dodProgressSignature(criteria: GoalDoDCriterion[] | null | undefined): string {
    const list = (Array.isArray(criteria) ? criteria : [])
        .filter(isApprovedDoDCriterion)
        .map((criterion) => `${criterion.id}:${criterion.status}`)
        .sort();
    return list.join('|');
}

/**
 * Validate a submitted DoD list, reporting EVERY problem at once.
 *
 * Returns a list rather than throwing so the calling service owns the
 * exception type — the same idiom as `validateGoalJudgment`.
 */
export function validateDoDCriteria(criteria: unknown): GoalDoDValidationError[] {
    const errors: GoalDoDValidationError[] = [];
    if (criteria == null) return errors;
    if (!Array.isArray(criteria)) {
        return [{ field: 'dodCriteria', message: 'dodCriteria must be an array' }];
    }
    if (criteria.length > MAX_GOAL_DOD_CRITERIA) {
        errors.push({
            field: 'dodCriteria',
            message: `at most ${MAX_GOAL_DOD_CRITERIA} criteria are allowed`,
        });
    }

    const seen = new Set<string>();
    for (const entry of criteria as GoalDoDCriterion[]) {
        if (!entry || typeof entry !== 'object') {
            errors.push({ field: 'dodCriteria', message: 'every criterion must be an object' });
            continue;
        }
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!id) {
            errors.push({ field: 'dodCriteria', message: 'every criterion needs a non-empty id' });
            continue;
        }
        if (id.length > MAX_DOD_ID_CHARS) {
            errors.push({
                field: 'dodCriteria',
                message: `criterion id '${id.slice(0, 16)}…' exceeds ${MAX_DOD_ID_CHARS} characters`,
            });
        }
        if (seen.has(id)) {
            errors.push({ field: 'dodCriteria', message: `duplicate criterion id '${id}'` });
        }
        seen.add(id);

        if (typeof entry.text !== 'string' || entry.text.trim().length === 0) {
            errors.push({
                field: 'dodCriteria',
                message: `criterion '${id}' needs non-empty text`,
            });
        } else if (entry.text.length > MAX_DOD_TEXT_CHARS) {
            errors.push({
                field: 'dodCriteria',
                message: `criterion '${id}' text exceeds ${MAX_DOD_TEXT_CHARS} characters`,
            });
        }

        if (!GOAL_DOD_STATUSES.includes(entry.status)) {
            errors.push({
                field: 'dodCriteria',
                message: `criterion '${id}' status must be one of ${GOAL_DOD_STATUSES.join(', ')}`,
            });
        }

        if (entry.source !== undefined && !GOAL_DOD_SOURCES.includes(entry.source)) {
            errors.push({
                field: 'dodCriteria',
                message: `criterion '${id}' source must be one of ${GOAL_DOD_SOURCES.join(', ')}`,
            });
        }

        if (
            entry.evidence !== undefined &&
            entry.evidence !== null &&
            (typeof entry.evidence !== 'string' || entry.evidence.length > MAX_DOD_EVIDENCE_CHARS)
        ) {
            errors.push({
                field: 'dodCriteria',
                message: `criterion '${id}' evidence must be a string of at most ${MAX_DOD_EVIDENCE_CHARS} characters`,
            });
        }

        if (
            entry.note !== undefined &&
            entry.note !== null &&
            (typeof entry.note !== 'string' || entry.note.length > MAX_DOD_NOTE_CHARS)
        ) {
            errors.push({
                field: 'dodCriteria',
                message: `criterion '${id}' note must be a string of at most ${MAX_DOD_NOTE_CHARS} characters`,
            });
        }
    }

    if (JSON.stringify(criteria ?? []).length > MAX_GOAL_DOD_JSON_CHARS) {
        errors.push({ field: 'dodCriteria', message: 'dodCriteria payload is too large' });
    }

    return errors;
}

/**
 * Normalize a validated list into the exact shape persisted on the row:
 * trimmed strings, explicit nulls instead of undefined for the optional
 * text fields, an `updatedAt` stamp, and no stray properties from the
 * wire. Callers MUST run {@link validateDoDCriteria} first — this
 * function assumes a valid shape and only canonicalizes it.
 */
export function normalizeDoDCriteria(
    criteria: GoalDoDCriterion[],
    now: Date = new Date(),
): GoalDoDCriterion[] {
    const stamp = now.toISOString();
    return criteria.map((entry) => {
        const normalized: GoalDoDCriterion = {
            id: entry.id.trim().slice(0, MAX_DOD_ID_CHARS),
            text: entry.text.trim().slice(0, MAX_DOD_TEXT_CHARS),
            status: entry.status as GoalDoDStatus,
            evidence: normalizeOptionalText(entry.evidence, MAX_DOD_EVIDENCE_CHARS),
            note: normalizeOptionalText(entry.note, MAX_DOD_NOTE_CHARS),
            source: entry.source ?? 'operator',
            updatedAt: entry.updatedAt ?? stamp,
        };
        // `proposed` is only ever written as `true`; omitting the key on an
        // approved criterion keeps the stored JSON small and makes
        // `proposed !== true` the single approval predicate everywhere.
        if (entry.proposed === true) {
            normalized.proposed = true;
        }
        return normalized;
    });
}

function normalizeOptionalText(value: string | null | undefined, max: number): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed.slice(0, max);
}
