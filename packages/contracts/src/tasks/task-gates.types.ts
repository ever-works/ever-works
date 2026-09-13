/**
 * Quality gates — acceptance checks for agent-executed Tasks.
 *
 * An acceptance check is a named command whose exit code decides whether an
 * agent run comes back green or red. Tasks declare their own checks and/or
 * inherit per-Work defaults (`Work.checkDefaults`); the merge rules
 * (same-id override, `disabled: true` suppression) live in
 * `@ever-works/agent` (`tasks-domain/task-gates.ts`), not here — this
 * package is the zero-dependency storage/wire shape only.
 */

/**
 * What a check verifies. Drives grouping/labelling in run reports only —
 * execution is identical for every kind (`custom` covers anything that is
 * not one of the four conventional gates).
 */
export type TaskAcceptanceCheckKind = 'build' | 'test' | 'lint' | 'typecheck' | 'custom';

/**
 * Canonical list of check kinds. Kept as a const so validators (DTO
 * `@IsIn`, import sanitizers) share one source of truth with the type.
 */
export const TASK_ACCEPTANCE_CHECK_KINDS: readonly TaskAcceptanceCheckKind[] = [
	'build',
	'test',
	'lint',
	'typecheck',
	'custom'
];

/**
 * Judgment level a check belongs to (judgment layer G2).
 *
 * - `L0` — a CHEAP, purely syntactic/structural pass (lint, format check,
 *   `tsc --noEmit`, a schema validator). It is the only level that may run
 *   BEFORE the model call, as a pre-check: its output is fed into the same
 *   iterate loop as a red gate, so an obviously broken workspace is
 *   described to the agent before a single token is spent.
 * - `L1` — the normal acceptance check (build/test/custom). Runs after the
 *   agent loop, exactly as it always has.
 *
 * Optional and defaulting to `L1`: every check authored before this field
 * existed keeps its current behavior, and the pre-check pass is opt-in per
 * check AND behind an operator switch.
 */
export type TaskCheckLevel = 'L0' | 'L1';

/**
 * Canonical list of check levels — one source of truth for DTO `@IsIn`
 * validators and import sanitizers.
 */
export const TASK_CHECK_LEVELS: readonly TaskCheckLevel[] = ['L0', 'L1'];

/**
 * Which PHASE of a run a declared command belongs to (EW-807).
 *
 * `check` is the acceptance check every entry has always been. `setup` is
 * the dependency install / environment preparation an isolated worktree
 * needs before ANY command in it can mean anything — a freshly provisioned
 * worktree has no `node_modules`, so the first test command fails for a
 * reason that says nothing about the change under test.
 *
 * The two are separate values rather than a boolean because they are
 * reported separately, budgeted separately, and graded separately: a red
 * gate says "the change is wrong", a red setup says "the machine was not
 * ready". Collapsing them is the defect this vocabulary removes.
 */
export type TaskCheckPhase = 'setup' | 'check';

/** Canonical list — one source of truth for `@IsIn` validators and pins. */
export const TASK_CHECK_PHASES: readonly TaskCheckPhase[] = ['setup', 'check'];

/** A command with no explicit phase is an acceptance check, as it always was. */
export const DEFAULT_TASK_CHECK_PHASE: TaskCheckPhase = 'check';

/**
 * One acceptance check: a named command whose exit code decides green/red.
 */
