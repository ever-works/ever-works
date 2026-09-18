import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import {
	APP_BUILD_CHECKS_JOB_ID,
	APP_BUILD_CHECKS_MAX,
	APP_BUILD_CHECKS_MAX_PARALLEL,
	APP_BUILD_CHECK_NAME_PREFIX
} from '@ever-works/contracts';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { ACTION_PINS, actionPin } from '../workflow/action-pins.js';
import {
	CHECK_COMMAND_B64_ENV,
	checkCommandB64,
	checkMatrixRow,
	checksJobCondition,
	checksJobName,
	checksMatrix,
	expressionStringLiteral
} from '../workflow/checks-job.js';
import { canonicalInputsFor, generateWorkflow, type WorkflowGeneratorInput } from '../workflow/generator.js';
import { checkTimeoutMinutes, computeWorkflowInputsHash } from '../workflow/inputs-hash.js';
import { EMBEDDED_VERIFY_RUNNER_SCRIPT } from '../workflow/verify-runner.sh.js';
import { bootstrapFixture, goldenFixtures } from './fixtures/workflow-fixtures.js';

/**
 * APW-05 T41 — the `checks` matrix job (Resolution R-9; plan §2.4:276–308,
 * §4.14), against the golden `golden/checks.yml` and against the job itself.
 *
 * **What the golden is.** The whole file `generateWorkflow(checksFixture())`
 * produces — not the extracted job — because T41's Done-when asks the golden to
 * pass `actionlint`, and actionlint reads a workflow, not a fragment. It is
 * recorded through `EW_UPDATE_GOLDEN=1` from the very fixture these assertions
 * read (T8's idiom), so the bytes and the expectations cannot drift apart.
 *
 * **Why the assertions do not merely diff the golden.** A golden catches a change
 * nobody meant; it cannot tell a correct byte from a wrong one. Every promise T41
 * makes is therefore asserted independently: the rows GitHub will expand, the
 * permissions it will grant, the absence of a secret, a cache key or a `needs:`,
 * the guard that keeps a fork's pull request from running a check at all, and the
 * byte-identity of a command that would break every layer above it if it ever
 * travelled as text.
 */

const UPDATE_GOLDEN = process.env.EW_UPDATE_GOLDEN === '1';

/** The two checks T41's Test line names: one required, one advisory — and deliberately out of alphabetical order. */
const GOLDEN_CHECKS = [
	{ name: 'unit-tests', command: 'npm test', required: true, timeoutSeconds: 61 },
	{ name: 'lint', command: 'npm run lint -- --max-warnings 0', required: false, timeoutSeconds: 60 }
] as const;

/** An App Work with a Dockerfile build and those two checks — the fixture the golden is recorded from. */
function checksFixture(): WorkflowGeneratorInput {
	return { ...goldenFixtures().minimal, checks: [...GOLDEN_CHECKS] };
}

/** One check, or the fixture's two with the last one replaced — what the small pure cases are read from. */
function fixtureWith(checks: WorkflowGeneratorInput['checks']): WorkflowGeneratorInput {
	return { ...checksFixture(), checks };
}

/**
 * A command that every layer between the App spec and the shell would corrupt if
 * it ever travelled as text: `${{ }}` for the expression engine, a backtick for
 * the shell, both quote kinds for YAML and for JSON, and a backslash for everyone.
 */
const TRICKY_COMMAND = 'echo "${{ secrets.X }}" \'single "quoted"\' `id -un` back\\slash';

/** Read the golden, or write it when the recorder is running. */
function golden(name: string, actual: string): string {
	const url = new URL(`./golden/${name}.yml`, import.meta.url);
	if (UPDATE_GOLDEN) {
		writeFileSync(url, actual);
		return actual;
	}
	return readFileSync(url, 'utf-8');
}

const fixture = checksFixture();
const file = generateWorkflow(fixture);

/** The `jobs.<name>` block of a generated file, verbatim (the generator spec's helper, same shape). */
function jobSection(source: string, job: string): string {
	const lines = source.split('\n');
	const start = lines.indexOf(`  ${job}:`);
	expect(start, `job ${job} exists`).toBeGreaterThan(-1);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^ {2}[a-z0-9_-]+:$/.test(line));
	return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** The parsed `jobs.checks` — what GitHub expands, read back through a real parser rather than by eye. */
