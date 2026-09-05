import { describe, expect, it } from 'vitest';
import { FLEET_MAX_WORKSPACE_COUNT } from '@ever-works/contracts';
import { NodeHousekeepingReporter, summarizeWorkspaceReap } from './housekeeping-report';
import type { WorkspaceReapResult } from './workspaces/workspace-reaper';
import type { WorkspacePoolRecord, WorkspaceRecord } from './workspaces/workspace-inventory';

/**
 * Node housekeeping reporting (EW-803) — what the heartbeat says about
 * this machine's disk floor and its reclaim activity.
 *
 * The properties worth pinning are the ones an operator would be misled
 * by if they broke: a figure this cannot vouch for must be ABSENT rather
 * than zero, a dry run must never look like a reclaim, and the freed-bytes
 * figure must never be shown against the wrong instant.
 */

const GIB = 1024 ** 3;

const record = (sizeBytes: number, path = '/w/a'): WorkspaceRecord =>
	({ path, sizeBytes }) as unknown as WorkspaceRecord;

const pool = (sizeBytes: number, path = '/p/a'): WorkspacePoolRecord =>
	({ path, sizeBytes }) as unknown as WorkspacePoolRecord;

function reapResult(over: Partial<WorkspaceReapResult> = {}): WorkspaceReapResult {
	return {
		dryRun: false,
		removed: [],
		kept: [],
		removedPools: [],
		keptPools: [],
		freedBytes: 0,
		errors: [],
		...over
	};
}

describe('summarizeWorkspaceReap', () => {
	it('counts what SURVIVED the sweep, not what the scan started with', () => {
		const result = reapResult({
			removed: [{ record: record(5 * GIB, '/w/gone'), freedBytes: 5 * GIB }],
			kept: [
				{ record: record(2 * GIB, '/w/a'), reason: 'uncommitted changes' },
				{ record: record(1 * GIB, '/w/b'), reason: 'within the max age' }
			],
			keptPools: [{ pool: pool(3 * GIB), reason: '2 worktree(s) still registered' }],
			freedBytes: 5 * GIB
		});

		const summary = summarizeWorkspaceReap(result);
		expect(summary.workspaceCount).toBe(2);
		expect(summary.workspaceBytes).toBe(6 * GIB);
		expect(summary.freedBytes).toBe(5 * GIB);
		expect(summary.dryRun).toBe(false);
	});

	it('counts a removal that FAILED its final re-check as still on disk', () => {
		// `runWorkspaceReap` pushes a refused removal onto `kept`, which is
		// exactly why the post-sweep picture is read off `kept` rather than
		// derived as `totalBytes - freedBytes`: the derived form would
		// under-report the moment a removal was refused.
		const result = reapResult({
			kept: [{ record: record(4 * GIB, '/w/refused'), reason: 'lease appeared during removal' }],
			errors: ['/w/refused: lease appeared during removal']
		});

		const summary = summarizeWorkspaceReap(result);
		expect(summary.workspaceCount).toBe(1);
		expect(summary.workspaceBytes).toBe(4 * GIB);
		expect(summary.freedBytes).toBe(0);
	});

	it('reports a dry run as reclaiming NOTHING, and counts what it only planned to remove', () => {
		// A dry run leaves every byte where it was. Reporting its
		// `freedBytes` — which is what COULD be freed — as an accomplished
		// reclaim is the single way this figure could actively mislead.
		const result = reapResult({
			dryRun: true,
			removed: [{ record: record(7 * GIB, '/w/would-go'), freedBytes: 7 * GIB }],
			kept: [{ record: record(1 * GIB, '/w/stays'), reason: 'within the max age' }],
			freedBytes: 7 * GIB
		});

		const summary = summarizeWorkspaceReap(result);
		expect(summary.freedBytes).toBe(0);
		// Both are still there.
		expect(summary.workspaceCount).toBe(2);
		expect(summary.workspaceBytes).toBe(8 * GIB);
		expect(summary.dryRun).toBe(true);
	});

	it('treats a missing or nonsensical size as zero rather than propagating NaN', () => {
		const result = reapResult({
			kept: [
				{ record: record(Number.NaN, '/w/nan'), reason: 'size unknown' },
				{ record: record(-1, '/w/negative'), reason: 'size unknown' },
				{ record: record(2 * GIB, '/w/real'), reason: 'within the max age' }
			]
		});

		const summary = summarizeWorkspaceReap(result);
		expect(summary.workspaceBytes).toBe(2 * GIB);
		expect(Number.isFinite(summary.workspaceBytes)).toBe(true);
	});
});

