import { describe, expect, it } from 'vitest';
import {
	FLEET_MANAGEMENT_LANE_CONSENT,
	FLEET_MANAGEMENT_LANE_KINDS,
	fleetManagementLaneConsentFor,
	fleetManagementLaneKindsFor
} from '../fleet-jobs.types.js';
import { FLEET_NO_CONSENTS } from '../fleet-link.types.js';

/** Fleet node link (FL-02, T-27, CONTRACTS R-34) — the management lane's kind list and its consents. */
describe('the management lane', () => {
	it('carries exactly the kinds epics registered: FL-16 vm-* (--manage), FL-20 usage-scan (--usage-scan), FL-18 runner-* (--work)', () => {
		// FL-02 shipped the list empty ("no node starts the lane until an epic
		// registers a kind"); FL-16 registered its kinds first, FL-20 and FL-18 appended theirs.
		expect(FLEET_MANAGEMENT_LANE_KINDS).toEqual([
			'vm-create',
			'vm-control',
			'usage-scan',
			'runner-install',
			'runner-control'
		]);
		expect(FLEET_MANAGEMENT_LANE_CONSENT).toEqual({
			'vm-create': 'manage',
			'vm-control': 'manage',
			'usage-scan': 'usageScan',
			'runner-install': 'work',
			'runner-control': 'work'
		});
		expect(
			fleetManagementLaneKindsFor({ ...FLEET_NO_CONSENTS, work: true, manage: true, usageScan: true })
		).toEqual(['vm-create', 'vm-control', 'usage-scan', 'runner-install', 'runner-control']);
		// --work alone leases the runner jobs only; --usage-scan alone leases only the scan.
		expect(fleetManagementLaneKindsFor({ ...FLEET_NO_CONSENTS, work: true })).toEqual([
			'runner-install',
			'runner-control'
		]);
		expect(fleetManagementLaneKindsFor({ ...FLEET_NO_CONSENTS, usageScan: true })).toEqual(['usage-scan']);
		expect(fleetManagementLaneKindsFor({ ...FLEET_NO_CONSENTS, work: true, usageScan: true })).toEqual([
			'usage-scan',
			'runner-install',
			'runner-control'
		]);
		// --manage never leases the scan (its own consent) nor a runner job (runner jobs are work, CONTRACTS §1.1).
		expect(fleetManagementLaneKindsFor({ ...FLEET_NO_CONSENTS, manage: true })).toEqual([
			'vm-create',
			'vm-control'
		]);
	});

	it('needs manage for a kind the table does not name (the safest reading)', () => {
		expect(fleetManagementLaneConsentFor('browser-check', {})).toBe('manage');
		expect(fleetManagementLaneConsentFor('browser-check', { 'browser-check': 'work' })).toBe('work');
	});

	it('leases a registered kind only while its consent is on', () => {
		const kinds = ['browser-check', 'acceptance-checks'] as const;
		const table = { 'browser-check': 'usageScan', 'acceptance-checks': 'manage' } as const;
		expect(fleetManagementLaneKindsFor({ ...FLEET_NO_CONSENTS }, kinds, table)).toEqual([]);
		expect(fleetManagementLaneKindsFor({ ...FLEET_NO_CONSENTS, usageScan: true }, kinds, table)).toEqual([
			'browser-check'
		]);
		expect(
			fleetManagementLaneKindsFor({ ...FLEET_NO_CONSENTS, usageScan: true, manage: true }, kinds, table)
		).toEqual(['browser-check', 'acceptance-checks']);
		// --work alone grants neither of these.
		expect(fleetManagementLaneKindsFor({ ...FLEET_NO_CONSENTS, work: true }, kinds, table)).toEqual([]);
	});

	it('answers nothing without consents and never repeats a kind', () => {
		expect(fleetManagementLaneKindsFor(null, ['browser-check'], {})).toEqual([]);
		expect(
			fleetManagementLaneKindsFor({ ...FLEET_NO_CONSENTS, manage: true }, ['browser-check', 'browser-check'], {})
		).toEqual(['browser-check']);
	});
});
