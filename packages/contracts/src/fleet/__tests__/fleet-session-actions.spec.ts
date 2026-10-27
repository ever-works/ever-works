import { describe, expect, it } from 'vitest';

import {
	FLEET_CHANGES_MAX_FILE_BYTES,
	FLEET_SESSION_ACTION_DEFAULTS,
	FLEET_SESSION_ACTION_IDS,
	FLEET_SESSION_ACTION_RATE,
	availableFleetSessionActions,
	fleetSessionActionInputBytes,
	fleetSessionBranchSlug,
	isFleetProtectedBranch,
	isFleetSessionOnDefaultBranch,
	parseFleetCheckoutChangesReply,
	proposeFleetSessionBranch,
	renderFleetSessionActionPrompt,
	unknownFleetSessionActionPlaceholders,
	type FleetSessionActionContext
} from '../fleet-session-actions.types.js';

const base: FleetSessionActionContext = {
	kind: 'agent',
	provider: 'claude-code',
	state: 'working',
	hasCheckout: true,
	branch: 'nina/fix-login',
	baseRef: 'main',
	defaultBranch: 'main',
	protectedBranches: ['main', 'release/*'],
	pr: null,
	unresolvedComments: null,
	mergeable: null
};

function offered(context: FleetSessionActionContext): string[] {
	return availableFleetSessionActions(context)
		.filter((action) => action.available)
		.map((action) => action.id);
}

describe('FL-06 — action templates', () => {
	it('renders the four placeholders and leaves any other word in braces as it is', () => {
		const out = renderFleetSessionActionPrompt('{branch} → {base} · {pull} · {task} · {other} · {}', {
			branch: 'nina/fix-login',
			base: 'main',
			pullNumber: 912,
			task: { slug: 'T-42', title: 'Fix login' }
		});
		expect(out).toBe('nina/fix-login → main · #912 · Task T-42: Fix login · {other} · {}');
		expect(unknownFleetSessionActionPlaceholders('{branch} {other} {other} {Base}')).toEqual(['other', 'Base']);
	});

	it('names readable fallbacks when a value is missing', () => {
		expect(
			renderFleetSessionActionPrompt('{branch}|{base}|{pull}|{task}', {
				branch: null,
				base: null,
				pullNumber: null,
				task: null
			})
		).toBe('the current branch|the default branch|none is open yet|no Task');
	});

	it('ships a default for every action, each naming the placeholders it needs', () => {
		for (const id of FLEET_SESSION_ACTION_IDS) {
			expect(FLEET_SESSION_ACTION_DEFAULTS[id].length).toBeGreaterThan(20);
			expect(unknownFleetSessionActionPlaceholders(FLEET_SESSION_ACTION_DEFAULTS[id])).toEqual([]);
		}
		expect(FLEET_SESSION_ACTION_DEFAULTS.commit).toContain('{branch}');
		expect(FLEET_SESSION_ACTION_DEFAULTS.commitPush).toContain('{branch}');
		expect(FLEET_SESSION_ACTION_DEFAULTS.pullRequest).toContain('{base}');
		expect(FLEET_SESSION_ACTION_DEFAULTS.pullRequest).toContain('{pull}');
		expect(FLEET_SESSION_ACTION_DEFAULTS.pullRequest).toMatch(/never merge it/);
		expect(FLEET_SESSION_ACTION_DEFAULTS.review).toContain('{base}');
		expect(FLEET_SESSION_ACTION_DEFAULTS.review).toMatch(/do not change any code/i);
		expect(FLEET_SESSION_ACTION_DEFAULTS.fixComments).toContain('{pull}');
		expect(FLEET_SESSION_ACTION_DEFAULTS.resolveConflicts).toContain('{base}');
		expect(FLEET_SESSION_ACTION_DEFAULTS.recap).toContain('{task}');
	});

	it('types a prompt as one line and one Enter, never a control character', () => {
		expect(fleetSessionActionInputBytes('line one\nline two\r\n\u001b[2Jthree')).toBe(
			'line one line two [2Jthree\r'
		);
	});

	it('pins the CONTRACTS §10 rate', () => {
		expect(FLEET_SESSION_ACTION_RATE).toEqual({ perMinute: 10, minSpacingMs: 2000 });
	});
});

