import { describe, it, expect } from 'vitest';
import {
	automaticRecordVisibility,
	DEFAULT_RECORD_LIST_VIEW,
	DEFAULT_RECORD_VISIBILITY,
	isRecordVisibility,
	normalizeRecordListView,
	normalizeRecordVisibility,
	RECORD_LIST_VIEWS,
	RECORD_VISIBILITIES,
	VISIBILITY_AGGREGATES
} from '../index.js';

/** Record visibility vocabulary (EW-P1-3, `docs/specs/features/record-visibility/spec.md`). */
describe('record visibility vocabulary', () => {
	it('lists the three visibilities, narrowest first, with private as the default', () => {
		expect(RECORD_VISIBILITIES).toEqual(['private', 'team', 'organization']);
		expect(DEFAULT_RECORD_VISIBILITY).toBe('private');
		expect(VISIBILITY_AGGREGATES).toEqual(['task', 'goal', 'mission', 'idea', 'agent']);
	});

	it('isRecordVisibility accepts exactly the known values (fail closed on write)', () => {
		for (const value of RECORD_VISIBILITIES) {
			expect(isRecordVisibility(value)).toBe(true);
		}
		expect(isRecordVisibility('Team')).toBe(false);
		expect(isRecordVisibility('public')).toBe(false);
		expect(isRecordVisibility(undefined)).toBe(false);
		expect(isRecordVisibility(1)).toBe(false);
	});

	it('normalizeRecordVisibility reads unknown values as private, never wider', () => {
		expect(normalizeRecordVisibility('organization')).toBe('organization');
		expect(normalizeRecordVisibility(' TEAM ')).toBe('team');
		expect(normalizeRecordVisibility('public')).toBe('private');
		expect(normalizeRecordVisibility(null)).toBe('private');
		expect(normalizeRecordVisibility(undefined)).toBe('private');
	});

	it('automaticRecordVisibility applies D11: personal private, org team-or-organization', () => {
		expect(automaticRecordVisibility({ organizationId: null, hasTeam: true })).toBe('private');
		expect(automaticRecordVisibility({ organizationId: undefined, hasTeam: false })).toBe('private');
		expect(automaticRecordVisibility({ organizationId: 'org-1', hasTeam: true })).toBe('team');
		expect(automaticRecordVisibility({ organizationId: 'org-1', hasTeam: false })).toBe('organization');
	});

	it('list views default to mine, and unknown values keep the old list', () => {
		expect(RECORD_LIST_VIEWS).toEqual(['mine', 'shared', 'organization']);
		expect(DEFAULT_RECORD_LIST_VIEW).toBe('mine');
		expect(normalizeRecordListView('shared')).toBe('shared');
		expect(normalizeRecordListView('ORGANIZATION')).toBe('organization');
		expect(normalizeRecordListView('everything')).toBe('mine');
		expect(normalizeRecordListView(undefined)).toBe('mine');
	});
});
