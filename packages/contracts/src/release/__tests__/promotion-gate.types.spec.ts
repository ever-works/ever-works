import { describe, expect, it } from 'vitest';

import {
	PROMOTION_GATE_DECISION_GRACE_MS,
	PROMOTION_GATE_OVERRIDE_LABEL,
	PROMOTION_GATE_VERDICTS,
	PROMOTION_GATE_WORKFLOW_FILE,
	isPromotionGateDecided,
	isPromotionGateDecisionOverdue,
	isPromotionGateOverridden,
	isPromotionGatePass,
	promotionGateVerdictFromRun,
	type PromotionGateVerdict
} from '../promotion-gate.types.js';

describe('isPromotionGatePass — only an explicit success is a pass', () => {
	it('passes an explicit success', () => {
		expect(isPromotionGatePass('success')).toBe(true);
	});

	it.each(PROMOTION_GATE_VERDICTS.filter((verdict) => verdict !== 'success').map((verdict) => [verdict]))(
		'refuses %s',
		(verdict: PromotionGateVerdict) => {
			expect(isPromotionGatePass(verdict)).toBe(false);
		}
	);

	it.each([
		['null', null],
		['undefined', undefined]
	])('refuses %s — "cannot tell" is not a pass', (_label, verdict) => {
		expect(isPromotionGatePass(verdict as PromotionGateVerdict | null | undefined)).toBe(false);
	});

	it('refuses a value that is not a verdict at all', () => {
		// Written as an equality against the literal so anything new is a
		// refusal by default rather than falling into the pass set.
		expect(isPromotionGatePass('SUCCESS' as PromotionGateVerdict)).toBe(false);
		expect(isPromotionGatePass('passed' as PromotionGateVerdict)).toBe(false);
		expect(isPromotionGatePass('passing' as PromotionGateVerdict)).toBe(false);
	});

	it('exposes exactly one pass across the whole vocabulary', () => {
		expect(PROMOTION_GATE_VERDICTS.filter(isPromotionGatePass)).toEqual(['success']);
	});
});

describe('promotionGateVerdictFromRun', () => {
	it('reads a completed success as the pass', () => {
		expect(promotionGateVerdictFromRun({ status: 'completed', conclusion: 'success' })).toBe('success');
	});

	it.each([
		['no run at all', null, 'absent'],
		['an undefined run', undefined, 'absent']
	])('reads %s as %s', (_label, run, expected) => {
		expect(promotionGateVerdictFromRun(run as null | undefined)).toBe(expected);
	});

	it.each([
		['queued', 'queued'],
		['in_progress', 'in_progress'],
		['waiting', 'waiting'],
		['requested', 'requested'],
		['pending', 'pending']
	])('reads a run still in %s as pending, ignoring any attached conclusion', (_label, status) => {
		expect(promotionGateVerdictFromRun({ status, conclusion: 'success' })).toBe('pending');
	});

	it.each([
		['failure', 'failure'],
		['timed_out', 'failure'],
		['action_required', 'failure']
	])('reads a %s conclusion as %s', (conclusion, expected) => {
		expect(promotionGateVerdictFromRun({ status: 'completed', conclusion })).toBe(expected);
	});

	it('reads a cancelled run as cancelled, never as a pass', () => {
		// The platform's CI roll-up (`deriveCiState`) treats `cancelled` as
		// non-blocking, so a cancelled gate rolls up GREEN there. Here it is
		// the absence of a verdict.
		expect(promotionGateVerdictFromRun({ status: 'completed', conclusion: 'cancelled' })).toBe('cancelled');
		expect(isPromotionGatePass(promotionGateVerdictFromRun({ status: 'completed', conclusion: 'cancelled' }))).toBe(
			false
		);
	});

	it.each([['skipped'], ['neutral'], ['stale']])(
		'reads a %s conclusion as skipped — the reading branch protection renders green',
		(conclusion) => {
			const verdict = promotionGateVerdictFromRun({ status: 'completed', conclusion });
			expect(verdict).toBe('skipped');
			expect(isPromotionGatePass(verdict)).toBe(false);
		}
	);

	it.each([
		['a completed run with no conclusion', { status: 'completed', conclusion: null }],
		['a completed run with an empty conclusion', { status: 'completed', conclusion: '   ' }],
		['a run with neither field', {}],
		['a conclusion this platform does not know', { status: 'completed', conclusion: 'quantum' }]
	])('reads %s as unreadable rather than guessing', (_label, run) => {
		expect(promotionGateVerdictFromRun(run)).toBe('unreadable');
	});

	it('normalises provider casing and whitespace', () => {
		expect(promotionGateVerdictFromRun({ status: ' COMPLETED ', conclusion: ' Success ' })).toBe('success');
	});
});

