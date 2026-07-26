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
 */
export type WorkChecksPolicy = 'off' | 'warn' | 'required';

/**
 * Canonical list of policies. Import sanitizers treat anything outside
 * this set as drop-if-unrecognized (never default-if-unrecognized).
 */
export const WORK_CHECKS_POLICIES: readonly WorkChecksPolicy[] = ['off', 'warn', 'required'];
