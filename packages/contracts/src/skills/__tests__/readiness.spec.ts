import { describe, expect, it } from 'vitest';
import {
	SKILL_CAPTURE_BODY_MAX_CHARS,
	SKILL_CAPTURE_BODY_MIN_CHARS,
	SKILL_CAPTURE_BUDGET_MS,
	SKILL_CARD_STATES,
	SKILL_CARD_STATES_NEEDING_ATTENTION,
	SKILL_PROVENANCES,
	SKILL_READINESS_AGENTS_MAX,
	SKILL_READINESS_FILTERS,
	SKILL_READINESS_LIST_RECHECK_MAX,
	SKILL_READINESS_REQUIREMENTS_MAX,
	SKILL_READINESS_RUN_SUPPRESSION_TTL_MS,
	SKILL_READINESS_STATES,
	SKILL_READINESS_SWEEP_BATCH,
	SKILL_READINESS_SWEEP_CRON,
	SKILL_READINESS_SWEEP_PER_USER,
	SKILL_READINESS_TTL_MS,
	SKILL_SHELF_SORTS,
	SKILL_TAG_CHIPS_SHOWN,
	SKILL_TAG_FACET_LIMIT,
	SKILL_TAG_FILTER_MAX,
	SKILL_TAG_MAX_LENGTH,
	SKILL_TAG_PATTERN,
	SKILL_TAGS_PER_SKILL_MAX,
	countSkillsNeedingAttention,
	deriveSkillCardState,
	isSkillCardState,
	isSkillReadinessState,
	normalizeSkillTag,
	normalizeSkillTags,
	skillCardStateNeedsAttention
} from '../readiness.js';

describe('skill readiness unions', () => {
	it('pins the stored verdict set — adding a state must be a deliberate edit', () => {
		expect([...SKILL_READINESS_STATES]).toEqual([
			'ready',
			'needs_setup',
			'missing_requirements',
			'blocked_by_access',
			'unknown',
			'check_failed'
		]);
	});

	it('pins the card state set as the verdicts plus the two switches', () => {
		expect([...SKILL_CARD_STATES]).toEqual([
			'ready',
			'needs_setup',
			'missing_requirements',
			'blocked_by_access',
			'unknown',
			'check_failed',
			'disabled',
			'needs_review'
		]);
		expect([...SKILL_READINESS_FILTERS]).toEqual([...SKILL_CARD_STATES, 'attention']);
	});

	it('pins provenance and sort vocabularies', () => {
		expect([...SKILL_PROVENANCES]).toEqual(['firstParty', 'plugin', 'package', 'authored']);
		expect([...SKILL_SHELF_SORTS]).toEqual(['updated', 'name', 'attention']);
	});

	it('pins every numeric limit', () => {
		expect(SKILL_TAG_MAX_LENGTH).toBe(40);
		expect(SKILL_TAGS_PER_SKILL_MAX).toBe(12);
		expect(SKILL_TAG_FACET_LIMIT).toBe(200);
		expect(SKILL_TAG_CHIPS_SHOWN).toBe(12);
		expect(SKILL_TAG_FILTER_MAX).toBe(6);
		expect(SKILL_READINESS_TTL_MS).toBe(3_600_000);
		expect(SKILL_READINESS_SWEEP_BATCH).toBe(500);
		expect(SKILL_READINESS_SWEEP_PER_USER).toBe(200);
		expect(SKILL_READINESS_REQUIREMENTS_MAX).toBe(20);
		expect(SKILL_READINESS_AGENTS_MAX).toBe(10);
		expect(SKILL_READINESS_RUN_SUPPRESSION_TTL_MS).toBe(86_400_000);
		expect(SKILL_READINESS_LIST_RECHECK_MAX).toBe(5);
		expect(SKILL_CAPTURE_BODY_MAX_CHARS).toBe(16_000);
		expect(SKILL_CAPTURE_BODY_MIN_CHARS).toBe(200);
		expect(SKILL_CAPTURE_BUDGET_MS).toBe(90_000);
	});

	it('pins the sweep cron every scheduler shares', () => {
		expect(SKILL_READINESS_SWEEP_CRON).toBe('17 * * * *');
	});

	it('type guards accept only members', () => {
		expect(isSkillReadinessState('ready')).toBe(true);
		expect(isSkillReadinessState('check_failed')).toBe(true);
		expect(isSkillReadinessState('disabled')).toBe(false);
		expect(isSkillReadinessState(undefined)).toBe(false);
		expect(isSkillCardState('needs_review')).toBe(true);
		expect(isSkillCardState('attention')).toBe(false);
	});
});

