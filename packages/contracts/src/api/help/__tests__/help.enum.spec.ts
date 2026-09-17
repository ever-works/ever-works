import { describe, it, expect } from 'vitest';
import {
	HELP_ARTICLE_ID_PATTERN,
	HELP_BLOCK_KINDS,
	HELP_LIMITS,
	HELP_LINK_TARGET_TYPES,
	HELP_NOTE_TONES,
	HELP_SECTIONS,
	isHelpArticleId,
	isHelpSection
} from '../help.enum.js';

describe('HELP_SECTIONS (spec FR-4)', () => {
	it('is the closed set of exactly six sections, in reading order', () => {
		expect([...HELP_SECTIONS]).toEqual([
			'start-here',
			'running-the-loop',
			'your-agents',
			'setup-and-connections',
			'money-and-limits',
			'when-something-goes-wrong'
		]);
	});

	it.each([...HELP_SECTIONS])('accepts %s', (section) => {
		expect(isHelpSection(section)).toBe(true);
	});

	it.each(['', 'Start-here', 'getting-started', 7, null, undefined])('rejects %p', (value) => {
		expect(isHelpSection(value)).toBe(false);
	});
});

describe('article grammar vocabularies (spec FR-27, FR-27a)', () => {
	it('closes the block kinds, link target types and callout tones', () => {
		expect([...HELP_BLOCK_KINDS]).toEqual([
			'paragraph',
			'heading',
			'orderedList',
			'unorderedList',
			'note',
			'shortcut',
			'code',
			'link',
			'table'
		]);
		expect([...HELP_LINK_TARGET_TYPES]).toEqual(['article', 'screen', 'external']);
		expect([...HELP_NOTE_TONES]).toEqual(['note', 'tip', 'info', 'warning', 'danger']);
	});
});

describe('article identifiers (spec FR-3)', () => {
	it.each(['missions', 'job-runtimes', 'a1b', 'x'.repeat(64)])('accepts %s', (id) => {
		expect(isHelpArticleId(id)).toBe(true);
		expect(HELP_ARTICLE_ID_PATTERN.test(id)).toBe(true);
	});

	it.each(['ab', 'x'.repeat(65), 'Missions', 'job_runtimes', '../etc', 'a b', 42, null])('rejects %p', (id) => {
		expect(isHelpArticleId(id)).toBe(false);
	});

	it('keeps the published limits', () => {
		expect(HELP_LIMITS.maxArticles).toBe(200);
		expect(HELP_LIMITS.titleChars).toBe(70);
		expect(HELP_LIMITS.summaryChars).toBe(200);
		expect(HELP_LIMITS.maxRelated).toBe(5);
	});
});
