import { describe, expect, it } from 'vitest';
import { normalizeFleetUsageReport, type FleetUsageReport } from '@ever-works/contracts';
import { runUsageScan, UsageScanRefusedError, type UsageScanDeps } from './usage-scan-executor';
import { listUsageRecordFiles, resolveUsageRoots } from './usage-roots';
import { usageFolderBucket } from './usage-aggregate';
import { readUsageLines } from './usage-line-reader';
import {
	FORBIDDEN_STRINGS,
	MemoryUsageFs,
	claudeLine,
	claudeToolResultLine,
	claudeUserLine,
	codexMetaLine,
	codexTokenLine,
	codexTurnLine
} from './__fixtures__/usage-fixtures';

const HOME = '/home/owner';
const CLAUDE_DIR = `${HOME}/.claude/projects/-home-owner-code-api`;
const CODEX_DIR = `${HOME}/.codex/sessions/2026/10/20`;
const STATE_DIR = `${HOME}/.ever-works/usage`;
const NOW = Date.parse('2026-10-21T12:00:00.000Z');

function deps(fs: MemoryUsageFs, overrides: Partial<UsageScanDeps> = {}): UsageScanDeps {
	return {
		enabled: () => true,
		stateDir: STATE_DIR,
		platform: 'linux',
		fs,
		roots: () => ({ env: {}, homedir: HOME, platform: 'linux' }),
		allowedRoots: async () => ['/home/owner/code/api'],
		now: () => NOW,
		...overrides
	};
}

function seed(fs: MemoryUsageFs): void {
	fs.addFile(
		`${CLAUDE_DIR}/c0ffee00-1111-4222-8333-444455556666.jsonl`,
		[
			claudeUserLine('c0ffee00-1111-4222-8333-444455556666', '2026-10-20T10:00:00.000Z'),
			claudeLine({
				sessionId: 'c0ffee00-1111-4222-8333-444455556666',
				messageId: 'msg_01',
				at: '2026-10-20T10:01:00.000Z',
				usage: { input: 10, output: 100, cacheRead: 1000, cacheWrite: 200 }
			}),
			// The same response's second content block: same ids, final output count.
			claudeLine({
				sessionId: 'c0ffee00-1111-4222-8333-444455556666',
				messageId: 'msg_01',
				at: '2026-10-20T10:01:01.000Z',
				usage: { input: 10, output: 150, cacheRead: 1000, cacheWrite: 200 }
			}),
			claudeToolResultLine('c0ffee00-1111-4222-8333-444455556666', '2026-10-20T10:01:02.000Z'),
			claudeLine({
				sessionId: 'c0ffee00-1111-4222-8333-444455556666',
				messageId: 'msg_02',
				at: '2026-10-20T10:30:00.000Z',
				usage: { input: 5, output: 50, cacheRead: 2000, cacheWrite: 0 }
			})
		].join('\n') + '\n'
	);
	fs.addFile(
		`${CODEX_DIR}/rollout-2026-10-20T11-00-00-0199aaaa.jsonl`,
		[
			codexMetaLine('0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000', '2026-10-20T11:00:00.000Z', '/srv/elsewhere/project'),
			codexTurnLine('2026-10-20T11:00:01.000Z'),
			codexTokenLine(
				'2026-10-20T11:00:02.000Z',
				{ input: 1000, cached: 600, output: 50 },
				{ input: 1000, cached: 600, output: 50 }
			)
		].join('\n') + '\n'
	);
}

