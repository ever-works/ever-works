import { describe, expect, it } from 'vitest';

import {
	CONTEXT_FILE_LOAD_MODES,
	CONTEXT_FILE_REVISION_KEEP,
	CONTEXT_FILE_REVISION_KEEP_DAYS,
	MAX_ALWAYS_LOADED_WORKSPACE_FILES,
	MEMORY_FACT_ACTIVE_MAX,
	MEMORY_FACT_BODY_MAX,
	MEMORY_FACT_FORGET_ALL_CONFIRMATION,
	MEMORY_FACT_FORGET_RETENTION_DAYS,
	MEMORY_FACT_ORIGINS,
	MEMORY_FACT_PINNED_MAX,
	MEMORY_FACT_PROPOSED_MAX,
	MEMORY_FACT_RECALL_MAX_TOKENS,
	MEMORY_FACT_RECALL_MIN_SCORE,
	MEMORY_FACT_RECALL_TOP_K,
	MEMORY_FACT_SCOPES,
	MEMORY_FACT_SEARCH_MIN_SCORE,
	MEMORY_FACT_SEARCH_TOP_K,
	MEMORY_FACT_STATUSES,
	WORKSPACE_CONTEXT_FILE_DEFAULT_LOAD_MODES,
	WORKSPACE_CONTEXT_FILE_SLUGS,
	contextSegmentState,
	cosineToNormalizedScore,
	isMemoryFactScope,
	isMemoryFactStatus,
	isWorkspaceContextFileSlug,
	normalizedScoreToCosine
} from '../index.js';

describe('memory fact limits', () => {
	it('pins every limit the API, the composer and the chat tool share', () => {
		expect(MEMORY_FACT_BODY_MAX).toBe(500);
		expect(MEMORY_FACT_ACTIVE_MAX).toBe(2000);
		expect(MEMORY_FACT_PROPOSED_MAX).toBe(200);
		expect(MEMORY_FACT_PINNED_MAX).toBe(20);
		expect(MEMORY_FACT_RECALL_TOP_K).toBe(8);
		expect(MEMORY_FACT_RECALL_MIN_SCORE).toBe(0.72);
		expect(MEMORY_FACT_SEARCH_TOP_K).toBe(50);
		expect(MEMORY_FACT_SEARCH_MIN_SCORE).toBe(0.55);
		expect(MEMORY_FACT_RECALL_MAX_TOKENS).toBe(1200);
		expect(MEMORY_FACT_FORGET_RETENTION_DAYS).toBe(30);
		expect(MEMORY_FACT_FORGET_ALL_CONFIRMATION).toBe('FORGET ALL');
	});

	it('pins the persisted literals — they are stored in rows', () => {
		expect([...MEMORY_FACT_STATUSES]).toEqual(['proposed', 'active', 'forgotten']);
		expect([...MEMORY_FACT_ORIGINS]).toEqual(['user', 'agent', 'consolidation', 'import']);
		expect([...MEMORY_FACT_SCOPES]).toEqual(['workspace', 'agent']);
	});

	it('narrows statuses and scopes and rejects everything else', () => {
		expect(isMemoryFactStatus('active')).toBe(true);
		expect(isMemoryFactStatus('deleted')).toBe(false);
		expect(isMemoryFactStatus(undefined)).toBe(false);
		expect(isMemoryFactScope('agent')).toBe(true);
		expect(isMemoryFactScope('team')).toBe(false);
		expect(isMemoryFactScope(42)).toBe(false);
	});
});

describe('cosine ↔ normalized score', () => {
	it('maps cosine onto the vector-store normalized scale', () => {
		expect(cosineToNormalizedScore(1)).toBe(1);
		expect(cosineToNormalizedScore(-1)).toBe(0);
		expect(cosineToNormalizedScore(0)).toBe(0.5);
		expect(cosineToNormalizedScore(0.55)).toBeCloseTo(0.775, 10);
	});

	it('clamps out-of-range and non-finite input instead of breaking the [0, 1] invariant', () => {
		expect(cosineToNormalizedScore(3)).toBe(1);
		expect(cosineToNormalizedScore(-3)).toBe(0);
		expect(cosineToNormalizedScore(Number.NaN)).toBe(0);
	});

	it('round-trips for display and clamps negatives to zero', () => {
		expect(normalizedScoreToCosine(cosineToNormalizedScore(0.72))).toBeCloseTo(0.72, 10);
		expect(normalizedScoreToCosine(0.25)).toBe(0);
		expect(normalizedScoreToCosine(Number.POSITIVE_INFINITY)).toBe(0);
	});
});

describe('context file vocabulary', () => {
	it('is the fixed set of six files with the documented defaults', () => {
		expect([...WORKSPACE_CONTEXT_FILE_SLUGS]).toEqual([
			'about-you',
			'organization',
			'people',
			'glossary',
			'voice',
			'roster'
		]);
		expect([...CONTEXT_FILE_LOAD_MODES]).toEqual(['always', 'onDemand']);
		const always = WORKSPACE_CONTEXT_FILE_SLUGS.filter(
			(slug) => WORKSPACE_CONTEXT_FILE_DEFAULT_LOAD_MODES[slug] === 'always'
		);
		expect(always).toEqual(['about-you', 'voice']);
		expect(always.length).toBeLessThanOrEqual(MAX_ALWAYS_LOADED_WORKSPACE_FILES);
		expect(CONTEXT_FILE_REVISION_KEEP).toBe(20);
		expect(CONTEXT_FILE_REVISION_KEEP_DAYS).toBe(30);
	});

	it('narrows slugs', () => {
		expect(isWorkspaceContextFileSlug('voice')).toBe(true);
		expect(isWorkspaceContextFileSlug('secrets')).toBe(false);
	});
});

describe('contextSegmentState', () => {
	it('classifies the three states at their boundaries', () => {
		expect(contextSegmentState(899, 1000)).toBe('under');
		expect(contextSegmentState(900, 1000)).toBe('near');
		expect(contextSegmentState(1000, 1000)).toBe('near');
		expect(contextSegmentState(1001, 1000)).toBe('over');
	});

	it('treats a zero budget as over only when something was used', () => {
		expect(contextSegmentState(0, 0)).toBe('under');
		expect(contextSegmentState(1, 0)).toBe('over');
	});
});
