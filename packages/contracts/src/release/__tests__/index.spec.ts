import { describe, expect, it } from 'vitest';

import * as release from '../index.js';

/**
 * The barrel declares nothing of its own (two `export *` lines), but it IS the
 * public surface every consumer reaches through `@ever-works/contracts`. A
 * dropped re-export line compiles fine here and only breaks at the call site in
 * another package, so it is pinned explicitly — same shape as the `policy`
 * barrel guard.
 *
 * Type-only exports are deliberately NOT asserted: they do not exist at runtime,
 * and any such check would be a no-op that always passes.
 */

const FUNCTION_EXPORTS = [
	'isPromotionRung',
	'sanitizeReleaseLadder',
	'resolvePromotionBranches',
	'promotionRungLabel',
	'promotionTaskLabels',
	'isPromotionTask',
	'promotionRungFromLabels',
	'promotionLaneKey',
	'isPromotionGatePass',
	'isPromotionGateDecided',
	'isPromotionGateDecisionOverdue',
	'isPromotionGateOverridden',
	'promotionGateVerdictFromRun'
] as const;

const VALUE_EXPORTS = [
	'PROMOTION_RUNGS',
	'RELEASE_BRANCH_MAX_LENGTH',
	'PROMOTION_TASK_LABEL',
	'PROMOTION_STATES',
	'PROMOTION_LANE_OPEN',
	'PROMOTION_GATE_WORKFLOW_FILE',
	'PROMOTION_GATE_VERDICTS',
	'PROMOTION_GATE_DECISION_GRACE_MS',
	'PROMOTION_GATE_OVERRIDE_LABEL'
] as const;

describe('release barrel', () => {
	it.each(FUNCTION_EXPORTS.map((name) => [name]))('re-exports %s as a function', (name) => {
		expect(typeof (release as Record<string, unknown>)[name]).toBe('function');
	});

	it.each(VALUE_EXPORTS.map((name) => [name]))('re-exports %s as a defined value', (name) => {
		expect((release as Record<string, unknown>)[name]).toBeDefined();
	});

	it('exposes exactly these 22 runtime symbols', () => {
		// Regression guard in BOTH directions: a re-export accidentally deleted
		// from index.ts fails here, and a NEW runtime export added without a spec
		// also fails here — forcing the author back to cover it.
		expect(Object.keys(release).sort()).toEqual([...FUNCTION_EXPORTS, ...VALUE_EXPORTS].sort());
		expect(Object.keys(release)).toHaveLength(22);
	});

	it('names each of the two source modules in the barrel', () => {
		// One symbol per `export *` line, so a whole missing line is unmissable.
		expect(release.PROMOTION_RUNGS).toBeDefined(); // promotion.types.js
		expect(release.PROMOTION_GATE_VERDICTS).toBeDefined(); // promotion-gate.types.js
	});
});