function totals(report: FleetUsageReport) {
	return report.rows.reduce(
		(sum, row) => ({
			in: sum.in + row.tokens.in,
			out: sum.out + row.tokens.out,
			cacheRead: sum.cacheRead + row.tokens.cacheRead,
			cacheWrite: sum.cacheWrite + row.tokens.cacheWrite,
			requests: sum.requests + row.requests
		}),
		{ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
	);
}

describe('runUsageScan (FL-20 T-11)', () => {
	it('reports cumulative buckets with counts only — never a prompt, an output or a folder outside the roots', async () => {
		const fs = new MemoryUsageFs();
		seed(fs);
		const report = await runUsageScan(deps(fs), null);
		expect(report.truncated).toBe(false);
		expect(report.backlogPct).toBe(0);
		expect(totals(report)).toEqual({
			in: 15 + 400,
			out: 200 + 50,
			cacheRead: 3000 + 600,
			cacheWrite: 200,
			requests: 3
		});
		const claude = report.rows.find((row) => row.provider === 'claude-code');
		expect(claude).toMatchObject({
			providerSessionId: 'c0ffee00-1111-4222-8333-444455556666',
			model: 'claude-sonnet-4-5-20250929',
			bucketStart: '2026-10-20T10:00:00.000Z',
			// Inside an allowed root: the ROOT is reported, never the working folder itself.
			folderBucket: '/home/owner/code/api'
		});
		const codex = report.rows.find((row) => row.provider === 'codex');
		// Outside every root: an opaque bucket.
		expect(codex?.folderBucket).toMatch(/^other:[0-9a-f]{8}$/);
		// The platform reads every row back (allow-listed shapes only).
		expect(normalizeFleetUsageReport(report)?.droppedRows).toBe(0);
		const text = JSON.stringify(report) + (await fs.readFile(`${STATE_DIR}/state.json`));
		for (const forbidden of FORBIDDEN_STRINGS) expect(text).not.toContain(forbidden);
		expect(text).not.toContain('/srv/elsewhere');
	});

	it('scanning the same records twice — and then with a file deleted — never changes the totals (U4, U5)', async () => {
		const fs = new MemoryUsageFs();
		seed(fs);
		const first = await runUsageScan(deps(fs), null);
		// Platform acknowledged the first report; nothing changed since.
		const again = await runUsageScan(deps(fs), first.watermark);
		expect(again.rows).toEqual([]);
		expect(again.watermark).toBe(first.watermark);
		// The platform lost the acknowledgement: everything is re-sent, unchanged.
		const resent = await runUsageScan(deps(fs), 0);
		expect(totals(resent)).toEqual(totals(first));
		// A record file is deleted: nothing is subtracted.
		fs.remove(`${CODEX_DIR}/rollout-2026-10-20T11-00-00-0199aaaa.jsonl`);
		const afterDelete = await runUsageScan(deps(fs), 0);
		expect(totals(afterDelete)).toEqual(totals(first));
	});

	it('counts appended records only, and a resumed session copying old lines is counted once', async () => {
		const fs = new MemoryUsageFs();
		seed(fs);
		const first = await runUsageScan(deps(fs), null);
		const copied = claudeLine({
			sessionId: 'c0ffee00-1111-4222-8333-444455556666',
			messageId: 'msg_02',
			at: '2026-10-20T10:30:00.000Z',
			usage: { input: 5, output: 50, cacheRead: 2000, cacheWrite: 0 }
		});
		fs.addFile(`${CLAUDE_DIR}/resumed.jsonl`, `${copied}\n`);
		fs.append(
			`${CLAUDE_DIR}/c0ffee00-1111-4222-8333-444455556666.jsonl`,
			claudeLine({
				sessionId: 'c0ffee00-1111-4222-8333-444455556666',
				messageId: 'msg_03',
				at: '2026-10-20T10:45:00.000Z',
				usage: { input: 1, output: 1 }
			}) + '\n'
		);
		const next = await runUsageScan(deps(fs), first.watermark);
		// Only the bucket that grew is re-sent, with its new CUMULATIVE total.
		expect(next.rows).toHaveLength(1);
		expect(next.rows[0].requests).toBe(3);
		expect(next.rows[0].tokens.in).toBe(16);
	});

	it('leaves a line still being written for the next scan', async () => {
		const fs = new MemoryUsageFs();
		const path = `${CLAUDE_DIR}/partial.jsonl`;
		const full = claudeLine({
			sessionId: 's-1',
			messageId: 'msg_p',
			at: '2026-10-20T10:00:00.000Z',
			usage: { input: 3, output: 4 }
		});
		fs.addFile(path, full.slice(0, 40));
		expect((await runUsageScan(deps(fs), null)).rows).toEqual([]);
		fs.append(path, `${full.slice(40)}\n`);
		const report = await runUsageScan(deps(fs), null);
		expect(totals(report).requests).toBe(1);
	});

	it('drains a large backlog over several scans, within the row cap, oldest first (U11)', async () => {
		const lines: string[] = [];
		for (let i = 0; i < 30; i += 1) {
			const hour = new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 3_600_000).toISOString();
			lines.push(
				claudeLine({ sessionId: 's-big', messageId: `msg_${i}`, at: hour, usage: { input: 1, output: 1 } })
			);
		}
		// A byte budget smaller than the file: the first scan reports a backlog.
		const fs2 = new MemoryUsageFs();
		fs2.addFile(`${CLAUDE_DIR}/big.jsonl`, lines.join('\n') + '\n');
		const partial = await runUsageScan(deps(fs2, { budgetBytes: 4096 }), null);
		expect(partial.backlogPct).toBeGreaterThan(0);
		let drained = partial;
		for (let i = 0; i < 40 && drained.backlogPct > 0; i += 1) {
			drained = await runUsageScan(deps(fs2, { budgetBytes: 4096 }), drained.watermark);
		}
		expect(drained.backlogPct).toBe(0);
		const everything = await runUsageScan(deps(fs2), 0);
		expect(totals(everything).requests).toBe(30);
	});

	it('trims a report to the row cap, oldest revision first, and the next one continues after it', async () => {
		const fs = new MemoryUsageFs();
		const lines: string[] = [];
		for (let i = 0; i < 520; i += 1) {
			const hour = new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 3_600_000).toISOString();
			lines.push(
				claudeLine({ sessionId: 's-cap', messageId: `msg_${i}`, at: hour, usage: { input: 1, output: 1 } })
			);
		}
		fs.addFile(`${CLAUDE_DIR}/cap.jsonl`, lines.join('\n') + '\n');
		const first = await runUsageScan(deps(fs), null);
		expect(first.rows).toHaveLength(500);
		expect(first.truncated).toBe(true);
		expect(first.backlogPct).toBeGreaterThan(0);
		expect(first.rows[0].bucketStart).toBe('2026-01-01T00:00:00.000Z');
		const second = await runUsageScan(deps(fs), first.watermark);
		expect(second.rows).toHaveLength(20);
		expect(second.truncated).toBe(false);
		expect(new Set([...first.rows, ...second.rows].map((row) => row.bucketStart)).size).toBe(520);
	});

	it('refuses when the owner switched the scan off (defence in depth)', async () => {
		const fs = new MemoryUsageFs();
		await expect(runUsageScan(deps(fs, { enabled: () => false }), null)).rejects.toBeInstanceOf(
			UsageScanRefusedError
		);
	});

	it('re-sends everything when the platform is ahead of a node that lost its state', async () => {
		const fs = new MemoryUsageFs();
		seed(fs);
		const report = await runUsageScan(deps(fs), 9_999);
		expect(report.rows.length).toBeGreaterThan(0);
		expect(report.watermark).toBeGreaterThan(9_999);
	});
});

