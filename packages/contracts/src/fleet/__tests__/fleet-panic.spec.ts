import { describe, expect, it } from 'vitest';

import {
	FLEET_AUDIT_ACTIONS,
	FLEET_AUDIT_DEFAULT_LIMIT,
	FLEET_AUDIT_MAX_LIMIT,
	FLEET_CANCEL_IN_FLIGHT_MAX_IDS,
	FLEET_JOB_CANCEL_STATES,
	FLEET_KILL_SWITCH_ID,
	FLEET_KILL_SWITCH_REASON_MAX_LENGTH
} from '../fleet-panic.types.js';
import type { FleetAuditAction } from '../fleet-panic.types.js';

/**
 * The panic/audit vocabulary, pinned by LITERAL.
 *
 * `fleet_audit.action` is a `varchar(64)` with no enum and no check
 * constraint — that is what lets a slice add an action without a
 * type-altering migration, and it is also what makes a typo in an action
 * name a silently-accepted row that no reader will ever match. The two
 * halves below are the guard: the runtime list must equal the union
 * exactly, and every name must actually fit the column.
 */

/** The union, spelled out. A member added to the type must be added here. */
const EVERY_ACTION: readonly FleetAuditAction[] = [
	'kill-switch.stop',
	'kill-switch.clear',
	'drain-all',
	'cancel-in-flight',
	'node.create',
	'node.enroll',
	'node.token-revoke',
	'node.rotate',
	'node.rotate-self',
	'rotate-all',
	'node.rename',
	'node.capabilities',
	'node.cost-ceiling',
	'node.pause',
	'node.disable',
	'node.drain',
	'node.delete',
	'node.unenroll',
	'affinity.set',
	'affinity.clear',
	'execution-preference.set',
	'execution-preference.clear'
];

/** The `varchar(64)` the column actually is (`fleet-audit.entity.ts`). */
const ACTION_COLUMN_LENGTH = 64;

describe('FLEET_AUDIT_ACTIONS', () => {
	it('lists exactly the members of the FleetAuditAction union', () => {
		// `toEqual` on the sorted copies, so this fails on a MISSING name as
		// well as an extra one — the runtime list is what the API validates
		// and the UI filters by, and a union member absent from it is a row
		// nothing can find.
		expect([...FLEET_AUDIT_ACTIONS].sort()).toEqual([...EVERY_ACTION].sort());
	});

	it('keeps the four EW-778 actions verbatim', () => {
		// These four are already in deployed history. Renaming one would
		// orphan every row written before the rename.
		expect(FLEET_AUDIT_ACTIONS).toContain('kill-switch.stop');
		expect(FLEET_AUDIT_ACTIONS).toContain('kill-switch.clear');
		expect(FLEET_AUDIT_ACTIONS).toContain('drain-all');
		expect(FLEET_AUDIT_ACTIONS).toContain('cancel-in-flight');
	});

	it('has no duplicates', () => {
		expect(new Set(FLEET_AUDIT_ACTIONS).size).toBe(FLEET_AUDIT_ACTIONS.length);
	});

	it('fits every action name in the varchar(64) column', () => {
		for (const action of FLEET_AUDIT_ACTIONS) {
			expect(action.length).toBeGreaterThan(0);
			expect(action.length).toBeLessThanOrEqual(ACTION_COLUMN_LENGTH);
		}
	});

	it('uses lowercase kebab/dot names only', () => {
		// One shape, so an operator filtering the log does not have to guess
		// between `node.rotateSelf`, `node_rotate_self` and `node.rotate-self`.
		for (const action of FLEET_AUDIT_ACTIONS) {
			expect(action).toMatch(/^[a-z]+(?:-[a-z]+)*(?:\.[a-z]+(?:-[a-z]+)*)?$/);
		}
	});

	it('records no direction-paired verbs', () => {
		// Direction lives in `details.before` / `details.after`, following
		// `tenant_job_runtime_audit`. Any of the names below appearing here
		// means someone started encoding direction in the verb instead,
		// which doubles the vocabulary and still does not say what changed.
		const PAIRED = ['node.undrain', 'node.resume', 'node.unpause', 'node.enable', 'node.reenable'];
		for (const forbidden of PAIRED) {
			expect(FLEET_AUDIT_ACTIONS).not.toContain(forbidden);
		}
	});
});

describe('panic bounds', () => {
	it('keeps the audit default under its maximum', () => {
		expect(FLEET_AUDIT_DEFAULT_LIMIT).toBeGreaterThan(0);
		expect(FLEET_AUDIT_DEFAULT_LIMIT).toBeLessThanOrEqual(FLEET_AUDIT_MAX_LIMIT);
	});

	it('bounds the cancel-in-flight id list', () => {
		expect(FLEET_CANCEL_IN_FLIGHT_MAX_IDS).toBeGreaterThan(0);
	});

	it('names the one kill-switch row', () => {
		expect(FLEET_KILL_SWITCH_ID).toBe('global');
		expect(FLEET_KILL_SWITCH_REASON_MAX_LENGTH).toBeGreaterThan(0);
	});

	it('lists the four per-job cancel outcomes', () => {
		expect(FLEET_JOB_CANCEL_STATES).toEqual(['queued-dropped', 'cancel-requested', 'terminal', 'not-found']);
	});
});