describe('deriveSkillCardState', () => {
	const verdicts = [...SKILL_READINESS_STATES];

	it.each(verdicts)('disabled wins over the stored verdict %s and over review', (readiness) => {
		expect(deriveSkillCardState({ readiness, disabledAt: new Date(), reviewState: 'proposed' })).toBe('disabled');
	});

	it.each(verdicts)('needs_review wins over the stored verdict %s', (readiness) => {
		expect(deriveSkillCardState({ readiness, reviewState: 'proposed' })).toBe('needs_review');
	});

	it.each(verdicts)('with neither switch the stored verdict %s shows through', (readiness) => {
		expect(deriveSkillCardState({ readiness, disabledAt: null, reviewState: null })).toBe(readiness);
	});

	it('never reports ready for an unrecognised or missing verdict', () => {
		expect(deriveSkillCardState({ readiness: 'bogus' })).toBe('unknown');
		expect(deriveSkillCardState({})).toBe('unknown');
	});

	it('keeps a check that failed apart from one that never ran', () => {
		expect(deriveSkillCardState({ readiness: 'check_failed' })).toBe('check_failed');
		expect(deriveSkillCardState({ readiness: 'unknown' })).toBe('unknown');
	});

	it('accepts an ISO string for disabledAt', () => {
		expect(deriveSkillCardState({ readiness: 'ready', disabledAt: '2026-09-01T00:00:00.000Z' })).toBe('disabled');
	});

	it('only ready and not-checked-yet ask nothing of a person', () => {
		for (const state of SKILL_CARD_STATES) {
			expect(skillCardStateNeedsAttention(state)).toBe(state !== 'ready' && state !== 'unknown');
		}
		expect([...SKILL_CARD_STATES_NEEDING_ATTENTION]).toEqual([
			'needs_setup',
			'missing_requirements',
			'blocked_by_access',
			'check_failed',
			'disabled',
			'needs_review'
		]);
	});
});

describe('countSkillsNeedingAttention', () => {
	const zero = Object.fromEntries(SKILL_CARD_STATES.map((state) => [state, 0])) as Record<
		(typeof SKILL_CARD_STATES)[number],
		number
	>;

	it('a shelf of Skills nothing has checked yet needs nobody', () => {
		expect(countSkillsNeedingAttention({ ...zero, unknown: 34 })).toBe(0);
	});

	it('counts real problems, never ready or not-checked-yet', () => {
		expect(
			countSkillsNeedingAttention({
				...zero,
				ready: 20,
				unknown: 9,
				needs_setup: 1,
				missing_requirements: 2,
				blocked_by_access: 3,
				check_failed: 4,
				disabled: 5,
				needs_review: 6
			})
		).toBe(21);
	});

	it('treats a missing bucket or missing counts as zero', () => {
		expect(countSkillsNeedingAttention({ check_failed: 2 })).toBe(2);
		expect(countSkillsNeedingAttention(null)).toBe(0);
		expect(countSkillsNeedingAttention(undefined)).toBe(0);
	});
});

describe('normalizeSkillTags', () => {
	it.each([
		['  Billing ', 'billing'],
		['Customer Success', 'customer-success'],
		['a   b\tc', 'a-b-c'],
		['go/to/market!', 'gotomarket'],
		['--edge--', 'edge'],
		['a--b', 'a-b'],
		['ÉTÉ', 't'],
		['x'.repeat(50), 'x'.repeat(40)]
	])('normalises %p to %p', (raw, expected) => {
		expect(normalizeSkillTag(raw)).toBe(expected);
		expect(SKILL_TAG_PATTERN.test(expected)).toBe(true);
	});

	it('clamps before trimming a trailing hyphen', () => {
		const tag = normalizeSkillTag(`${'a'.repeat(39)} b`);
		expect(tag).toBe('a'.repeat(39));
	});

	it('drops empties and non-strings', () => {
		expect(normalizeSkillTag('   ')).toBeNull();
		expect(normalizeSkillTag('!!!')).toBeNull();
		expect(normalizeSkillTag(42)).toBeNull();
		expect(normalizeSkillTags(['', null, 7, 'ok'])).toEqual({ tags: ['ok'], dropped: [] });
	});

	it('dedupes after normalising, first occurrence wins', () => {
		expect(normalizeSkillTags(['Email', 'email', ' EMAIL ', 'sales'])).toEqual({
			tags: ['email', 'sales'],
			dropped: []
		});
	});

	it('keeps 12 and reports the rest as dropped', () => {
		const raw = Array.from({ length: 15 }, (_, i) => `tag-${i}`);
		const { tags, dropped } = normalizeSkillTags(raw);
		expect(tags).toHaveLength(12);
		expect(dropped).toEqual(['tag-12', 'tag-13', 'tag-14']);
	});

	it('honours a smaller cap', () => {
		expect(normalizeSkillTags(['a', 'b', 'c'], 2)).toEqual({ tags: ['a', 'b'], dropped: ['c'] });
	});

	it('returns nothing for a non-array', () => {
		expect(normalizeSkillTags('billing')).toEqual({ tags: [], dropped: [] });
		expect(normalizeSkillTags(undefined)).toEqual({ tags: [], dropped: [] });
	});
});
