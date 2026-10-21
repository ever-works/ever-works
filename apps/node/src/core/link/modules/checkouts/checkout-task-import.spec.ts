import { describe, expect, it } from 'vitest';
import type { WorkspaceInventory } from '../../../workspaces/workspace-inventory';
import { reaperNoteFor, taskCheckoutRecords } from './checkout-task-import';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-21T00:00:00.000Z');

function inventory(): WorkspaceInventory {
	return {
		rootPath: '/ws',
		exists: true,
		scannedAt: NOW,
		remoteRefreshed: false,
		totalBytes: 0,
		unrecognised: [],
		repositories: [
			{
				repositoryRoot: '/ws/repositories/r1',
				unrecognised: [],
				pools: [
					{
						path: '/ws/repositories/r1/repos/api',
						repositoryRoot: '/ws/repositories/r1',
						remoteUrl: 'https://x-access-token:abc@github.com/acme/api.git',
						registeredWorktrees: 1,
						pendingIntents: 0,
						lastUsedAt: null,
						sizeBytes: 0,
						owned: true,
						ownershipNote: null,
						defaultBranch: null,
						remoteRefreshed: false,
						unpushedCount: 'unknown'
					}
				],
				worktrees: [
					{
						path: '/ws/repositories/r1/worktrees/fleet-abc',
						repositoryRoot: '/ws/repositories/r1',
						poolPath: '/ws/repositories/r1/repos/api',
						gitDir: null,
						bindingKey: 'abc',
						branch: 'ever-works/task-42',
						headSha: 'a'.repeat(40),
						owned: true,
						ownershipNote: null,
						lastUsedAt: NOW - 11 * DAY,
						hasUsageRecord: true,
						sizeBytes: 4096,
						dirty: false,
						hasLocks: false,
						unpushedCount: 0,
						remoteBranch: 'unknown',
						mergedIntoDefault: 'unknown',
						intentPending: false,
						lease: null,
						mountLinks: [],
						mountsDir: 'absent',
						excludedOutput: false
					}
				]
			}
		]
	};
}

describe('Task worktrees as checkouts (FL-14 spec FR-7, ACC-FL14-04)', () => {
	it('maps each worktree to a worktree/task record with its pool remote, token-free', () => {
		const [record] = taskCheckoutRecords(inventory(), { reaperMaxAgeMs: 14 * DAY, now: () => NOW });
		expect(record).toMatchObject({
			path: '/ws/repositories/r1/worktrees/fleet-abc',
			kind: 'worktree',
			origin: 'task',
			remoteUrl: 'https://github.com/acme/api.git',
			remoteHadCredential: true,
			branch: 'ever-works/task-42',
			present: true,
			sizeBytes: 4096,
			busy: null,
			reaperNote: 'Would be tidied in 3 d (unused 11 d)'
		});
	});

	it('marks a worktree a live Task run holds busy', () => {
		const inv = inventory();
		inv.repositories[0].worktrees[0].lease = {
			alive: true
		} as unknown as (typeof inv.repositories)[0]['worktrees'][0]['lease'];
		expect(taskCheckoutRecords(inv)[0].busy).toBe('lease');
	});

	it('says nothing about the reaper for a worktree it cannot prove it owns', () => {
		expect(reaperNoteFor(NOW - DAY, false, 14 * DAY, NOW)).toBeNull();
		expect(reaperNoteFor(null, true, 14 * DAY, NOW)).toBeNull();
		expect(reaperNoteFor(NOW - 20 * DAY, true, 14 * DAY, NOW)).toBe(
			'Would be tidied at the next clean-up (unused 20 d)'
		);
	});
});
