import {
    WORK_CHECKS_POLICIES,
    type TaskAcceptanceCheck,
    type WorkChecksPolicy,
} from '@ever-works/contracts';
import type { Task } from '../entities/task.entity';
import type { Work } from '../entities/work.entity';

/**
 * Quality gates — pure resolution helpers (Wave 3 M1, schema milestone).
 *
 * Everything here is side-effect free and takes plain row shapes, so the
 * eventual gate runner, the API layer, and tests all share one set of
 * inheritance rules instead of re-deriving them.
 */

/** Bounds for the gate-attempt budget. The clamp exists because the value
 *  reaches us from three writable places (Task column, Work column, import
 *  payloads) and an out-of-range number must never grant an unbounded
 *  retry loop (or a zero-attempt deadlock). */
export const MIN_GATE_ATTEMPTS = 1;
export const MAX_GATE_ATTEMPTS = 5;
export const DEFAULT_GATE_ATTEMPTS = 2;

type TaskChecksSource = Partial<Pick<Task, 'acceptanceChecks'>> | null | undefined;
type WorkChecksSource = Partial<Pick<Work, 'checkDefaults'>> | null | undefined;
type TaskAttemptsSource = Partial<Pick<Task, 'maxGateAttempts'>> | null | undefined;
type WorkAttemptsSource = Partial<Pick<Work, 'maxGateAttempts'>> | null | undefined;
type WorkPolicySource = Partial<Pick<Work, 'checksPolicy'>> | null | undefined;

/**
 * Resolve the acceptance checks an agent run is judged by.
 *
 * Inheritance: the Work's `checkDefaults` are the base; the Task's
 * `acceptanceChecks` merge over them by id —
 *   - a Task entry with a NEW id is appended;
 *   - a Task entry with the SAME id as a Work default replaces it
 *     wholesale (no field-level merging);
 *   - a Task entry with `disabled: true` therefore suppresses the
 *     inherited default without redeclaring the rest.
 * Disabled entries are filtered from the result, so executors can run the
 * returned list as-is. Order is stable: Work defaults first (in declared
 * order), then Task-only additions (in declared order).
 */
export function resolveAcceptanceChecks(
    task: TaskChecksSource,
    work: WorkChecksSource,
): TaskAcceptanceCheck[] {
    // Array.isArray (not truthiness) — both columns are simple-json, so a
    // hand-edited or imported row could hold any JSON shape.
    const defaults = Array.isArray(work?.checkDefaults) ? work.checkDefaults : [];
    const declared = Array.isArray(task?.acceptanceChecks) ? task.acceptanceChecks : null;

    if (!declared) {
        return defaults.filter((check) => check?.disabled !== true);
    }

    const merged = new Map<string, TaskAcceptanceCheck>();
    for (const check of defaults) {
        if (check?.id) merged.set(check.id, check);
    }
    for (const check of declared) {
        if (check?.id) merged.set(check.id, check);
    }
    return [...merged.values()].filter((check) => check.disabled !== true);
}

/**
 * Resolve the Work's enforcement policy. Anything that is not a known
 * policy value — including `undefined` on a partially-selected row —
 * resolves to `'off'`: an unrecognized policy must fail toward "don't run
 * checks", never toward blocking a Task.
 */
export function resolveChecksPolicy(work: WorkPolicySource): WorkChecksPolicy {
    const policy = work?.checksPolicy;
    return typeof policy === 'string' &&
        (WORK_CHECKS_POLICIES as readonly string[]).includes(policy)
        ? (policy as WorkChecksPolicy)
        : 'off';
}

/**
 * Resolve the gate-attempt budget: Task value, else Work value, else 2 —
 * always clamped to 1..5 (fractions truncate toward the clamp range).
 */
export function resolveMaxGateAttempts(task: TaskAttemptsSource, work: WorkAttemptsSource): number {
    const raw = task?.maxGateAttempts ?? work?.maxGateAttempts ?? DEFAULT_GATE_ATTEMPTS;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return DEFAULT_GATE_ATTEMPTS;
    }
    return Math.min(MAX_GATE_ATTEMPTS, Math.max(MIN_GATE_ATTEMPTS, Math.trunc(raw)));
}