describe('isPromotionGateDecided', () => {
	it.each([['success'], ['failure'], ['cancelled'], ['skipped']])('treats %s as decided', (verdict) => {
		expect(isPromotionGateDecided(verdict as PromotionGateVerdict)).toBe(true);
	});

	it.each([['pending'], ['absent'], ['unreadable']])('treats %s as not yet decided', (verdict) => {
		// These three are what the grace window exists for: "no run yet" ten
		// seconds after opening and "no run, ever" twenty minutes later are
		// the same reading with different meanings.
		expect(isPromotionGateDecided(verdict as PromotionGateVerdict)).toBe(false);
	});
});

describe('constants', () => {
	it('names the workflow by a bare file name, which is its stable identity', () => {
		// The INVARIANT the doc states, not a restatement of the literal: a
		// file name, never a display name, never a path. `workflowFileName()`
		// in the GitHub provider compares last path segments, so a value
		// carrying a directory would silently never match. That the file name
		// is also the name of a workflow file that really exists is pinned
		// separately, against the repository, by
		// `apps/api/src/release/promotion-gate-workflow.contract.spec.ts`.
		expect(PROMOTION_GATE_WORKFLOW_FILE).toMatch(/^[a-z0-9][a-z0-9._-]*\.ya?ml$/);
		expect(PROMOTION_GATE_WORKFLOW_FILE).not.toMatch(/[/\\]/);
	});

	it('names the override label the workflow itself reads', () => {
		// A plain label name: `contains(...labels.*.name, …)` in the workflow
		// matches it verbatim, so whitespace or casing drift is a silent
		// no-match on one side and a working override on the other.
		expect(PROMOTION_GATE_OVERRIDE_LABEL).toMatch(/^[a-z0-9][a-z0-9-]*$/);
	});
});

describe('isPromotionGateDecisionOverdue — the behaviour the grace window names', () => {
	const now = new Date('2026-09-06T12:00:00.000Z');
	const at = (msAgo: number) => new Date(now.getTime() - msAgo);

	it('is not overdue the instant the head is recorded', () => {
		expect(isPromotionGateDecisionOverdue(at(0), now)).toBe(false);
	});

	it('is not overdue one millisecond short of the window', () => {
		expect(isPromotionGateDecisionOverdue(at(PROMOTION_GATE_DECISION_GRACE_MS - 1), now)).toBe(false);
	});

	it('is overdue exactly at the window, which is where the 20-minute budget lands', () => {
		// `node-contract` has a 20-minute job budget; anything still
		// undecided at that point is stuck rather than slow.
		expect(isPromotionGateDecisionOverdue(at(PROMOTION_GATE_DECISION_GRACE_MS), now)).toBe(true);
		expect(isPromotionGateDecisionOverdue(at(20 * 60 * 1000), now)).toBe(true);
	});

	it.each([
		['null', null],
		['undefined', undefined],
		['an unparseable string', 'whenever'],
		['an invalid Date', new Date('nope')]
	])('fails closed on %s — no clock is not an elapsed interval', (_label, value) => {
		expect(isPromotionGateDecisionOverdue(value as Date | string | null | undefined, now)).toBe(false);
	});

	it('accepts an ISO string, which is what a portable date column reads back as', () => {
		expect(isPromotionGateDecisionOverdue(at(PROMOTION_GATE_DECISION_GRACE_MS + 1).toISOString(), now)).toBe(true);
	});
});

describe('isPromotionGateOverridden', () => {
	it('recognises the override label', () => {
		expect(isPromotionGateOverridden(['chore', PROMOTION_GATE_OVERRIDE_LABEL])).toBe(true);
	});

	it.each([
		['no labels', []],
		['other labels', ['release']],
		['labels the provider did not report', undefined],
		['null', null]
	])('answers false for %s — this only ever ADDS a warning', (_label, labels) => {
		expect(isPromotionGateOverridden(labels as readonly string[] | null | undefined)).toBe(false);
	});
});
