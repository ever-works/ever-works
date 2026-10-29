import { describe, expect, it } from 'vitest';

import { TASK_DELIVERY_STATES as TASK_DELIVERY_STATES_FROM_ROOT } from '../../index.js';
import {
	APP_DELIVERY_RECONCILE_BATCH,
	APP_FAILURE_LOG_TAIL_LINES,
	APP_FOLLOW_UPS_OPEN_PER_WORK_MAX,
	APP_FOLLOW_UPS_PER_CHANGE_MAX,
	TASK_DELIVERY_CLOSABLE_STATES,
	TASK_DELIVERY_CLOSE_NOTE_MAX,
	TASK_DELIVERY_DEPLOY_OUTCOMES,
	TASK_DELIVERY_ERROR_CODES,
	TASK_DELIVERY_FILTER_GROUPS,
	TASK_DELIVERY_FILTER_WAITING,
	TASK_DELIVERY_OPEN_STATES,
	TASK_DELIVERY_STATE_FILTERS,
	TASK_DELIVERY_STATES
} from '../task-delivery.types.js';

/**
 * APW-08 T7 — the delivery chain's shared vocabulary (plan §3.4). Every value here is a
 * persisted or wire value (`tasks.deliveryState`, the delivery route's codes), so each is pinned.
 */
describe('task-delivery.types (APW-08 T7)', () => {
	it('pins the eight delivery states, in FR-30 order', () => {
		expect(TASK_DELIVERY_STATES).toEqual([
			'merged',
			'building',
			'build_failed',
			'built',
			'deploying',
			'deploy_failed',
			'live',
			'closed_without_deploy'
		]);
		expect(TASK_DELIVERY_STATES_FROM_ROOT).toBe(TASK_DELIVERY_STATES);
	});

	it('every state fits the varchar(24) column', () => {
		for (const state of TASK_DELIVERY_STATES) expect(state.length).toBeLessThanOrEqual(24);
	});

	it('the reconciler visits every state but the two terminal ones', () => {
		expect([...TASK_DELIVERY_OPEN_STATES].sort()).toEqual(
			TASK_DELIVERY_STATES.filter((s) => s !== 'live' && s !== 'closed_without_deploy').sort()
		);
	});

	it('Close anyway accepts only a state whose change is not live and not in flight', () => {
		expect(TASK_DELIVERY_CLOSABLE_STATES).toEqual(['merged', 'build_failed', 'built', 'deploy_failed']);
	});

	it('names the three APW-06 failure outcomes apart (FR-30 {outcome})', () => {
		expect(TASK_DELIVERY_DEPLOY_OUTCOMES).toEqual([
			'failed',
			'rolled_back',
			'rollback_failed',
			'live_with_warnings'
		]);
	});

	it('pins the plan §3.4 numbers (APW08-G25 defaults)', () => {
		expect(APP_FOLLOW_UPS_PER_CHANGE_MAX).toBe(2);
		expect(APP_FOLLOW_UPS_OPEN_PER_WORK_MAX).toBe(3);
		expect(APP_FAILURE_LOG_TAIL_LINES).toBe(200);
		expect(APP_DELIVERY_RECONCILE_BATCH).toBe(200);
		expect(TASK_DELIVERY_CLOSE_NOTE_MAX).toBe(500);
	});

	it('pins the route error codes', () => {
		expect(TASK_DELIVERY_ERROR_CODES).toEqual(['notClosable', 'followUpLimit', 'notTracked']);
	});

	it('the list filter accepts every state plus the not-merged-yet token, which is never a state', () => {
		expect(TASK_DELIVERY_FILTER_WAITING).toBe('waiting');
		expect((TASK_DELIVERY_STATES as readonly string[]).includes(TASK_DELIVERY_FILTER_WAITING)).toBe(false);
		expect([...TASK_DELIVERY_STATE_FILTERS].sort()).toEqual(
			[TASK_DELIVERY_FILTER_WAITING, ...TASK_DELIVERY_STATES].sort()
		);
	});

	it('the Delivery select puts every state in exactly one option (spec §6.1)', () => {
		expect(Object.keys(TASK_DELIVERY_FILTER_GROUPS)).toEqual([
			'waiting',
			'building',
			'deploying',
			'live',
			'failed',
			'closed'
		]);
		const tokens = Object.values(TASK_DELIVERY_FILTER_GROUPS).flat();
		expect(new Set(tokens).size).toBe(tokens.length);
		expect([...tokens].sort()).toEqual([...TASK_DELIVERY_STATE_FILTERS].sort());
	});
});
