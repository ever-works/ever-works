import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(__dirname, '../../../..');
const workflowPath = join(repositoryRoot, '.github/workflows/prod-image-freshness.yml');

const BEGIN = '# >>> BEGIN verdict contract block >>>';
const END = '# <<< END verdict contract block <<<';

/**
 * EW-758 — the prod image lane died silently twice and both times it was found
 * by hand. `prod-image-freshness.yml` is the missing alarm, and the value of an
 * alarm is entirely in WHEN IT DOES AND DOES NOT FIRE:
 *
 *   * it must fire when a `main` commit has not reached production;
 *   * it must stay quiet during a normal rollout, or people mute it;
 *   * it must stay quiet — never alert — when its own signals are unavailable,
 *     because a monitor that alerts on its own transport faults is worse than
 *     none.
 *
 * The workflow's decision step is written as a pure function of its env vars
 * for exactly this reason: the block below is the SHIPPED text, executed under
 * the same Bash flags GitHub uses.
 */
async function verdictBlock(): Promise<string> {
	const workflow = (await readFile(workflowPath, 'utf8')).replace(/\r\n/g, '\n');
	const start = workflow.indexOf(BEGIN);
	const end = workflow.indexOf(END, start);

	expect(start, `${BEGIN} marker missing from prod-image-freshness.yml`).toBeGreaterThan(-1);
	expect(end, `${END} marker missing from prod-image-freshness.yml`).toBeGreaterThan(start);

	return workflow
		.slice(start, end)
		.replace(/^ {10}/gm, '')
		.replace(/^# >>> BEGIN.*$/m, '');
}

interface Signals {
	TIP_SHA?: string;
	TIP_TIME?: string;
	PROD_SHA?: string;
	PROD_REF?: string;
	PROD_BUILD_TIME?: string;
	LAST_SUCCESS_AT?: string;
	LAST_SUCCESS_SHA?: string;
	DISCARDED?: string;
	IN_FLIGHT?: string;
	MAX_UNSHIPPED_HOURS?: string;
	NOW_OVERRIDE?: string;
}

interface Verdict {
	status: string;
	age_minutes: string;
	threshold_hours: string;
	discarded: string;
	headline: string;
	report_path: string;
}

function runVerdict(block: string, signals: Signals): { verdict: Verdict; report: string; stderr: string } {
	const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
	const workspace = mkdtempSync(join(tmpdir(), 'prod-image-freshness-'));
	const outputPath = join(workspace, 'github-output');

	// The self-hosted runners may inject Bash startup hooks through BASH_ENV or
	// ENV. Give this contract only the OS variables it needs so a runner profile
	// cannot change the shell semantics under test.
	const cleanEnv: Record<string, string> = Object.fromEntries(
		['PATH', 'HOME', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP']
			.map((key) => [key, process.env[key]])
			.filter((entry): entry is [string, string] => typeof entry[1] === 'string')
	);

	const result = spawnSync(bash, ['--noprofile', '--norc', '-euo', 'pipefail', '-c', block], {
		encoding: 'utf8',
		env: {
			...cleanEnv,
			RUNNER_TEMP: workspace,
			GITHUB_OUTPUT: outputPath,
			RUN_URL: 'https://github.com/ever-works/ever-works/actions/runs/1',
			TIP_SHA: '',
			TIP_TIME: '',
			PROD_SHA: '',
			PROD_REF: '',
			PROD_BUILD_TIME: '',
			LAST_SUCCESS_AT: '',
			LAST_SUCCESS_SHA: '',
			DISCARDED: '',
			IN_FLIGHT: '',
			MAX_UNSHIPPED_HOURS: '',
			...Object.fromEntries(Object.entries(signals).filter(([, value]) => value !== undefined))
		}
	});

	// A non-zero verdict step means the monitor went silent. That is the whole
	// failure mode, so assert it here rather than in every test.
	expect(result.stderr).toBe('');
	expect(result.status, `verdict block exited ${result.status}`).toBe(0);

	const verdict = Object.fromEntries(
		readFileSync(outputPath, 'utf8')
			.split('\n')
			.filter((line) => line.includes('='))
			.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
	) as unknown as Verdict;

	return { verdict, report: readFileSync(verdict.report_path, 'utf8'), stderr: result.stderr };
}

const TIP = '223dc250ffc6fd06bbb2148d1d8ed0b0f5461a29';
const OLDER = '13fb193391c0f2ba5f8a90c6d1b0a2e4d5c6f7a8';
const NOW = '2026-09-05T12:00:00Z';

describe('prod image freshness verdict contract (EW-758)', () => {
	it('reports OK when the production image carries the tip of main', async () => {
		const { verdict, report } = runVerdict(await verdictBlock(), {
			TIP_SHA: TIP,
			TIP_TIME: '2026-09-04T18:00:59Z',
			PROD_SHA: TIP,
			PROD_BUILD_TIME: '2026-09-04T18:39:24Z',
			NOW_OVERRIDE: NOW
		});

		// 18 hours old and still OK: age is not the question, "is this commit in
		// production" is. Anything else alerts every quiet weekend.
		expect(verdict.status).toBe('ok');
		expect(report).toContain('Production is serving the tip of');
	});

	it('stays quiet while a fresh commit is still building and rolling out', async () => {
		const { verdict } = runVerdict(await verdictBlock(), {
			TIP_SHA: TIP,
			TIP_TIME: '2026-09-05T11:00:00Z',
			PROD_SHA: OLDER,
			NOW_OVERRIDE: NOW
		});

		expect(verdict.status).toBe('pending');
		expect(verdict.age_minutes).toBe('60');
		expect(verdict.threshold_hours).toBe('6');
	});

	it('alerts once a main commit has been unshipped past the window', async () => {
		const { verdict, report } = runVerdict(await verdictBlock(), {
			TIP_SHA: TIP,
			TIP_TIME: '2026-09-04T06:00:00Z',
			PROD_SHA: OLDER,
			LAST_SUCCESS_AT: '2026-09-03T10:40:22Z',
			LAST_SUCCESS_SHA: OLDER,
			DISCARDED: '28',
			NOW_OVERRIDE: NOW
		});

		expect(verdict.status).toBe('alert');
		expect(verdict.age_minutes).toBe('1800');
		expect(verdict.discarded).toBe('28');
		expect(verdict.headline).toContain('28 discarded');
		expect(report).toContain('The production image lane is stale');
		// The alert has to tell the reader how to recognise a pending-supersede.
		expect(report).toContain('runner_name');
	});

	it.each([
		['the prod endpoint did not answer', { TIP_SHA: TIP, TIP_TIME: '2026-09-04T06:00:00Z', PROD_SHA: '' }],
		['the GitHub API did not answer', { TIP_SHA: '', TIP_TIME: '', PROD_SHA: OLDER }],
		['the commit time is unparseable', { TIP_SHA: TIP, TIP_TIME: 'not-a-timestamp', PROD_SHA: OLDER }]
	])('returns UNKNOWN rather than alerting when %s', async (_label, signals) => {
		const { verdict } = runVerdict(await verdictBlock(), { ...signals, NOW_OVERRIDE: NOW });

		expect(verdict.status).toBe('unknown');
	});

	it('honours a tightened threshold', async () => {
		const { verdict } = runVerdict(await verdictBlock(), {
			TIP_SHA: TIP,
			TIP_TIME: '2026-09-05T10:30:00Z',
			PROD_SHA: OLDER,
			MAX_UNSHIPPED_HOURS: '1',
			NOW_OVERRIDE: NOW
		});

		expect(verdict.status).toBe('alert');
		expect(verdict.threshold_hours).toBe('1');
	});

	it.each(['', 'soon', '0', '-3'])(
		'falls back to the 6h default when the threshold variable is %j',
		async (threshold) => {
			const { verdict } = runVerdict(await verdictBlock(), {
				TIP_SHA: TIP,
				TIP_TIME: '2026-09-05T10:30:00Z',
				PROD_SHA: OLDER,
				MAX_UNSHIPPED_HOURS: threshold,
				NOW_OVERRIDE: NOW
			});

			expect(verdict.threshold_hours).toBe('6');
			expect(verdict.status).toBe('pending');
		}
	);

	it('treats a commit timestamped in the future as brand new, not ancient', async () => {
		const { verdict } = runVerdict(await verdictBlock(), {
			TIP_SHA: TIP,
			TIP_TIME: '2026-09-05T13:00:00Z',
			PROD_SHA: OLDER,
			NOW_OVERRIDE: NOW
		});

		expect(verdict.status).toBe('pending');
		expect(verdict.age_minutes).toBe('0');
	});

	it('ignores a non-numeric discarded count instead of failing the run', async () => {
		const { verdict } = runVerdict(await verdictBlock(), {
			TIP_SHA: TIP,
			TIP_TIME: '2026-09-04T06:00:00Z',
			PROD_SHA: OLDER,
			DISCARDED: 'null',
			NOW_OVERRIDE: NOW
		});

		expect(verdict.status).toBe('alert');
		expect(verdict.discarded).toBe('0');
		expect(verdict.headline).not.toContain('discarded');
	});
});
