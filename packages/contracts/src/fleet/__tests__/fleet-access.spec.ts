import { describe, expect, it } from 'vitest';

import { COMPUTER_CONTROL_POLICIES } from '../../computer/computer-session.types.js';
import { COMPUTER_VIEWER_ROLES } from '../../computer/computer-control.types.js';
import {
	FLEET_ACTION_FAMILIES,
	FLEET_ACTION_FAMILY_HINT_LABELS,
	FLEET_AUDIENCES,
	FLEET_CONTROL_POLICY_DEFAULTS,
	FLEET_VIEWER_ROLES,
	audienceIncludes,
	diffControlPolicyFamilies,
	effectiveControlPolicy,
	fleetFamilyAllows,
	fleetPermissionDeniedHint,
	isFleetActionFamily,
	isFleetAudience,
	narrowestAudienceFor,
	normalizeControlPolicyFamilies
} from '../fleet-access.types.js';
import type { FleetAudience, FleetViewerRole } from '../fleet-access.types.js';

/**
 * Fleet hub (FL-01) — the per-family control policy and the role truth
 * table every family check in the Fleet program runs through.
 */

describe('action families (CONTRACTS §2.1)', () => {
	it('lists the thirteen families in the contract order', () => {
		expect(FLEET_ACTION_FAMILIES).toEqual([
			'view',
			'sessions',
			'desktop',
			'logs',
			'services',
			'docker',
			'processes',
			'ports',
			'files',
			'commands',
			'schedules',
			'checkouts',
			'machines'
		]);
	});

	it('recognises a family and refuses anything else', () => {
		expect(isFleetActionFamily('machines')).toBe(true);
		expect(isFleetActionFamily('lifecycle')).toBe(false);
		expect(isFleetActionFamily(undefined)).toBe(false);
	});

	it('names every family for a hint, and calls machines "lifecycle"', () => {
		for (const family of FLEET_ACTION_FAMILIES) {
			expect(FLEET_ACTION_FAMILY_HINT_LABELS[family]).toBeTruthy();
		}
		expect(FLEET_ACTION_FAMILY_HINT_LABELS.machines).toBe('lifecycle');
	});
});

describe('audiences and roles', () => {
	it('reuses AW-11 control policies as the audiences (desktop IS that policy)', () => {
		expect(FLEET_AUDIENCES).toBe(COMPUTER_CONTROL_POLICIES);
		expect(FLEET_AUDIENCES).toEqual(['owner', 'org-admins', 'org-members']);
		expect(isFleetAudience('org-admins')).toBe(true);
		expect(isFleetAudience('everyone')).toBe(false);
	});

	it('reuses AW-11 viewer roles as the caller roles', () => {
		expect(FLEET_VIEWER_ROLES).toBe(COMPUTER_VIEWER_ROLES);
	});

	// 3 audiences × 4 roles, spelled out so a change to either side is a red test.
	const TABLE: ReadonlyArray<[FleetAudience, FleetViewerRole, boolean]> = [
		['owner', 'owner', true],
		['owner', 'org-admin', false],
		['owner', 'org-member', false],
		['owner', 'stranger', false],
		['org-admins', 'owner', true],
		['org-admins', 'org-admin', true],
		['org-admins', 'org-member', false],
		['org-admins', 'stranger', false],
		['org-members', 'owner', true],
		['org-members', 'org-admin', true],
		['org-members', 'org-member', true],
		['org-members', 'stranger', false]
	];

	it.each(TABLE)('audience %s admits %s: %s', (audience, role, expected) => {
		expect(audienceIncludes(audience, role)).toBe(expected);
	});

	it('names the narrowest audience a role needs', () => {
		expect(narrowestAudienceFor('owner')).toBe('owner');
		expect(narrowestAudienceFor('org-admin')).toBe('org-admins');
		expect(narrowestAudienceFor('org-member')).toBe('org-members');
		expect(narrowestAudienceFor('stranger')).toBeNull();
	});
});

