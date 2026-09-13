import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(__dirname, '../../../..');
const workflowPath = join(repositoryRoot, '.github/workflows/external-uptime-monitor.yml');

async function summaryBlock(): Promise<string> {
	const workflow = await readFile(workflowPath, 'utf8');
	const start = workflow.indexOf('# A short human summary for the issue TITLE');
	const end = workflow.indexOf('\n\n          {', start);

	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);

	return workflow
		.slice(start, end)
		.replace(/\r\n/g, '\n')
		.replace(/^ {10}/gm, '');
}

/**
 * Runs a block lifted out of the workflow under the SAME shell flags GitHub
 * gives a `run:` step (`bash -e` plus the step's own `set -uo pipefail`), with
 * a scrubbed environment so a runner's Bash startup hooks cannot change the
 * semantics under test.
 */
function runWorkflowBash(script: string): SpawnSyncReturns<string> {
	const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
	// The self-hosted runners may inject Bash startup hooks through either
	// BASH_ENV or ENV. Give this contract only the OS variables it needs so a
	// runner profile cannot change the shell semantics under test.
	const cleanEnv = Object.fromEntries(
		['PATH', 'HOME', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP']
			.map((key) => [key, process.env[key]])
			.filter((entry): entry is [string, string] => typeof entry[1] === 'string')
	);
	return spawnSync(bash, ['--noprofile', '--norc', '-euo', 'pipefail', '-c', script], {
		encoding: 'utf8',
		env: cleanEnv
	});
}

function shellSingleQuote(value: string): string {
	return value.replace(/'/g, `'"'"'`);
}

function exerciseSummary(block: string, failingUrls: string) {
	return runWorkflowBash(
		`FAILING_URLS='${shellSingleQuote(failingUrls)}'\n${block}\nprintf '<%s>|<%s>|<%s>' "\${FAIL_COUNT}" "\${FIRST_FAIL}" "\${FAIL_SUMMARY}"\n`
	);
}

describe('external uptime monitor summary contract', () => {
	it('survives an empty failure list under the workflow Bash flags', async () => {
		const result = exerciseSummary(await summaryBlock(), '');

		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('<0>|<>|<>');
	});

	it('keeps the first failing host in the alert summary', async () => {
		const result = exerciseSummary(
			await summaryBlock(),
			'https://demo.ever.works/\nhttps://mcp.ever.works/health\n'
		);

		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('<2>|<demo.ever.works>|<demo.ever.works +1 more>');
	});
});

// ---------------------------------------------------------------------------
// EW-760 (3) + (4): duration escalation and partial-recovery reporting.
//
// The workflow deliberately keeps no external store, so the entire cross-run
// memory of an outage is one `<!-- uptime-state: ... -->` comment that the
// previous run wrote onto the alert issue. That parse-decide-reemit block is
// the only new logic with branches worth pinning, and it is pure text plus
// arithmetic, so it is lifted out of the YAML and exercised under the
// workflow's own Bash flags exactly like the summary contract above.
// ---------------------------------------------------------------------------

const ESCALATION_START = '# >>> uptime-escalation-state';
const ESCALATION_END = '# <<< uptime-escalation-state';

async function escalationBlock(): Promise<string> {
	const workflow = await readFile(workflowPath, 'utf8');
	const start = workflow.indexOf(ESCALATION_START);
	const end = workflow.indexOf(ESCALATION_END, start + 1);

	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);

	return workflow
		.slice(start, end)
		.replace(/\r\n/g, '\n')
		.replace(/^ {10}/gm, '');
}

interface EscalationInput {
	fingerprint: string;
	failingUrlsCsv: string;
	lastBody: string;
	nowEpoch: number;
}

interface EscalationResult {
	tier: string;
	prevTier: string;
	escalated: string;
	duration: string;
	recovered: string;
	since: string;
	ageMin: string;
	stateMark: string;
}

function stateMark(fp: string, since: number, tier: number, urls: string): string {
	return `<!-- uptime-state: fp=${fp} since=${since} tier=${tier} urls=${urls} -->`;
}

/** A realistic previous report: prose, the throttle marker, then the state marker. */
function issueBody(mark: string): string {
	return [
		'## 🔴 Ever Works endpoint(s) unreachable from outside the homelab',
		'',
		'| | Surface | URL |',
		'',
		'<!-- uptime-fingerprint: deadbeefdeadbeef -->',
		mark
	].join('\n');
}

function exerciseEscalation(block: string, input: EscalationInput): EscalationResult {
	const prelude = [
		`FINGERPRINT='${shellSingleQuote(input.fingerprint)}'`,
		`FAILING_URLS_CSV='${shellSingleQuote(input.failingUrlsCsv)}'`,
		`LAST_BODY='${shellSingleQuote(input.lastBody)}'`,
		`NOW_EPOCH=${input.nowEpoch}`
	].join('\n');
	const report =
		`printf '<%s>\\n<%s>\\n<%s>\\n<%s>\\n<%s>\\n<%s>\\n<%s>\\n<%s>\\n' ` +
		`"\${TIER}" "\${PREV_TIER}" "\${ESCALATED}" "\${DURATION_LABEL}" ` +
		`"\${RECOVERED_LIST}" "\${SINCE_EPOCH}" "\${AGE_MIN}" "\${STATE_MARK}"`;

	const result = runWorkflowBash(`${prelude}\n${block}\n${report}\n`);

	expect(result.stderr).toBe('');
	expect(result.status).toBe(0);

	const fields = result.stdout.split('\n').map((line) => line.replace(/^</, '').replace(/>$/, ''));
	return {
		tier: fields[0],
		prevTier: fields[1],
		escalated: fields[2],
		duration: fields[3],
		recovered: fields[4],
		since: fields[5],
		ageMin: fields[6],
		stateMark: fields[7]
	};
}

describe('external uptime monitor escalation contract', () => {
	const NOW = 1_800_000_000;
	const FP = 'aaaabbbbccccdddd';

	it('starts the outage clock on a fresh issue with no previous state', async () => {
		const result = exerciseEscalation(await escalationBlock(), {
			fingerprint: FP,
			failingUrlsCsv: 'https://demo.ever.works/',
			lastBody: '',
			nowEpoch: NOW
		});

		expect(result.since).toBe(String(NOW));
		expect(result.ageMin).toBe('0');
		expect(result.tier).toBe('0');
		expect(result.escalated).toBe('0');
		expect(result.duration).toBe('');
		expect(result.recovered).toBe('');
		expect(result.stateMark).toBe(stateMark(FP, NOW, 0, 'https://demo.ever.works/'));
	});

	it('escalates to tier 1 once the same failing set has been down an hour', async () => {
		const since = NOW - 65 * 60;
		const result = exerciseEscalation(await escalationBlock(), {
			fingerprint: FP,
			failingUrlsCsv: 'https://app.ever.works/login',
			lastBody: issueBody(stateMark(FP, since, 0, 'https://app.ever.works/login')),
			nowEpoch: NOW
		});

		expect(result.since).toBe(String(since));
		expect(result.ageMin).toBe('65');
		expect(result.tier).toBe('1');
		expect(result.prevTier).toBe('0');
		expect(result.escalated).toBe('1');
		// Bucketed to the 15-minute probe interval, so the title moves when the
		// severity moves rather than on every single run.
		expect(result.duration).toBe('1h0m');
	});

	it('stays put at tier 1 on the next run, then escalates again at four hours', async () => {
		const block = await escalationBlock();

		const steady = exerciseEscalation(block, {
			fingerprint: FP,
			failingUrlsCsv: 'https://app.ever.works/login',
			lastBody: issueBody(stateMark(FP, NOW - 80 * 60, 1, 'https://app.ever.works/login')),
			nowEpoch: NOW
		});
		expect(steady.tier).toBe('1');
		expect(steady.escalated).toBe('0');
		expect(steady.duration).toBe('1h15m');

		const louder = exerciseEscalation(block, {
			fingerprint: FP,
			failingUrlsCsv: 'https://app.ever.works/login',
			lastBody: issueBody(stateMark(FP, NOW - 300 * 60, 1, 'https://app.ever.works/login')),
			nowEpoch: NOW
		});
		expect(louder.tier).toBe('2');
		expect(louder.escalated).toBe('1');
		expect(louder.duration).toBe('5h0m');
	});

	it('restarts the clock when the failing set changes, because that is a new event', async () => {
		const result = exerciseEscalation(await escalationBlock(), {
			fingerprint: 'ffff0000ffff0000',
			failingUrlsCsv: 'https://app.ever.works/login,https://api.ever.works/',
			lastBody: issueBody(stateMark(FP, NOW - 300 * 60, 2, 'https://demo.ever.works/')),
			nowEpoch: NOW
		});

		expect(result.since).toBe(String(NOW));
		expect(result.tier).toBe('0');
		expect(result.prevTier).toBe('0');
		expect(result.escalated).toBe('0');
		expect(result.duration).toBe('');
	});

	it('names the targets that recovered while others stayed down', async () => {
		const result = exerciseEscalation(await escalationBlock(), {
			fingerprint: 'ffff0000ffff0000',
			failingUrlsCsv: 'https://app.ever.works/login',
			lastBody: issueBody(
				stateMark(FP, NOW - 60 * 60, 1, 'https://demo.ever.works/,https://app.ever.works/login')
			),
			nowEpoch: NOW
		});

		// This is the 2026-08-23 shape exactly: demo healed, the app went down,
		// and the open issue said nothing about either change.
		expect(result.recovered).toBe('https://demo.ever.works/ ');
	});

	it('reports nothing recovered when the failing set only grew', async () => {
		const result = exerciseEscalation(await escalationBlock(), {
			fingerprint: 'ffff0000ffff0000',
			failingUrlsCsv: 'https://demo.ever.works/,https://app.ever.works/login',
			lastBody: issueBody(stateMark(FP, NOW - 60 * 60, 1, 'https://demo.ever.works/')),
			nowEpoch: NOW
		});

		expect(result.recovered).toBe('');
	});

	it('round-trips the state marker it emits', async () => {
		const block = await escalationBlock();
		const first = exerciseEscalation(block, {
			fingerprint: FP,
			failingUrlsCsv: 'https://demo.ever.works/',
			lastBody: '',
			nowEpoch: NOW
		});

		const later = exerciseEscalation(block, {
			fingerprint: FP,
			failingUrlsCsv: 'https://demo.ever.works/',
			lastBody: issueBody(first.stateMark),
			nowEpoch: NOW + 90 * 60
		});

		expect(later.since).toBe(String(NOW));
		expect(later.ageMin).toBe('90');
		expect(later.tier).toBe('1');
	});

	it('treats a corrupt state marker as absent instead of failing the run', async () => {
		// A monitor that dies on bad input goes SILENT, which is the one outcome
		// this workflow must never produce.
		const result = exerciseEscalation(await escalationBlock(), {
			fingerprint: FP,
			failingUrlsCsv: 'https://demo.ever.works/',
			lastBody: issueBody('<!-- uptime-state: fp= since=not-a-number tier=huge urls= -->'),
			nowEpoch: NOW
		});

		expect(result.since).toBe(String(NOW));
		expect(result.tier).toBe('0');
		expect(result.escalated).toBe('0');
	});

	it('survives an entirely empty input set under the workflow Bash flags', async () => {
		const result = exerciseEscalation(await escalationBlock(), {
			fingerprint: '',
			failingUrlsCsv: '',
			lastBody: '',
			nowEpoch: NOW
		});

		expect(result.tier).toBe('0');
		expect(result.recovered).toBe('');
	});
});
