import { describe, expect, it } from 'vitest';
import {
	changesReservedTaskLabels,
	isReservedTaskLabel,
	reservedTaskLabelChanges,
	reservedTaskLabelRefusal,
	taskReservedLabelsEnforced
} from '../task-reserved-labels.types.js';
import { promotionTaskLabels } from '../../release/promotion.types.js';
import { releaseRevertTaskLabels } from '../../release/deployment-verification.types.js';

describe('reserved Task labels (works-security 2026-10-18)', () => {
	it('reserves every control-signal label the platform reads', () => {
		for (const label of [
			'awaiting-owner',
			'app-provision',
			'provision-attempt-2',
			...promotionTaskLabels('stage-to-main'),
			...releaseRevertTaskLabels('stage-to-main')
		]) {
			expect(isReservedTaskLabel(label)).toBe(true);
		}
	});

	it('refuses look-alike spellings and ignores ordinary labels', () => {
		expect(isReservedTaskLabel(' Awaiting-Owner ')).toBe(true);
		expect(isReservedTaskLabel('APP-PROVISION')).toBe(true);
		for (const label of ['bug', 'app-change', 'triage', 'releases', '', null, 3]) {
			expect(isReservedTaskLabel(label)).toBe(false);
		}
	});

	it('reports additions and removals, never order or ordinary labels', () => {
		expect(reservedTaskLabelChanges(['awaiting-owner', 'bug'], ['bug', 'p1'])).toEqual({
			added: [],
			removed: ['awaiting-owner']
		});
		expect(reservedTaskLabelChanges(['bug'], ['bug', 'app-provision'])).toEqual({
			added: ['app-provision'],
			removed: []
		});
		expect(changesReservedTaskLabels(['release:revert', 'x'], ['y', 'release:revert'])).toBe(false);
		// Clearing every label removes the reserved ones too.
		expect(reservedTaskLabelChanges(['awaiting-owner'], null).removed).toEqual(['awaiting-owner']);
		// A write that does not touch labels changes nothing.
		expect(changesReservedTaskLabels(['awaiting-owner'], undefined)).toBe(false);
	});

	it('is enforced unless explicitly switched off', () => {
		expect(taskReservedLabelsEnforced(undefined)).toBe(true);
		expect(taskReservedLabelsEnforced('')).toBe(true);
		expect(taskReservedLabelsEnforced('true')).toBe(true);
		expect(taskReservedLabelsEnforced('yes-please')).toBe(true);
		for (const off of ['false', 'FALSE', '0', 'off', 'no']) {
			expect(taskReservedLabelsEnforced(off)).toBe(false);
		}
	});

	it('names who was refused and what', () => {
		const text = reservedTaskLabelRefusal('A fleet-run credential', {
			added: ['app-provision'],
			removed: ['awaiting-owner']
		});
		expect(text).toContain('A fleet-run credential cannot add "app-provision" or remove "awaiting-owner"');
	});
});
