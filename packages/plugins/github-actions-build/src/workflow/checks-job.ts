import {
	APP_BUILD_CHECKS_JOB_ID,
	APP_BUILD_CHECKS_MAX,
	APP_BUILD_CHECKS_MAX_PARALLEL,
	APP_BUILD_CHECK_NAME_PREFIX
} from '@ever-works/contracts';

import { ACTION_PINS, actionPin } from './action-pins.js';
import { yamlString, type WorkflowCheckInput } from './generator.js';
import { checkTimeoutMinutes } from './inputs-hash.js';

/**
 * APW-05 T41 — the `checks` matrix job (Resolution R-9; plan §2.4:276–308,
 * §4.14:1155–1183), and the only place this package writes it.
 *
 * One matrix row per `spec.checks[]` entry, in the order the App spec declares
 * them: `{ name, required, timeoutMinutes: ceil(timeoutSeconds / 60), commandB64 }`.
 * GitHub expands the matrix into one job — and therefore one check run — per row,
 * and the **job-level** `name` makes each of them report exactly
 * `Ever Works check: {name}`, with none of GitHub's `(1, 2, …)` matrix suffix
 * (FR-65). `APP_BUILD_CHECK_NAME_PREFIX` is the same constant, from the same
 * contracts module, that `workflow_run` observation uses to tell a check job from
 * `build` without a provider call (plan §3.2:538, §4.8:968), so the name the
 * platform prints and the name it recognises cannot drift.
 *
 * ## What makes the job safe to run repository-authored text
 *
 *   - **The command never travels as text** (FR-67, ACC-05-05). It is
 *     base64-encoded into `commandB64` and reaches the runner as
 *     `env: EW_CHECK_COMMAND_B64`; `run:` is a fixed one-liner that decodes it to
 *     a file and hands the file to `bash -e`. Neither YAML, nor the `${{ }}`
 *     expression engine, nor a shell's quoting ever sees a byte of a command
 *     written in `.works/works.yml` — a command containing `${{ secrets.X }}`, a
 *     backtick or either quote kind is data on the way in and a script on the way
 *     out, byte for byte.
 *   - **It can only read the repository** (FR-66). `permissions: { contents: read }`
 *     and nothing else, no `secrets.` reference of any kind, no `EW_` name other
 *     than the base64 variable, no `services`, no cache key. A check receives no
 *     build value and pushes nothing.
 *   - **It never gates the build** (FR-69). There is no `needs:` — a failed image
 *     build cannot skip a check, and a failed check cannot fail the build job.
 *     `continue-on-error: ${{ !matrix.check.required }}` is job-level, so an
 *     advisory check (`required: false`) reports its own result and still leaves
 *     the workflow run green (FR-68); `fail-fast: false` keeps one failing check
 *     from cancelling its siblings, and `max-parallel: 5` caps how many run at
 *     once (FR-67, `APP_BUILD_CHECKS_MAX_PARALLEL`).
 *
 * ## The trigger, and the one reading T41 had to fix (`APW05-G04`)
 *
 * §2.4:283–287 sketches a two-legged guard — a same-repository pull request into
 * the tracked branch **or** a push to it. §4.14's resolution R-9 keeps one leg:
 * **same-repository pull requests into the tracked branch only**, no `push` and no
 * `workflow_dispatch` (FR-65, FR-11, ACC-05-29), and T41's own text states it as
 * the contract ("the trigger is same-repository pull requests into the tracked
 * branch only"). The guard below is therefore §2.4's pull-request leg alone, plus
 * `base.ref` so the leg is what the file says rather than a side effect of the
 * `on.pull_request.branches` filter. A pull request from another repository runs
 * no check: the head-repository comparison is the same expression the `build` job
 * uses, so both jobs refuse a fork identically. The `push` leg is reported as
 * dropped, not silently forgotten — it would have produced a check run on the
 * tracked branch, and no Build records it (plan §4.14's observation: a
 * checks-only run is never a Build).
 *
 * ## Three details worth knowing before you change this file
 *
 *   - **The checkout ref keeps §2.4:304's expression verbatim**, including its
 *     `|| github.sha` arm. With the single trigger that arm is unreachable — a
 *     `pull_request` event always takes `github.event.pull_request.head.sha`,
 *     which is the point (on a pull request `github.sha` is the *merge* commit,
 *     so checking it would test a tree nobody authored) — but it is written as
 *     §2.4 writes it rather than quietly simplified.
 *   - **The tracked branch is quoted for the expression engine, not for YAML**
 *     ({@link expressionStringLiteral}). `yamlString` is the wrong encoder for
 *     that one value and `actionlint` proved it: the file it produced failed with
 *     `got unexpected character '"' while lexing expression … only single quotes
 *     are available for string delimiter`. Everything else interpolated here is
 *     YAML text, and is quoted by `yamlString`.
 *   - **`yamlString` is imported from `generator.ts`, which imports this module.**
 *     The cycle is deliberate: plan §4.5's "a `yamlString()` helper that always
 *     double-quotes and escapes" has exactly one definition in this package, and
 *     the job this module renders must be quoted by it. Both directions are
 *     function declarations only called at generation time, so neither module
 *     reads the other while it is still evaluating.
 */

