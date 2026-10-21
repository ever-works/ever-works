import { describe, expect, it } from 'vitest';

import {
	fleetGitIdentityIncomplete,
	fleetGithubNoReplyEmail,
	maskFleetGitIdentity,
	parseFleetGitIdentityReply,
	type FleetGitIdentity
} from '../fleet-task-handoff.types.js';

const identity: FleetGitIdentity = {
	nodeId: 'n-1',
	name: { set: true, value: 'Your Name' },
	email: { set: true, value: '12345+you@users.noreply.github.com' },
	helper: { present: true, value: 'osxkeychain' },
	canPushForAgents: { ok: true, repositories: ['acme/api'] },
	readAt: '2026-10-21T12:00:00.000Z'
};

describe('git identity on a computer (FL-15 P2)', () => {
	it('composes the GitHub no-reply address and refuses junk', () => {
		expect(fleetGithubNoReplyEmail('12345', 'your-login')).toBe('12345+your-login@users.noreply.github.com');
		expect(fleetGithubNoReplyEmail(12345, 'your-login')).toBe('12345+your-login@users.noreply.github.com');
		expect(fleetGithubNoReplyEmail('abc', 'x')).toBeNull();
		expect(fleetGithubNoReplyEmail('1', 'bad login')).toBeNull();
	});

	it('masks the values for anyone but the owner (FR-13)', () => {
		expect(maskFleetGitIdentity(identity, true)).toBe(identity);
		const masked = maskFleetGitIdentity(identity, false);
		expect(masked.name).toEqual({ set: true });
		expect(masked.email).toEqual({ set: true });
		expect(masked.helper).toEqual({ present: true });
		expect(masked.canPushForAgents).toEqual(identity.canPushForAgents);
	});

	it('reads the node reply defensively', () => {
		expect(parseFleetGitIdentityReply(null)).toEqual({
			name: { set: false },
			email: { set: false },
			helper: { present: false },
			readAt: null
		});
		expect(
			parseFleetGitIdentityReply({ name: { set: true, value: 'N' }, email: { set: 'yes' }, helper: { present: true } })
		).toEqual({ name: { set: true, value: 'N' }, email: { set: false }, helper: { present: true }, readAt: null });
	});

	it('knows when the fix is offered inline (FR-16)', () => {
		expect(fleetGitIdentityIncomplete(identity)).toBe(false);
		expect(fleetGitIdentityIncomplete({ ...identity, email: { set: false } })).toBe(true);
	});
});