export interface TaskAcceptanceCheck {
	/**
	 * Stable slug identifying the check. Also the merge key: a Task entry
	 * with the same id as a Work default replaces (or, with
	 * `disabled: true`, suppresses) that default.
	 */
	id: string;
	/** Human-readable label shown in run reports. */
	name: string;
	/** Category of the check; display/grouping only. */
	kind: TaskAcceptanceCheckKind;
	/** Command to execute. Exit code 0 = green, anything else = red. */
	command: string;
	/** Working directory relative to the checkout root; omitted = root. */
	cwd?: string;
	/**
	 * WHICH repository of a multi-repo run this command executes in
	 * (acceptance checks that mean something, EW-807).
	 *
	 * Omitted = the primary worktree, which is what every check did before
	 * this field existed. Otherwise the `mountDir` of one of the mounts the
	 * run actually provisioned (`FleetTaskWorkspaceMountSpec.mountDir`) —
	 * a NAME, never a path. The runner resolves it by looking the name up
	 * in the provisioned descriptor and refuses a name that is not there;
	 * it never joins the value onto a directory. See
	 * `resolveCommandRoot` in the node executor.
	 *
	 * Why it exists: a run can edit three repositories, and until this
	 * field every check ran in the primary worktree — so two of the three
	 * changes were never verified by anything.
	 */
	mountDir?: string;
	/**
	 * WHEN this command runs, and how its failure is reported (EW-807).
	 *
	 * - `check` (the default, and every entry authored before this field) —
	 *   an acceptance check. Runs after the model; its verdict is the gate.
	 * - `setup`  — a dependency install / environment preparation step. Runs
	 *   BEFORE the model, has its own (much larger) timeout ceiling and log
	 *   cap, and is reported in its own block. A failed setup step is
	 *   `setupStatus: 'red'` and NEVER a red gate: "the packages are not
	 *   installed" is not "the tests failed", and presenting it as one is
	 *   what made a fleet pull request's checks meaningless.
	 *
	 * Setup entries are deliberately NOT returned by
	 * `resolveAcceptanceChecks` — see `tasks-domain/task-gates.ts`.
	 */
	phase?: TaskCheckPhase;
	/**
	 * Judgment level (G2). Omitted = `L1` — the post-run acceptance check
	 * every existing check already is. Only `L0` checks are eligible for
	 * the cheap pre-model-call pass.
	 */
	level?: TaskCheckLevel;
	/**
	 * Wall-clock budget in seconds. A check that exceeds it reports
	 * `timeout` (distinct from `red`: the command was killed, not failed).
	 */
	timeoutSec?: number;
	/** Required checks decide the gate; non-required ones only report. */
	required: boolean;
	/**
	 * Environment variable NAMES (never values) the check is explicitly
	 * granted from the platform process environment.
	 *
	 * A check command is user-authored input, so its subprocess runs with a
	 * scrubbed environment built from a fixed allowlist (`PATH`, `HOME`,
	 * locale/temp vars, …) — it does NOT inherit the platform's own
	 * environment. This field is the opt-in escape hatch for a build that
	 * genuinely needs one more variable: listing a name is a DELIBERATE
	 * GRANT of that value to every command the check runs.
	 *
	 * Values are read from the parent environment at spawn time; a name
	 * that is unset there is simply absent. Platform-owned configuration
	 * (database/auth/trigger/plugin credentials) is never grantable — see
	 * `buildCheckEnv` in `@ever-works/agent`. Optional, defaults to none.
	 */
	envPassthrough?: string[];
	/**
	 * `true` removes the check from the resolved list. On a Task entry
	 * this is how an inherited Work default is suppressed without
	 * redeclaring the rest.
	 */
	disabled?: boolean;
}

/**
 * Outcome of one executed acceptance check, keyed back to
 * `TaskAcceptanceCheck.id`.
 */
export interface TaskCheckResult {
	/** `TaskAcceptanceCheck.id` this result belongs to. */
	id: string;
	/**
	 * Process exit code. `null` when the process never yielded one
	 * (timeout kill or spawn failure) — `status` says which.
	 */
	exitCode: number | null;
	/**
	 * `green`/`red` mirror the exit code; `timeout` = killed at
	 * `timeoutSec`; `error` = the check could not be executed at all.
	 */
	status: 'green' | 'red' | 'timeout' | 'error';
	/** Wall-clock duration of the check. */
	durationMs: number;
	/** Last lines of combined stdout/stderr, for the run report. */
	logTail?: string;
}

/**
 * Aggregate gate outcome for one agent run:
 * - `green`   — every required check passed;
 * - `red`     — at least one required check did not pass;
 * - `skipped` — checks resolved but the Work's policy said not to run them;
 * - `none`    — no checks resolved for this run.
 */
export type GateStatus = 'green' | 'red' | 'skipped' | 'none';