/** The one `env:` entry a check job has — §4.14: "The command travels only as `env: EW_CHECK_COMMAND_B64`". */
export const CHECK_COMMAND_B64_ENV = 'EW_CHECK_COMMAND_B64' as const;

/** One `matrix.check` row, in the shape GitHub and the fingerprint both read (plan §2.4:298, §4.14). */
export interface WorkflowCheckMatrixRow {
	/** The App spec check's name — an APW-03 Name, so the check run renders to `Ever Works check: {name}` exactly. */
	readonly name: string;
	/** `false` is the advisory check: its failure never fails the workflow run (FR-68). */
	readonly required: boolean;
	/** `ceil(timeoutSeconds / 60)`, the unit `timeout-minutes` takes — {@link checkTimeoutMinutes}, never a second rounding rule. */
	readonly timeoutMinutes: number;
	/** The command, base64 — the only form in which a repository-authored command is ever emitted (FR-67). */
	readonly commandB64: string;
}

/** Everything the job needs: the checks, the tracked branch its guard names, and the runner §4.4 selected. */
export interface ChecksJobInput {
	/** `spec.checks[]` in declared order; capped at {@link APP_BUILD_CHECKS_MAX} rows, as the fingerprint is. */
	readonly checks: readonly WorkflowCheckInput[];
	readonly trackedBranch: string;
	/** The `build` job's runner label (§4.14: "The runner label is the build job's (§4.4)"). */
	readonly runnerLabel: string;
}

/** The command as the workflow carries it — standard base64 of its UTF-8 bytes, which `base64 -d` restores exactly. */
export function checkCommandB64(command: string): string {
	return Buffer.from(command, 'utf8').toString('base64');
}

/** The check run's name, exactly (FR-65) — the job-level `name` of every row of the matrix. */
export function checksJobName(name: string): string {
	return `${APP_BUILD_CHECK_NAME_PREFIX}${name}`;
}

/**
 * A GitHub **expression** string literal: `'…'`, with an embedded quote doubled.
 *
 * Not `yamlString`: an `if:` value here is a plain (unquoted) YAML scalar, so a
 * `"…"` produced for YAML travels into the expression engine verbatim — and that
 * engine accepts single quotes only. `actionlint` refuses the file otherwise:
 * `got unexpected character '"' while lexing expression, expecting … only single
 * quotes are available for string delimiter`, which is how this was caught on
 * `golden/checks.yml:182` rather than in a customer's run.
 */
export function expressionStringLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The job's `if:` — a same-repository pull request into the tracked branch, and
 * nothing else (R-9, FR-65, ACC-05-29). See the module note on §2.4's dropped
 * `push` leg.
 */
