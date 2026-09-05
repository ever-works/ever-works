import {
    MAX_DOD_TEXT_CHARS,
    MAX_GOAL_DOD_CRITERIA,
    type GoalComparator,
    type GoalKind,
    type GoalWindow,
} from '@/lib/api/goals.shared';
import type { CreateGoalInput, GoalDoDCriterion } from '@/lib/api/goals';

/**
 * Goals & Metrics — the pure half of `GoalForm` (self-build slice AG,
 * EW-795). Free of React and of the `server-only` module so the
 * accept/reject decision and the EXACT wire payload for each Goal kind can
 * be unit-tested without rendering the form — the same reasoning as
 * `goal-target-validation.unit.spec.ts`, whose guard now lives here.
 */

export type GoalFormErrorKey =
    | 'errors.titleRequired'
    | 'errors.metricSourceRequired'
    | 'errors.targetInvalid'
    | 'errors.unitRequired'
    | 'errors.dodRequired';

export interface GoalFormFields {
    title: string;
    description: string;
    /** Metric kind only. */
    pluginId: string;
    metricId: string;
    params?: Record<string, unknown>;
    comparator: GoalComparator;
    /** Raw text from the number input — validated here, never coerced first. */
    targetValue: string;
    unit: string;
    window: GoalWindow;
    /** Delivery kind only: one Definition-of-Done criterion per line. */
    dodText: string;
    /** Both kinds. */
    deadline: string | null;
    checkFrequencyMinutes: number;
}

/**
 * EW-044: `Number('')` is 0, NOT NaN, so an EMPTY target used to sail
 * through as a real target of 0 — with the default comparator `gte` that
 * is a Goal every value satisfies. The empty case is rejected explicitly,
 * before the conversion; `Number(' ')` is 0 too, hence the trim.
 */
export function targetValueIsAcceptable(raw: string): boolean {
    const trimmed = raw.trim();
    return trimmed.length > 0 && Number.isFinite(Number(trimmed));
}

/**
 * One approved criterion per non-blank line. Ids are positional
 * (`dod-1`, `dod-2`, …): unique within the submitted list, which is all
 * the server requires, and renameable from the Goal page. Capped at the
 * server bounds so the form refuses locally what the API would refuse.
 */
export function parseDodLines(text: string): GoalDoDCriterion[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, MAX_GOAL_DOD_CRITERIA)
        .map((line, index) => ({
            id: `dod-${index + 1}`,
            text: line.slice(0, MAX_DOD_TEXT_CHARS),
            status: 'open' as const,
            source: 'operator' as const,
        }));
}

/**
 * The accept/reject decision, as the i18n key of the FIRST problem. The
 * metric checks run in the same order as before the kind existed, so the
 * error a user sees for a given form state is unchanged.
 */
export function validateGoalFormFields(
    kind: GoalKind,
    fields: GoalFormFields,
): GoalFormErrorKey | null {
    if (fields.title.trim().length < 1) return 'errors.titleRequired';
    if (kind === 'delivery') {
        return parseDodLines(fields.dodText).length === 0 ? 'errors.dodRequired' : null;
    }
    if (!fields.pluginId.trim() || !fields.metricId.trim()) return 'errors.metricSourceRequired';
    if (!targetValueIsAcceptable(fields.targetValue)) return 'errors.targetInvalid';
    if (!fields.unit.trim()) return 'errors.unitRequired';
    return null;
}

/**
 * The exact `POST /me/goals` body for the chosen kind.
 *
 * A DELIVERY payload carries NO metric key at all — not `undefined`, not
 * `null`. `JSON.stringify` would drop `undefined` anyway, but the object
 * itself must not pretend to have a target: the API refuses a delivery
 * Goal with any metric field present, and a spec that only inspected the
 * serialised form could not tell "absent" from "undefined".
 *
 * A METRIC payload is what the form always sent — no `goalKind` key (the
 * API defaults an omitted kind to `metric`), so every existing client and
 * pinned e2e contract is untouched.
 */
export function buildCreateGoalPayload(kind: GoalKind, fields: GoalFormFields): CreateGoalInput {
    const base = {
        title: fields.title.trim(),
        description: fields.description.trim() || null,
        deadline: fields.deadline,
        checkFrequencyMinutes: fields.checkFrequencyMinutes,
    };
    if (kind === 'delivery') {
        return {
            ...base,
            goalKind: 'delivery',
            dodCriteria: parseDodLines(fields.dodText),
        };
    }
    return {
        ...base,
        metricSource: {
            pluginId: fields.pluginId.trim(),
            metricId: fields.metricId.trim(),
            ...(fields.params ? { params: fields.params } : {}),
        },
        comparator: fields.comparator,
        targetValue: Number(fields.targetValue.trim()),
        unit: fields.unit.trim(),
        window: fields.window,
    };
}