describe('FL-06 — relevance rules (spec FR-15)', () => {
	it('offers no prompt action in a shell session, and none once ended', () => {
		expect(offered({ ...base, provider: 'shell' })).toEqual([]);
		expect(availableFleetSessionActions({ ...base, provider: 'shell' })[0].reason).toBe('shell-session');
		expect(offered({ ...base, state: 'ended' })).toEqual([]);
	});

	it('outside a checkout offers the recap only', () => {
		expect(offered({ ...base, hasCheckout: false })).toEqual(['recap']);
	});

	it('on the default branch hides the pull request, fix-comments and conflicts', () => {
		const context = { ...base, kind: 'owner' as const, branch: 'main', protectedBranches: [] };
		expect(offered(context)).toEqual(['commit', 'commitPush', 'review', 'recap']);
		const pr = availableFleetSessionActions(context).find((action) => action.id === 'pullRequest');
		expect(pr?.reason).toBe('default-branch');
	});

	it('an Agent on a protected branch never sees push or pull request; an owner sees push with a warning', () => {
		const agent = { ...base, branch: 'release/1.2', defaultBranch: 'main' };
		expect(offered(agent)).not.toContain('commitPush');
		expect(offered(agent)).not.toContain('pullRequest');
		const owner = availableFleetSessionActions({ ...agent, kind: 'owner' });
		expect(owner.find((action) => action.id === 'commitPush')).toMatchObject({
			available: true,
			warning: 'pushes-protected'
		});
	});

	it('reads "Update the pull request" when one is open, and fix-comments only with unresolved comments', () => {
		const open = { ...base, pr: { number: 912, state: 'open' as const }, unresolvedComments: 2 };
		const actions = availableFleetSessionActions(open);
		expect(actions.find((action) => action.id === 'pullRequest')?.update).toEqual({ number: 912 });
		expect(actions.find((action) => action.id === 'fixComments')).toMatchObject({
			available: true,
			unresolvedComments: 2
		});
		expect(offered({ ...open, unresolvedComments: 0 })).not.toContain('fixComments');
		expect(offered({ ...base, unresolvedComments: 3 })).not.toContain('fixComments');
	});

	it('offers conflicts only when an open pull request is not cleanly mergeable', () => {
		const open = { ...base, pr: { number: 912, state: 'open' as const } };
		expect(offered({ ...open, mergeable: false })).toContain('resolveConflicts');
		expect(offered({ ...open, mergeable: true })).not.toContain('resolveConflicts');
		expect(offered({ ...open, mergeable: null })).not.toContain('resolveConflicts');
		expect(offered({ ...base, mergeable: false })).not.toContain('resolveConflicts');
	});

	it('marks every offer read-as-answer while the session waits on someone', () => {
		const actions = availableFleetSessionActions({ ...base, state: 'needs_you' });
		expect(actions.filter((action) => action.available).every((action) => action.readAsAnswer)).toBe(true);
	});

	it('matches protected patterns and guesses the default branch', () => {
		expect(isFleetProtectedBranch('release/1.2', ['release/*'])).toBe(true);
		expect(isFleetProtectedBranch('releases', ['release/*'])).toBe(false);
		expect(isFleetSessionOnDefaultBranch({ branch: 'main', baseRef: 'origin/main' })).toBe(true);
		expect(isFleetSessionOnDefaultBranch({ branch: 'nina/x', baseRef: 'main' })).toBe(false);
		expect(isFleetSessionOnDefaultBranch({ branch: 'master', baseRef: null })).toBe(true);
		expect(isFleetSessionOnDefaultBranch({ branch: 'develop', baseRef: null, defaultBranch: 'develop' })).toBe(
			true
		);
	});
});

describe('FL-06 — the branch rule (spec FR-3 … FR-5, U9)', () => {
	it('keeps a Task branch as it is, never suffixed', () => {
		expect(
			proposeFleetSessionBranch({ prefix: 'nina', taskBranch: 'task/fix-login-42', taken: ['task/fix-login-42'] })
		).toMatchObject({ branch: 'task/fix-login-42', suffixed: false, source: 'task' });
	});

	it('slugs the first message, then the title, then a generated name', () => {
		expect(
			proposeFleetSessionBranch({ prefix: 'Nina', firstMessage: 'Fix the login bug!', taken: [] }).branch
		).toBe('nina/fix-the-login-bug');
		expect(proposeFleetSessionBranch({ prefix: 'nina', title: 'Café menu', taken: [] })).toMatchObject({
			branch: 'nina/cafe-menu',
			source: 'title'
		});
		const generated = proposeFleetSessionBranch({ prefix: 'nina', taken: [], random: () => 0 });
		expect(generated.branch).toBe('nina/session-aaaa');
		expect(generated.source).toBe('generated');
	});

	it('suffixes a name already used on the remote or by any checkout', () => {
		expect(
			proposeFleetSessionBranch({
				prefix: 'nina',
				firstMessage: 'fix login',
				taken: ['nina/fix-login', 'nina/fix-login-2']
			})
		).toMatchObject({ branch: 'nina/fix-login-3', base: 'nina/fix-login', suffixed: true });
	});

	it('caps slugs at 40 characters on a word boundary', () => {
		const slug = fleetSessionBranchSlug('make the dashboard load much faster for every single customer today');
		expect(slug.length).toBeLessThanOrEqual(40);
		expect(slug.endsWith('-')).toBe(false);
		expect(fleetSessionBranchSlug('!!!')).toBe('');
	});
});

describe('FL-06 — the Changes reply (spec FR-9, U15)', () => {
	it('re-applies the per-file and total caps and counts what it left out', () => {
		const big = 'x'.repeat(FLEET_CHANGES_MAX_FILE_BYTES + 10);
		const reply = parseFleetCheckoutChangesReply(
			{
				path: '/home/nina/code/api',
				at: '2026-10-21T10:00:00.000Z',
				files: [
					{ path: 'a.ts', status: 'modified', added: 1, removed: 2, patch: big },
					{ path: 'b.ts', status: 'added', added: 3, removed: 0, patch: 'y'.repeat(8000) },
					{ path: 'img.png', status: 'modified', binary: true, patch: 'should be dropped' },
					{ path: '/etc/passwd', status: 'modified', patch: 'absolute paths are refused' }
				]
			},
			FLEET_CHANGES_MAX_FILE_BYTES + 100
		);
		expect(reply).not.toBeNull();
		expect(reply!.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts', 'img.png']);
		expect(reply!.files[0].patch?.length).toBe(FLEET_CHANGES_MAX_FILE_BYTES);
		expect(reply!.files[0].truncated).toBe(true);
		expect(reply!.files[1].patch).toBeNull();
		expect(reply!.files[2]).toMatchObject({ binary: true, patch: null, added: null });
		expect(reply!.truncated).toBe(true);
		expect(reply!.omittedFiles).toBe(1);
		expect(reply!.omittedBytes).toBe(10 + 8000);
	});

	it('answers null for something that is not a reply', () => {
		expect(parseFleetCheckoutChangesReply(null)).toBeNull();
		expect(parseFleetCheckoutChangesReply({ path: 'relative', files: [] })).toBeNull();
	});
});