export function checksJobCondition(trackedBranch: string): string {
	return [
		`github.event_name == 'pull_request'`,
		`github.event.pull_request.head.repo.full_name == github.repository`,
		`github.event.pull_request.base.ref == ${expressionStringLiteral(trackedBranch)}`
	].join(' && ');
}

/** One App spec check as its matrix row (plan §4.14) — the minutes from {@link checkTimeoutMinutes}, the command only as base64. */
export function checkMatrixRow(check: WorkflowCheckInput): WorkflowCheckMatrixRow {
	return {
		name: check.name,
		required: check.required,
		timeoutMinutes: checkTimeoutMinutes(check.timeoutSeconds),
		commandB64: checkCommandB64(check.command)
	};
}

/**
 * The matrix, in the order the App spec declares the checks — never sorted, so
 * the rows read the way the App Work's owner wrote them (plan §4.14: "in declared
 * order"). Capped at {@link APP_BUILD_CHECKS_MAX}, the same cap
 * `canonicalInputsFor` applies to the fingerprint, so a file and its header hash
 * can never cover different checks.
 */
export function checksMatrix(checks: readonly WorkflowCheckInput[]): WorkflowCheckMatrixRow[] {
	return checks.slice(0, APP_BUILD_CHECKS_MAX).map(checkMatrixRow);
}

/**
 * The `checks` job — plan §2.4:276–308 with §4.14's single trigger.
 *
 * Returns the job's lines, `  checks:` first, for the generator to splice into
 * `jobs:` after the `build` job. Every value the file needs is derived here from
 * the check itself; nothing else is interpolated.
 */
export function checksJob(input: ChecksJobInput): string[] {
	const rows = checksMatrix(input.checks);
	const lines: string[] = [];

	lines.push(`  ${APP_BUILD_CHECKS_JOB_ID}:`);
	lines.push(`    if: ${checksJobCondition(input.trackedBranch)}`);
	lines.push(`    name: ${yamlString(checksJobName('${{ matrix.check.name }}'))}`);
	lines.push(`    runs-on: ${yamlString(input.runnerLabel)}`);
	// The row's own minutes, which is `ceil(timeoutSeconds / 60)` (FR-67).
	lines.push(`    timeout-minutes: \${{ matrix.check.timeoutMinutes }}`);
	// FR-68: job-level, so an advisory check reports its own result and leaves the run green.
	lines.push(`    continue-on-error: \${{ !matrix.check.required }}`);
	// FR-66: read the repository, nothing else.
	lines.push('    permissions: { contents: read }');
	lines.push('    strategy:');
	// FR-67: one check's failure never cancels another; at most 5 run at once.
	lines.push('      fail-fast: false');
	lines.push(`      max-parallel: ${APP_BUILD_CHECKS_MAX_PARALLEL}`);
	lines.push('      matrix:');
	lines.push('        check:');
	for (const row of rows) {
		lines.push(
			`          - { name: ${yamlString(row.name)}, required: ${row.required}, timeoutMinutes: ${row.timeoutMinutes}, commandB64: ${yamlString(row.commandB64)} }`
		);
	}

	lines.push('    steps:');
	// The pull-request head, and never a persisted credential: a check runs
	// repository-authored text and needs nothing to push with (§4.14, FR-66).
	lines.push(`      - uses: ${actionPin(ACTION_PINS.checkout)}`);
	lines.push('        with:');
	lines.push(
		`          ref: ${yamlString("${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}")}`
	);
	lines.push('          fetch-depth: 1');
	lines.push('          persist-credentials: false');
	lines.push('          lfs: false');
	lines.push('      - name: Run check');
	lines.push('        env:');
	lines.push(`          ${CHECK_COMMAND_B64_ENV}: ${yamlString('${{ matrix.check.commandB64 }}')}`);
	lines.push(
		`        run: printf '%s' "$${CHECK_COMMAND_B64_ENV}" | base64 -d > "$RUNNER_TEMP/ew-check.sh" && bash -e "$RUNNER_TEMP/ew-check.sh"`
	);

	return lines;
}