function parsedChecks(source: string): {
	if: string;
	name: string;
	'runs-on': string;
	'timeout-minutes': string;
	'continue-on-error': string;
	permissions: Record<string, string>;
	strategy: { 'fail-fast': boolean; 'max-parallel': number; matrix: { check: Record<string, unknown>[] } };
	steps: Array<{
		uses?: string;
		name?: string;
		env?: Record<string, string>;
		run?: string;
		with?: Record<string, unknown>;
	}>;
} {
	const parsed = yaml.load(source) as { jobs: Record<string, never> };
	expect(parsed.jobs[APP_BUILD_CHECKS_JOB_ID], 'the checks job exists').toBeTypeOf('object');
	return parsed.jobs[APP_BUILD_CHECKS_JOB_ID];
}

describe('checks job — the matrix (T41, R-9, plan §2.4:276–308, §4.14)', () => {
	const checks = parsedChecks(file);
	const rows = checks.strategy.matrix.check;

	it('maps one matrix row per check, in declared order, with the advisory row required: false', () => {
		expect(rows).toEqual([
			{
				name: 'unit-tests',
				required: true,
				timeoutMinutes: 2,
				commandB64: 'bnBtIHRlc3Q='
			},
			{
				name: 'lint',
				required: false,
				timeoutMinutes: 1,
				commandB64: checkCommandB64('npm run lint -- --max-warnings 0')
			}
		]);
		// Declared order, never sorted: `unit-tests` precedes `lint` in the App spec
		// and must precede it in the matrix.
		expect(rows.map((row) => row.name)).toEqual(['unit-tests', 'lint']);
		// `bnBtIHRlc3Q=` is `npm test` in standard base64 — not base64url, which `base64 -d` would refuse.
		expect(rows[0]?.commandB64).toBe('bnBtIHRlc3Q=');
		expect(checks.strategy['fail-fast']).toBe(false);
		expect(checks.strategy['max-parallel']).toBe(APP_BUILD_CHECKS_MAX_PARALLEL);
		expect(APP_BUILD_CHECKS_MAX_PARALLEL).toBe(5);
	});

	it('names every check run "Ever Works check: <name>" through one job-level name (FR-65)', () => {
		expect(checks.name).toBe('Ever Works check: ${{ matrix.check.name }}');
		expect(checks.name).toBe(`${APP_BUILD_CHECK_NAME_PREFIX}\${{ matrix.check.name }}`);
		expect(APP_BUILD_CHECK_NAME_PREFIX).toBe('Ever Works check: ');
		expect(checksJobName('unit-tests')).toBe('Ever Works check: unit-tests');
		// Job-level, not per step: GitHub reports one check run per matrix row under
		// this name, with none of its own `(1, 2, …)` matrix suffix.
		const nameLine = `    name: ${JSON.stringify(checks.name)}`;
		expect(file).toContain(nameLine);
		const nameLines = jobSection(file, APP_BUILD_CHECKS_JOB_ID)
			.split('\n')
			.filter((line) => line === nameLine);
		expect(nameLines).toHaveLength(1);
	});

	it('rounds timeoutSeconds up to whole minutes, and carries the row minutes as the job timeout (FR-67)', () => {
		expect(checks['timeout-minutes']).toBe('${{ matrix.check.timeoutMinutes }}');
		expect(rows.map((row) => row.timeoutMinutes)).toEqual([2, 1]);
		expect(rows.map((row) => row.timeoutMinutes)).toEqual(
			GOLDEN_CHECKS.map((check) => checkTimeoutMinutes(check.timeoutSeconds))
		);
		// T41's Test line: 61 seconds is 2 minutes, and 60 is 1 — never 0, never 1.016.
		expect(checkTimeoutMinutes(61)).toBe(2);
		expect(checkMatrixRow({ name: 'x', command: 'true', required: true, timeoutSeconds: 61 }).timeoutMinutes).toBe(
			2
		);
		const rounding: Array<[number, number]> = [
			[60, 1],
			[61, 2],
			[120, 2],
			[121, 3],
			[7200, 120]
		];
		for (const [seconds, minutes] of rounding) expect(checkTimeoutMinutes(seconds), `${seconds}s`).toBe(minutes);
	});

	it('takes the advisory semantics from the row, at job level (FR-68, ACC-05-29)', () => {
		expect(checks['continue-on-error']).toBe('${{ !matrix.check.required }}');
		expect(file).toContain('    continue-on-error: ${{ !matrix.check.required }}');
		// `required: false` is what makes that expression true, so the advisory
		// check reports its own result and never fails the workflow run.
		expect(rows.filter((row) => row.required === false).map((row) => row.name)).toEqual(['lint']);
		// The negation is the only thing standing between an advisory check and a red
		// run, so it is pinned against a literal inversion.
		expect(checks['continue-on-error']).not.toBe('${{ matrix.check.required }}');
		// Job-level: no step carries it.
		for (const step of checks.steps) expect(step).not.toHaveProperty('continue-on-error');
	});

	it('grants contents: read and nothing else (FR-66)', () => {
		expect(checks.permissions).toEqual({ contents: 'read' });
		expect(file).toContain('    permissions: { contents: read }');
		const job = jobSection(file, APP_BUILD_CHECKS_JOB_ID);
		expect(job).not.toContain('packages:');
		expect(job).not.toContain('attestations:');
		expect(job).not.toContain('id-token:');
		expect([...job.matchAll(/permissions:/g)]).toHaveLength(1);
	});

	it('references no secret and no EW_ name other than EW_CHECK_COMMAND_B64 (FR-66, ACC-05-29)', () => {
		const job = jobSection(file, APP_BUILD_CHECKS_JOB_ID);
		expect(job).not.toContain('secrets.');
		expect(CHECK_COMMAND_B64_ENV).toBe('EW_CHECK_COMMAND_B64');
		const ewNames = [...job.matchAll(/EW_[A-Z0-9_]+/g)].map((match) => match[0]);
		expect([...new Set(ewNames)]).toEqual([CHECK_COMMAND_B64_ENV]);
		expect(ewNames.length).toBeGreaterThan(0);
	});

	it('carries no cache key, no needs:, no services and no artifact (FR-66, FR-69)', () => {
		const job = jobSection(file, APP_BUILD_CHECKS_JOB_ID);
		expect(job).not.toContain('cache-');
		expect(job).not.toContain('needs:');
		expect(job).not.toContain('services:');
		expect(job).not.toContain('upload-artifact');
		expect(checks).not.toHaveProperty('needs');
		expect(checks).not.toHaveProperty('services');
		// One `env:` block, and it holds the base64 command alone.
		expect(job.split('\n').filter((line) => line.trim() === 'env:')).toHaveLength(1);
		expect(checks.steps[1]?.env).toEqual({ [CHECK_COMMAND_B64_ENV]: '${{ matrix.check.commandB64 }}' });
	});

	it('runs on a same-repository pull request into the tracked branch, and on nothing else (ACC-05-29)', () => {
		expect(checks.if).toBe(
			`github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.base.ref == 'main'`
		);
		expect(checks.if).toBe(checksJobCondition('main'));
		// ACC-05-29: a pull request from another repository runs no check.
		expect(checks.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
		// R-9: same-repository pull requests into the tracked branch — no push, no
		// workflow_dispatch, and no `||` that could widen the guard again.
		expect(checks.if).not.toContain('push');
		expect(checks.if).not.toContain('workflow_dispatch');
		expect(checks.if).not.toContain('||');
		expect(checks.if).not.toContain('pull_request_target');
		// The branch is an **expression** string literal, and the expression grammar
		// has single quotes only: a `"` anywhere in `if:` is a lex error the runner
		// and `actionlint` both refuse (`actionlint`: `got unexpected character '"'
		// while lexing expression … only single quotes are available for string
		// delimiter`). That is the defect this assertion exists to keep out.
		expect(checks.if).not.toContain('"');
		// The tracked branch is the workflow's own, not a literal that could drift.
		expect(checksJobCondition('feature/x')).toContain("github.event.pull_request.base.ref == 'feature/x'");
		// A branch name may contain a quote; the expression grammar escapes it by
		// doubling, and the YAML scalar stays plain either way.
		expect(checksJobCondition("feat/it's")).toContain("github.event.pull_request.base.ref == 'feat/it''s'");
		expect(expressionStringLiteral("a'b'c")).toBe("'a''b''c'");
	});

	it('checks out the pull-request head without persisting a credential (§4.14)', () => {
		const checkout = checks.steps[0];
		expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
		expect(jobSection(file, APP_BUILD_CHECKS_JOB_ID)).toContain(`      - uses: ${actionPin(ACTION_PINS.checkout)}`);
		expect(checkout?.with).toEqual({
			ref: "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
			'fetch-depth': 1,
			'persist-credentials': false,
			lfs: false
		});
		// The pull-request arm comes first, so a check tests the head the pull
		// request proposes — not the merge commit `github.sha` names on that event.
		expect(String(checkout?.with?.ref).indexOf('github.event.pull_request.head.sha')).toBeLessThan(
			String(checkout?.with?.ref).indexOf('|| github.sha')
		);
	});

	it('runs the decoded command as a shell script, and runs nothing else (FR-67)', () => {
		expect(checks.steps).toHaveLength(2);
		const run = checks.steps[1];
		expect(run?.name).toBe('Run check');
		expect(run?.env).toEqual({ [CHECK_COMMAND_B64_ENV]: '${{ matrix.check.commandB64 }}' });
		expect(run?.run).toBe(
			`printf '%s' "$${CHECK_COMMAND_B64_ENV}" | base64 -d > "$RUNNER_TEMP/ew-check.sh" && bash -e "$RUNNER_TEMP/ew-check.sh"`
		);
		expect(run).not.toHaveProperty('uses');
	});

	it('never lets a repository-authored command reach the file as text (FR-67, ACC-05-05)', () => {
		const tricky = generateWorkflow(
			fixtureWith([{ name: 'tricky', command: TRICKY_COMMAND, required: true, timeoutSeconds: 60 }])
		);
		// Nowhere in the file, and certainly not in the job: no command text, no
		// `${{ secrets.X }}` for the expression engine, no backtick for the shell.
		expect(tricky).not.toContain(TRICKY_COMMAND);
		expect(tricky).not.toContain('secrets.X');
		expect(jobSection(tricky, APP_BUILD_CHECKS_JOB_ID)).not.toContain('`');
		// And it still arrives byte-identical, which is the half that matters.
		const decoded = Buffer.from(
			String(parsedChecks(tricky).strategy.matrix.check[0]?.commandB64),
			'base64'
		).toString('utf8');
		expect(decoded).toBe(TRICKY_COMMAND);
		expect(String(parsedChecks(tricky).strategy.matrix.check[0]?.commandB64)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
	});

	it('emits no checks job without a check, and none in a bootstrap file (plan §4.6 step 0)', () => {
		expect(generateWorkflow(fixtureWith([]))).not.toContain(`\n  ${APP_BUILD_CHECKS_JOB_ID}:\n`);
		expect(generateWorkflow(goldenFixtures().minimal)).not.toContain(`\n  ${APP_BUILD_CHECKS_JOB_ID}:\n`);
		// A bootstrap file has no App spec to read checks from, whatever the caller passes.
		const bootstrap = generateWorkflow({ ...bootstrapFixture(), checks: [...GOLDEN_CHECKS] });
		expect(bootstrap).not.toContain(`\n  ${APP_BUILD_CHECKS_JOB_ID}:\n`);
		expect(Object.keys((yaml.load(bootstrap) as { jobs: Record<string, unknown> }).jobs)).toEqual(['verify']);
	});

	it('caps the matrix at the contract maximum, as the fingerprint does', () => {
		const many = Array.from({ length: APP_BUILD_CHECKS_MAX + 5 }, (_, index) => ({
			name: `check-${index}`,
			command: `echo ${index}`,
			required: false,
			timeoutSeconds: 60
		}));
		expect(APP_BUILD_CHECKS_MAX).toBe(20);
		expect(checksMatrix(many)).toHaveLength(APP_BUILD_CHECKS_MAX);
		expect(parsedChecks(generateWorkflow(fixtureWith(many))).strategy.matrix.check).toHaveLength(
			APP_BUILD_CHECKS_MAX
		);
		expect(canonicalInputsFor(fixtureWith(many), EMBEDDED_VERIFY_RUNNER_SCRIPT).checks).toHaveLength(
			APP_BUILD_CHECKS_MAX
		);
	});

	it('keeps the file and its fingerprint covering the same checks (plan §4.5)', () => {
		const header = file.split('\n')[2];
		expect(header).toBe(
			`# ever-works-build generator=1 inputs=${computeWorkflowInputsHash(
				canonicalInputsFor(fixture, EMBEDDED_VERIFY_RUNNER_SCRIPT)
			)}`
		);
		// A check's row and the fingerprint read the same seconds: 61 → 2 minutes here
		// and `commandSha256` of `npm test` there.
		const canonical = canonicalInputsFor(fixture, EMBEDDED_VERIFY_RUNNER_SCRIPT);
		expect(canonical.checks.map((check) => check.timeoutMinutes)).toEqual([2, 1]);
		expect(canonical.checks.map((check) => check.name)).toEqual(['unit-tests', 'lint']);
		// The digest is of the **command**, computed here with node:crypto rather than
		// with the implementation's own helper — a command change is what has to move
		// the file, so it is the command that must be the thing hashed.
		expect(canonical.checks[0]?.commandSha256).toBe(createHash('sha256').update('npm test', 'utf8').digest('hex'));
		expect(canonical.checks[0]?.commandSha256).not.toBe(
			createHash('sha256').update('unit-tests', 'utf8').digest('hex')
		);
		// And a change to a command, a timeout or `required` really does move the
		// fingerprint in the header (plan §4.5: a check change changes the file).
		const fingerprint = (input: WorkflowGeneratorInput): string => generateWorkflow(input).split('\n')[2];
		const relinted = { name: 'lint', command: 'npm run lint', required: false, timeoutSeconds: 60 };
		expect(fingerprint(fixtureWith([GOLDEN_CHECKS[0], relinted]))).not.toBe(header);
		expect(fingerprint(fixtureWith([{ ...GOLDEN_CHECKS[0], required: false }, GOLDEN_CHECKS[1]]))).not.toBe(header);
		// The unit is minutes, so only a timeout that crosses a minute changes
		// anything: 121 s is 3 minutes and moves the file, while 120 s is the same 2
		// minutes 61 s already was and moves neither the bytes nor the fingerprint.
		expect(fingerprint(fixtureWith([{ ...GOLDEN_CHECKS[0], timeoutSeconds: 121 }, GOLDEN_CHECKS[1]]))).not.toBe(
			header
		);
		expect(fingerprint(fixtureWith([{ ...GOLDEN_CHECKS[0], timeoutSeconds: 120 }, GOLDEN_CHECKS[1]]))).toBe(header);
		// The declared order is the matrix's, but not the fingerprint's: the canonical
		// JSON sorts, so a reordered App spec still hashes to the same file identity.
		expect(fingerprint(fixtureWith([...GOLDEN_CHECKS].reverse()))).toBe(header);
	});
});

describe('checks job — the golden', () => {
	it('records and reproduces golden/checks.yml byte for byte', () => {
		expect(file).toBe(golden('checks', file));
	});

	it('stays byte-stable across two runs, with LF endings and one trailing newline', () => {
		expect(generateWorkflow(fixture)).toBe(file);
		expect(file.includes('\r')).toBe(false);
		expect(file.endsWith('\n')).toBe(true);
		expect(file.endsWith('\n\n')).toBe(false);
	});

	it('is valid YAML, and its jobs are build, verify and checks in §2.4s order', () => {
		const parsed = yaml.load(file) as { name: string; permissions: unknown; jobs: Record<string, unknown> };
		expect(parsed.name).toBe('Ever Works build');
		// Every grant is per job, so the checks job's `contents: read` is the file's only one.
		expect(parsed.permissions).toEqual({});
		expect(Object.keys(parsed.jobs)).toEqual(['build', 'verify', APP_BUILD_CHECKS_JOB_ID]);
		expect(file).toContain(`uses: ${actionPin(ACTION_PINS.checkout)}`);
	});
});
