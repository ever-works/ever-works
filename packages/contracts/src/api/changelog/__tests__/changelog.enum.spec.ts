import { describe, it, expect } from 'vitest';
import {
	CHANGELOG_CATEGORIES,
	CHANGELOG_KINDS,
	CHANGELOG_LIMITS,
	CHANGELOG_SLUG_PATTERN,
	isChangelogCategory,
	isChangelogKind
} from '../changelog.enum.js';

describe('CHANGELOG_CATEGORIES (spec FR-9)', () => {
	it('is the closed set of exactly six product areas', () => {
		expect([...CHANGELOG_CATEGORIES]).toEqual([
			'agents',
			'decisions',
			'knowledge',
			'connections',
			'costs',
			'platform'
		]);
	});

	it.each([...CHANGELOG_CATEGORIES])('accepts %s', (category) => {
		expect(isChangelogCategory(category)).toBe(true);
	});

	it.each(['', 'Agents', 'missions', 'all', 42, null, undefined])('rejects %p', (value) => {
		expect(isChangelogCategory(value)).toBe(false);
	});
});

describe('CHANGELOG_KINDS (spec FR-10)', () => {
	it('is the closed set of exactly four badges', () => {
		expect([...CHANGELOG_KINDS]).toEqual(['new', 'improved', 'fixed', 'security']);
	});

	it.each([...CHANGELOG_KINDS])('accepts %s', (kind) => {
		expect(isChangelogKind(kind)).toBe(true);
	});

	it.each(['', 'New', 'breaking', 0, null])('rejects %p', (value) => {
		expect(isChangelogKind(value)).toBe(false);
	});
});

describe('CHANGELOG_SLUG_PATTERN (spec FR-6)', () => {
	it.each(['abc', 'pause-every-agent', 'a1-b2', 'x'.repeat(64)])('accepts %s', (slug) => {
		expect(CHANGELOG_SLUG_PATTERN.test(slug)).toBe(true);
	});

	it.each(['ab', 'x'.repeat(65), 'Upper', 'with space', 'a/b', 'a_b', 'unread-count/..'])('rejects %s', (slug) => {
		expect(CHANGELOG_SLUG_PATTERN.test(slug)).toBe(false);
	});
});

describe('CHANGELOG_LIMITS', () => {
	it('carries the numbers the spec fixes', () => {
		expect(CHANGELOG_LIMITS).toEqual({
			titleMaxLength: 80,
			bodyMaxLength: 600,
			bodyMaxParagraphs: 3,
			ctaLabelMaxLength: 32,
			markReadBatchMax: 25,
			unreadWindow: 50,
			pageSize: 20,
			pageSizeMax: 50,
			listMax: 200
		});
	});
});