describe('usage roots and folders (FL-20 T-08)', () => {
	it('reads both CLI homes and $CLAUDE_CONFIG_DIR / $CODEX_HOME, de-duplicated', () => {
		const roots = resolveUsageRoots({
			env: { CLAUDE_CONFIG_DIR: '/opt/claude-home', CODEX_HOME: '/home/owner/.codex' },
			homedir: HOME,
			platform: 'linux'
		});
		expect(roots).toEqual([
			{ provider: 'claude-code', dir: '/opt/claude-home/projects' },
			{ provider: 'claude-code', dir: '/home/owner/.claude/projects' },
			{ provider: 'codex', dir: '/home/owner/.codex/sessions' }
		]);
	});

	it('never follows a symbolic link out of a records folder', async () => {
		const fs = new MemoryUsageFs();
		fs.addFile(`${CLAUDE_DIR}/real.jsonl`, '\n');
		fs.addLink(`${HOME}/.claude/projects/escape`);
		fs.addLink(`${CLAUDE_DIR}/linked.jsonl`);
		const files = await listUsageRecordFiles(
			{ provider: 'claude-code', dir: `${HOME}/.claude/projects` },
			fs,
			'linux'
		);
		expect(files.map((file) => file.path)).toEqual([`${CLAUDE_DIR}/real.jsonl`]);
	});

	it('buckets a folder as its longest root, else an opaque hash, case-insensitively on Windows', () => {
		expect(
			usageFolderBucket('/home/owner/code/api/src', ['/home/owner/code', '/home/owner/code/api'], 'linux')
		).toBe('/home/owner/code/api');
		expect(usageFolderBucket('/home/owner/code-other', ['/home/owner/code'], 'linux')).toMatch(
			/^other:[0-9a-f]{8}$/
		);
		expect(usageFolderBucket('C:\\Users\\Owner\\Code\\Api', ['c:\\users\\owner\\code'], 'win32')).toBe(
			'c:\\users\\owner\\code'
		);
		expect(usageFolderBucket(null, ['/x'], 'linux')).toBeNull();
	});
});

describe('readUsageLines', () => {
	it('skips an over-long line without parsing it, even across calls', async () => {
		const big = 'x'.repeat(5000);
		const content = Buffer.from(`${big}\n{"ok":1}\n`, 'utf8');
		const handle = {
			read: async (length: number, position: number) =>
				Buffer.from(content.subarray(position, position + length)),
			close: async () => undefined
		};
		const seen: string[] = [];
		const first = await readUsageLines(
			handle,
			0,
			content.length,
			{ budgetBytes: 1000, maxLineBytes: 100, chunkBytes: 256 },
			(line) => seen.push(line)
		);
		expect(first.skipping).toBe(true);
		expect(first.nextOffset).toBe(1000);
		const second = await readUsageLines(
			handle,
			first.nextOffset,
			content.length,
			{ budgetBytes: 10_000, maxLineBytes: 100, chunkBytes: 256, startSkipping: true },
			(line) => seen.push(line)
		);
		expect(second.oversize).toBe(1);
		expect(seen).toEqual(['{"ok":1}']);
		expect(second.nextOffset).toBe(content.length);
	});
});