describe('effectiveControlPolicy', () => {
	it('defaults view to org-members and every other family to owner', () => {
		const policy = effectiveControlPolicy({});
		expect(policy.view).toBe('org-members');
		for (const family of FLEET_ACTION_FAMILIES.filter((f) => f !== 'view')) {
			expect(policy[family]).toBe('owner');
		}
		expect(effectiveControlPolicy(null)).toEqual(FLEET_CONTROL_POLICY_DEFAULTS);
	});

	it('reads desktop from the legacy single value when the map has no desktop entry (ACC-FL01-15)', () => {
		const policy = effectiveControlPolicy({ controlPolicy: 'org-admins', controlPolicyFamilies: null });
		expect(policy.desktop).toBe('org-admins');
		expect(policy.view).toBe('org-members');
		expect(policy.services).toBe('owner');
	});

	it('lets the map entry win over the legacy value for desktop', () => {
		const policy = effectiveControlPolicy({
			controlPolicy: 'org-admins',
			controlPolicyFamilies: { desktop: 'org-members' }
		});
		expect(policy.desktop).toBe('org-members');
	});

	it('applies a partial map over the defaults', () => {
		const policy = effectiveControlPolicy({
			controlPolicy: 'owner',
			controlPolicyFamilies: { sessions: 'org-admins', view: 'owner' }
		});
		expect(policy.sessions).toBe('org-admins');
		expect(policy.view).toBe('owner');
		expect(policy.services).toBe('owner');
	});

	it('reads a map stored as a JSON string (simple-json on either driver)', () => {
		const policy = effectiveControlPolicy({ controlPolicyFamilies: '{"logs":"org-members"}' });
		expect(policy.logs).toBe('org-members');
	});

	it('falls back to the default for an unknown legacy value instead of guessing', () => {
		expect(effectiveControlPolicy({ controlPolicy: 'everyone' }).desktop).toBe('owner');
	});
});

describe('normalizeControlPolicyFamilies', () => {
	it('drops unknown families and unknown audiences', () => {
		expect(
			normalizeControlPolicyFamilies({ services: 'org-admins', lifecycle: 'org-admins', docker: 'everyone' })
		).toEqual({ services: 'org-admins' });
	});

	it('answers null for anything that is not a map', () => {
		expect(normalizeControlPolicyFamilies(null)).toBeNull();
		expect(normalizeControlPolicyFamilies(['view'])).toBeNull();
		expect(normalizeControlPolicyFamilies('not json')).toBeNull();
		expect(normalizeControlPolicyFamilies(42)).toBeNull();
	});

	it('keeps an empty map distinct from no map', () => {
		expect(normalizeControlPolicyFamilies({})).toEqual({});
	});
});

describe('fleetFamilyAllows', () => {
	it('never admits a stranger, whatever the policy says (FR-32)', () => {
		const wide = Object.fromEntries(FLEET_ACTION_FAMILIES.map((family) => [family, 'org-members']));
		for (const family of FLEET_ACTION_FAMILIES) {
			expect(fleetFamilyAllows({ controlPolicyFamilies: wide }, 'stranger', family)).toBe(false);
		}
	});

	it('always admits the owner, whatever the policy says', () => {
		for (const family of FLEET_ACTION_FAMILIES) {
			expect(fleetFamilyAllows({ controlPolicyFamilies: {} }, 'owner', family)).toBe(true);
		}
	});

	it('admits an org admin to a widened family and refuses a narrow one (S10)', () => {
		const node = { controlPolicyFamilies: { sessions: 'org-admins' } };
		expect(fleetFamilyAllows(node, 'org-admin', 'sessions')).toBe(true);
		expect(fleetFamilyAllows(node, 'org-admin', 'services')).toBe(false);
		expect(fleetFamilyAllows(node, 'org-member', 'sessions')).toBe(false);
		expect(fleetFamilyAllows(node, 'org-member', 'view')).toBe(true);
	});
});

describe('diffControlPolicyFamilies', () => {
	it('lists only the families whose audience changed, in family order', () => {
		const before = effectiveControlPolicy({ controlPolicy: 'owner' });
		const after = effectiveControlPolicy({
			controlPolicy: 'owner',
			controlPolicyFamilies: { machines: 'org-admins', sessions: 'org-admins', view: 'org-members' }
		});
		expect(diffControlPolicyFamilies(before, after)).toEqual([
			{ family: 'sessions', from: 'owner', to: 'org-admins' },
			{ family: 'machines', from: 'owner', to: 'org-admins' }
		]);
		expect(diffControlPolicyFamilies(after, after)).toEqual([]);
	});
});

describe('fleetPermissionDeniedHint', () => {
	it('tells an org admin what to ask for, naming the family as people say it', () => {
		expect(fleetPermissionDeniedHint('build-01', 'machines', 'org-admin')).toBe(
			'Ask the owner of build-01 to allow org admins: lifecycle.'
		);
		expect(fleetPermissionDeniedHint('build-01', 'services', 'org-admin')).toBe(
			'Ask the owner of build-01 to allow org admins: services.'
		);
	});

	it('tells an org member to ask for members', () => {
		expect(fleetPermissionDeniedHint('build-01', 'docker', 'org-member')).toBe(
			'Ask the owner of build-01 to allow org members: Docker.'
		);
	});

	it('says only the owner can for anyone else', () => {
		expect(fleetPermissionDeniedHint('build-01', 'machines', 'stranger')).toBe(
			'Only the owner of build-01 can do this.'
		);
	});
});
