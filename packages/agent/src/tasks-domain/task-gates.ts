import {
    WORK_CHECKS_POLICIES,
    type GateStatus,
    type GateVerdict,
    type TaskAcceptanceCheck,
    type TaskGateJudgement,
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
type TaskCriteriaSource = Partial<Pick<Task, 'description'>> | null | undefined;
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
 * Judgment layer G2 — the L0 subset of a resolved check list.
 *
 * `level` is optional on `TaskAcceptanceCheck` and defaults to `'L1'`, so
 * a repo full of pre-G2 checks yields an EMPTY list here and the
 * pre-check pass never runs. Opting a check in is a one-word edit
 * (`level: 'L0'`), which is the whole point: the pre-check is only as
 * cheap as the commands an operator declares for it.
 */
export function resolveL0Checks(checks: readonly TaskAcceptanceCheck[]): TaskAcceptanceCheck[] {
    return checks.filter((check) => check?.level === 'L0');
}

/**
 * Should the cheap L0 pre-check run for this run?
 *
 * THREE conditions, all required, and the order is the cost order:
 * the operator switch (free), then a declared L0 check (free), then the
 * Work's policy being something other than `off` (free). Only when all
 * three hold does a subprocess get spawned before the model call.
 *
 * `policy === 'off'` disqualifies deliberately: a Work that has switched
 * its gate off is telling the platform not to run its check commands, and
 * "except before the model call" would be a surprising exception to that.
 */
export function shouldRunL0PreCheck(input: {
    enabled: boolean;
    policy: WorkChecksPolicy;
    l0Checks: readonly TaskAcceptanceCheck[];
}): boolean {
    return input.enabled && input.policy !== 'off' && input.l0Checks.length > 0;
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

/**
 * Judgment layer G2 — the Task's acceptance criteria, as prose a judge can
 * grade a run against.
 *
 * The platform has no dedicated criteria column, and inventing one would
 * put the same sentence in two places. The Task ALREADY states what "done"
 * means: its description is the ask, and its resolved checks are the
 * mechanical half of the same contract. This composes both.
 *
 * Returns `''` when the Task has no description. That is load-bearing:
 * `shouldRunGateJudge` treats empty criteria as "no judge configured", so
 * a Task that never said what done means is never graded by opinion. The
 * alternative — judging against the title alone — makes the verdict a coin
 * flip, and a coin flip that can withhold a PR is worse than no judge.
 */
export function resolveAcceptanceCriteria(
    task: TaskCriteriaSource,
    checks: readonly TaskAcceptanceCheck[] = [],
): string {
    const description = typeof task?.description === 'string' ? task.description.trim() : '';
    if (!description) return '';

    const named = checks
        .filter((check) => check?.required !== false)
        .map((check) => (check?.name || check?.id || '').trim())
        .filter((label) => label.length > 0);
    if (named.length === 0) return description;
    return `${description}\n\nDeclared acceptance checks: ${named.join(', ')}.`;
}

/**
 * Should the LLM acceptance-criteria judge run for this graded attempt?
 *
 * FOUR conditions, all required, ordered by cost — the first three are
 * free, and only when all four hold does a model call happen:
 *
 * 1. the operator switch is on (`AGENT_GATE_JUDGE`, default **off**);
 * 2. the Work's policy is `required` — under `warn` the operator said
 *    "report, do not block", and a judge that can withhold a PR would
 *    contradict that; under `off` nothing grades at all;
 * 3. the checks came back `green` — a red gate already has a verdict, and
 *    paying a model to agree with a nonzero exit code buys nothing;
 * 4. the Task actually declares criteria (see
 *    {@link resolveAcceptanceCriteria}).
 *
 * With any of them false the gate behaves byte-for-byte as it did before
 * the judge existed.
 */
export function shouldRunGateJudge(input: {
    enabled: boolean;
    policy: WorkChecksPolicy;
    gateStatus: GateStatus;
    criteria: string;
}): boolean {
    return (
        input.enabled &&
        input.policy === 'required' &&
        input.gateStatus === 'green' &&
        typeof input.criteria === 'string' &&
        input.criteria.trim().length > 0
    );
}

/**
 * Judgment layer G2 — collapse "what the checks observed" + "what the
 * judge thinks" + "is there budget left" into the one decision the worker
 * acts on.
 *
 * Pure and total, because it is the single place the gate's control flow
 * is decided and every branch of it is a product behavior somebody can be
 * surprised by:
 *
 * - policy `off` → `pass`. The gate never ran.
 * - `red` under `required` → `retry` while attempts remain, else `fail`.
 *   Exactly the pre-judge iterate loop.
 * - `red` under `warn` → `pass`. Warn reports; it never blocks.
 * - `skipped` / `none` under `required` → `fail`. A required policy that
 *   resolved zero checks must not ship a PR on the strength of a gate that
 *   did not run (pre-judge behavior, preserved verbatim).
 * - `green` → whatever the judge said, or `pass` when there is no judge.
 *   A judge `retry` with no attempts left becomes `escalate`: the agent
 *   has spent its budget and the criteria are still unmet, which is a
 *   human's decision, not another loop.
 */
export function resolveGateVerdict(input: {
    gateStatus: GateStatus;
    policy: WorkChecksPolicy;
    judgement?: TaskGateJudgement | null;
    /** `true` when another gate attempt is still inside the budget. */
    attemptsRemaining: boolean;
}): GateVerdict {
    if (input.policy === 'off') return 'pass';

    if (input.gateStatus === 'red') {
        if (input.policy !== 'required') return 'pass';
        return input.attemptsRemaining ? 'retry' : 'fail';
    }

    // 'skipped' / 'none' — nothing was graded, so there is nothing for
    // another attempt to fix and no judge ran (`shouldRunGateJudge`
    // requires a green gate).
    if (input.gateStatus !== 'green') {
        return input.policy === 'required' ? 'fail' : 'pass';
    }

    const judgement = input.judgement;
    if (!judgement) return 'pass';
    if (judgement.verdict === 'escalate') return 'escalate';
    if (judgement.verdict === 'retry') return input.attemptsRemaining ? 'retry' : 'escalate';
    return 'pass';
}