/**
 * Per-Work enforcement policy for acceptance checks:
 * - `off`      — checks never run (the default, so existing Works are
 *                untouched by the feature landing);
 * - `warn`     — checks run and report, but red does not block;
 * - `required` — red blocks the Task from completing.
 *
 * `off` IS AN EXECUTION SWITCH, NOT ONLY A GRADING ONE (EW-807). It stops
 * the check commands from running on every runtime, and on the fleet path
 * it additionally stops `.works/works.yml` being read for commands at all
 * — so a Work with `repoDeclaredCommands.mode: 'allowlist'` executes no
 * repository-authored command of either phase while its checks are off.
 * An owner who turns this off to stop something running must not have to
 * know about a second switch to make that true.
 *
 * What `off` does NOT stop is the owner's own `phase: 'setup'` steps: that
 * is the dependency install the model's work needs, authored by the owner,
 * not a judgement on the change.
 */
export type WorkChecksPolicy = 'off' | 'warn' | 'required';

/**
 * What the harness DOES with a graded run (judgment layer G2).
 *
 * {@link GateStatus} says what the CHECKS observed; this says what
 * happens next. They are deliberately separate types: `gateStatus` is
 * persisted onto the run and rendered as a chip, while the verdict is a
 * per-attempt control-flow decision that is recomputed every time the
 * gate re-runs.
 *
 * - `pass`     — proceed to finalize/PR exactly as a green gate always has.
 * - `fail`     — stop, withhold the PR, tell the human. The terminal
 *                outcome of a red gate that ran out of attempts.
 * - `retry`    — feed structured feedback back into the SAME run's agent
 *                loop and grade again. This is the bounded iterate loop
 *                that already existed for a red gate; the judge is simply
 *                a second producer of it.
 * - `escalate` — stop and file a structured escalation through
 *                `AgentEscalationService`, because a human has to decide.
 *                Distinct from `fail`: the commands all passed, so there is
 *                no failing check to point at — the work does not satisfy
 *                what the Task asked for.
 */
export type GateVerdict = 'pass' | 'fail' | 'retry' | 'escalate';

/** Canonical list — one source of truth for validators and pins. */
export const GATE_VERDICTS: readonly GateVerdict[] = ['pass', 'fail', 'retry', 'escalate'];

/**
 * The subset of {@link GateVerdict} an LLM judge is allowed to return.
 *
 * `fail` is deliberately absent: "the commands failed" is an observation
 * the process supervisor makes, never an opinion. A judge that could
 * return `fail` would be able to overrule an exit code, which is exactly
 * the property quality gates exist to avoid.
 */
export type GateJudgeVerdict = 'pass' | 'retry' | 'escalate';

/** Canonical list — mirrors {@link GateJudgeVerdict} for `@IsIn`/zod. */
export const GATE_JUDGE_VERDICTS: readonly GateJudgeVerdict[] = ['pass', 'retry', 'escalate'];

/**
 * One judge opinion about whether a run's output satisfies the Task's
 * acceptance criteria. Produced only when a judge is configured; absent
 * (`null`) otherwise, in which case the gate behaves exactly as it always
 * has.
 */
export interface TaskGateJudgement {
	/** What the harness should do next. */
	verdict: GateJudgeVerdict;
	/** One-line justification. Plain text — never rendered as markup. */
	reason: string;
	/**
	 * Criteria the judge considers unmet, verbatim-ish. Empty on `pass`;
	 * on `retry` these become the iterate message the agent reads.
	 */
	unmet: string[];
	/** Provider plugin id that produced the opinion (audit trail). */
	provider?: string;
	/** Model id that produced the opinion (audit trail). */
	model?: string;
}

/** Hard caps the judge applies to model output before it is used anywhere. */
export const GATE_JUDGE_MAX_REASON_CHARS = 500;
export const GATE_JUDGE_MAX_UNMET_ENTRIES = 10;
export const GATE_JUDGE_MAX_UNMET_CHARS = 300;

/** Cap on the criteria/output blocks spliced into the judge prompt. */
export const GATE_JUDGE_MAX_CRITERIA_CHARS = 4000;
export const GATE_JUDGE_MAX_OUTPUT_CHARS = 4000;

/**
 * Canonical list of policies. Import sanitizers treat anything outside
 * this set as drop-if-unrecognized (never default-if-unrecognized).
 */
export const WORK_CHECKS_POLICIES: readonly WorkChecksPolicy[] = ['off', 'warn', 'required'];
