import { describe, expect, it } from 'vitest';
import { FLEET_SELF_UPDATE_MAX_ERROR_LENGTH, normalizeFleetNodeSelfUpdate } from '../fleet-node.types.js';

/** Fleet node link (FL-02, T-25, FR-37, FR-38, U16) — the self-update report's reader. */
describe('normalizeFleetNodeSelfUpdate', () => {
	it('reads a full report', () => {
		expect(
			normalizeFleetNodeSelfUpdate({
				enabled: true,
				failedAt: '2026-10-21T09:12:00Z',
				error: 'npm install exited 1',
				targetVersion: '0.3.0',
				updatedAt: null,
				fromVersion: null
			})
		).toEqual({
			enabled: true,
			failedAt: '2026-10-21T09:12:00.000Z',
			error: 'npm install exited 1',
			targetVersion: '0.3.0',
			updatedAt: null,
			fromVersion: null
		});
	});

	it('is null for anything that is not an object', () => {
		for (const value of [null, undefined, 'on', 1, true, []]) {
			expect(normalizeFleetNodeSelfUpdate(value)).toBeNull();
		}
	});

	it('grants enabled only for a literal true and drops junk fields', () => {
		expect(
			normalizeFleetNodeSelfUpdate({ enabled: 'true', failedAt: 'yesterday', error: 42, targetVersion: '' })
		).toEqual({
			enabled: false,
			failedAt: null,
			error: null,
			targetVersion: null,
			updatedAt: null,
			fromVersion: null
		});
	});

	it('bounds the error sentence', () => {
		const report = normalizeFleetNodeSelfUpdate({ enabled: true, error: 'x'.repeat(5000) });
		expect(report?.error).toHaveLength(FLEET_SELF_UPDATE_MAX_ERROR_LENGTH);
	});
});
