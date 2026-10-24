import { describe, expect, it } from 'vitest';

import {
	fleetCheckoutFolderName,
	isFleetCheckoutBranchName,
	parseFleetCheckoutChangesEvidence,
	parseFleetCheckoutsDeleteResult,
	proposeFleetCheckoutBranch
} from '../fleet-checkout.types.js';

describe('the branch rule (FL-14 spec FR-19, ACC-FL14-11)', () => {
	it('keeps a free name and suffixes a taken one', () => {
		expect(proposeFleetCheckoutBranch('nina/fix-login', [])).toBe('nina/fix-login');
		expect(proposeFleetCheckoutBranch('nina/fix-login', ['nina/fix-login'])).toBe('nina/fix-login-2');
		expect(proposeFleetCheckoutBranch('nina/fix-login', ['nina/fix-login', 'nina/fix-login-2'])).toBe(
			'nina/fix-login-3'
		);
	});
});

describe('isFleetCheckoutBranchName', () => {
	it.each(['main', 'nina/fix-login', 'release-1.2', 'ops/release_notes'])('accepts %s', (name) => {
		expect(isFleetCheckoutBranchName(name)).toBe(true);
	});

	it.each(['', '-upload-pack', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'x.lock', 'trailing/', 'a@{1}', 'a\\b'])(
		'refuses %j',
		(name) => {
			expect(isFleetCheckoutBranchName(name)).toBe(false);
		}
	);
});

describe('fleetCheckoutFolderName', () => {
	it('names the folder after the branch’s last segment, safely', () => {
		expect(fleetCheckoutFolderName('nina/fix-login')).toBe('fix-login');
		expect(fleetCheckoutFolderName('feature/über cool')).toBe('ber-cool');
		expect(fleetCheckoutFolderName('///')).toBe('checkout');
		expect(fleetCheckoutFolderName('team/..-fix-login.-')).toBe('fix-login');
		expect(fleetCheckoutFolderName('-.-.')).toBe('checkout');
	});

	it('stays linear on a long run of dashes that does not end the name (CodeQL #283)', () => {
		const hostile = `a${'-'.repeat(100_000)}b!`;
		const started = Date.now();
		expect(fleetCheckoutFolderName(hostile)).toBe(`a${'-'.repeat(79)}`);
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});

describe('delete evidence (spec FR-24)', () => {
	it('reads the counts and refuses a result without them', () => {
		expect(parseFleetCheckoutChangesEvidence({ uncommitted: 2, unpushedCommits: 1 })).toEqual({
			uncommitted: 2,
			unpushedCommits: 1,
			hasLocks: false
		});
		expect(parseFleetCheckoutChangesEvidence({ uncommitted: -1, unpushedCommits: 0 })).toBeNull();
		expect(
			parseFleetCheckoutsDeleteResult({
				path: '/srv/checkouts/api/fix-login',
				mode: 'delete',
				evidence: { uncommitted: 0, unpushedCommits: 0 },
				removed: true,
				branchKept: 'nina/fix-login'
			})
		).toMatchObject({ removed: true, branchKept: 'nina/fix-login' });
		expect(parseFleetCheckoutsDeleteResult({ path: '/x', mode: 'nuke', evidence: {} })).toBeNull();
	});
});