describe('NodeHousekeepingReporter', () => {
	it('reports the floor from startup, before any sweep has run', () => {
		// The floor is known immediately; the first reaper cycle is a
		// minute away and on a heartbeat-only machine never comes. An
		// operator must not have to wait for a sweep to learn where the
		// line is.
		const reporter = new NodeHousekeepingReporter({ minFreeDiskBytes: 2 * GIB });

		expect(reporter.describe()).toEqual({ minFreeDiskBytes: 2 * GIB });
	});

	it('reports a switched-off floor as an explicit null, not as an absent field', () => {
		// Absent means "leave the stored value alone" on the server, so an
		// operator who turned the floor off needs a null to say so —
		// otherwise Fleet keeps showing the floor they just removed.
		const reporter = new NodeHousekeepingReporter({ minFreeDiskBytes: null });

		const report = reporter.describe();
		expect(report.minFreeDiskBytes).toBeNull();
		expect('minFreeDiskBytes' in report).toBe(true);
	});

	it('omits every reclaim field until a sweep has actually completed', () => {
		// Absent, never zero. "0 workspaces, 0 bytes freed" reads as a tidy
		// machine; the truth is that nothing has looked yet.
		const report = new NodeHousekeepingReporter({ minFreeDiskBytes: 2 * GIB }).describe();

		expect('workspaceCount' in report).toBe(false);
		expect('workspaceBytes' in report).toBe(false);
		expect('lastReclaimAt' in report).toBe(false);
		expect('lastReclaimFreedBytes' in report).toBe(false);
	});

	it('records a completed sweep and stamps it with the injected clock', () => {
		const reporter = new NodeHousekeepingReporter({
			minFreeDiskBytes: 2 * GIB,
			now: () => Date.parse('2026-09-05T09:30:00.000Z')
		});
		reporter.record(
			reapResult({
				removed: [{ record: record(3 * GIB, '/w/gone'), freedBytes: 3 * GIB }],
				kept: [{ record: record(1 * GIB, '/w/stays'), reason: 'within the max age' }],
				freedBytes: 3 * GIB
			})
		);

		expect(reporter.describe()).toEqual({
			minFreeDiskBytes: 2 * GIB,
			workspaceCount: 1,
			workspaceBytes: 1 * GIB,
			lastReclaimAt: '2026-09-05T09:30:00.000Z',
			lastReclaimFreedBytes: 3 * GIB
		});
	});

	it('records a sweep that freed nothing, because that is the reassuring answer', () => {
		// The timestamp is the whole point: "ran an hour ago, took nothing"
		// and "has not run since March" are opposite findings, and only a
		// moving stamp distinguishes them.
		const reporter = new NodeHousekeepingReporter({
			minFreeDiskBytes: 2 * GIB,
			now: () => Date.parse('2026-09-05T09:30:00.000Z')
		});
		reporter.record(reapResult({ kept: [{ record: record(1 * GIB), reason: 'within the max age' }] }));

		const report = reporter.describe();
		expect(report.lastReclaimAt).toBe('2026-09-05T09:30:00.000Z');
		expect(report.lastReclaimFreedBytes).toBe(0);
	});

	it('does NOT let a dry run refresh the reclaim stamp', () => {
		// `gc --dry-run` runs in a second process against the same root. If
		// it moved this stamp, an in-process reaper that had been dead for
		// weeks would look freshly run — which is the failure this whole
		// field exists to make visible.
		let clock = Date.parse('2026-09-05T09:30:00.000Z');
		const reporter = new NodeHousekeepingReporter({ minFreeDiskBytes: 2 * GIB, now: () => clock });
		reporter.record(reapResult({ freedBytes: 3 * GIB, kept: [{ record: record(GIB), reason: 'young' }] }));
		const afterRealSweep = reporter.describe();

		clock = Date.parse('2026-09-19T09:30:00.000Z');
		reporter.record(
			reapResult({
				dryRun: true,
				removed: [{ record: record(9 * GIB, '/w/would-go'), freedBytes: 9 * GIB }],
				freedBytes: 9 * GIB
			})
		);

		const report = reporter.describe();
		expect(report.lastReclaimAt).toBe(afterRealSweep.lastReclaimAt);
		expect(report.lastReclaimFreedBytes).toBe(3 * GIB);
		// The inventory it measured IS fresher, and is reported.
		expect(report.workspaceCount).toBe(1);
	});

	it('drops a workspace count past the contract ceiling rather than clamping it', () => {
		// A clamped count is one an operator would believe. Absent renders
		// as "unknown", which is the honest reading of a broken probe.
		const reporter = new NodeHousekeepingReporter({ minFreeDiskBytes: 2 * GIB });
		const kept = { record: record(1), reason: 'young' };
		reporter.record(reapResult({ kept: new Array(FLEET_MAX_WORKSPACE_COUNT + 1).fill(kept) }));

		const report = reporter.describe();
		expect('workspaceCount' in report).toBe(false);
		// The bytes it could vouch for still travel.
		expect(report.workspaceBytes).toBe(FLEET_MAX_WORKSPACE_COUNT + 1);
	});

	it('never reports freed bytes without the instant they belong to', () => {
		// "4.1 GB freed" is reassuring or alarming entirely depending on
		// when, so the pair is all-or-nothing.
		const reporter = new NodeHousekeepingReporter({
			minFreeDiskBytes: null,
			now: () => Number.NaN
		});
		reporter.record(reapResult({ freedBytes: 4 * GIB }));

		const report = reporter.describe();
		expect('lastReclaimAt' in report).toBe(false);
		expect('lastReclaimFreedBytes' in report).toBe(false);
	});
});
