import { describe, it, expect } from 'vitest';
import { extractKeywords, extractKeywordsFromPrompt } from './keyword-utils.js';

describe('extractKeywords', () => {
	it('extracts keywords from English text', () => {
		const result = extractKeywords('The best vector databases for AI applications');
		expect(result.length).toBeGreaterThan(0);
		expect(result).toContain('vector');
		expect(result).toContain('databases');
		expect(result).not.toContain('the');
		expect(result).not.toContain('for');
	});

	it('removes common stopwords across languages', () => {
		const result = extractKeywords('the and for with about this that from');
		expect(result).toEqual([]);
	});

	it('handles empty input', () => {
		expect(extractKeywords('')).toEqual([]);
	});

	it('respects maxKeywords option', () => {
		const text = 'React Angular Vue Svelte Solid Qwik Preact Inferno Mithril Ember Backbone Polymer';
		const result = extractKeywords(text, { maxKeywords: 5 });
		expect(result.length).toBeLessThanOrEqual(5);
	});

	it('respects minWordLength option', () => {
		const result = extractKeywords('AI is a key tool', { minWordLength: 3 });
		expect(result).not.toContain('ai');
	});

	it('deduplicates results', () => {
		const result = extractKeywords('database database database tool tool');
		const unique = new Set(result);
		expect(result.length).toBe(unique.size);
	});

	it('handles CJK text via Intl.Segmenter', () => {
		const result = extractKeywords('機械学習ツール');
		expect(result.length).toBeGreaterThan(0);
	});

	it('handles mixed language text', () => {
		const result = extractKeywords('Best Kubernetes tools outil de gestion');
		expect(result.length).toBeGreaterThan(0);
		expect(result).toContain('kubernetes');
	});

	it('handles French text', () => {
		const result = extractKeywords('Les meilleurs outils de base de données');
		expect(result).not.toContain('les');
		expect(result).not.toContain('de');
	});

	it('handles German text', () => {
		const result = extractKeywords('Die besten Werkzeuge für Datenbanken');
		expect(result).not.toContain('die');
		expect(result).not.toContain('für');
	});

	it('handles Spanish text', () => {
		const result = extractKeywords('Las mejores herramientas para bases de datos');
		expect(result).not.toContain('las');
		expect(result).not.toContain('para');
	});

	it('handles text with punctuation', () => {
		const result = extractKeywords('Next.js, React, and Vue.js — the best frameworks!');
		expect(result.length).toBeGreaterThan(0);
	});
});

describe('extractKeywordsFromPrompt', () => {
	it('includes subject as first keyword', () => {
		const result = extractKeywordsFromPrompt('Find tools for development', 'AI Tools');
		expect(result[0]).toBe('ai tools');
	});

	it('extracts from prompt when no subject', () => {
		const result = extractKeywordsFromPrompt('Find vector database tools');
		expect(result.length).toBeGreaterThan(0);
		expect(result).toContain('vector');
	});

	it('returns empty for no input', () => {
		expect(extractKeywordsFromPrompt()).toEqual([]);
	});

	it('handles subject only', () => {
		const result = extractKeywordsFromPrompt(undefined, 'Machine Learning');
		expect(result).toContain('machine learning');
	});

	it('respects maxKeywords', () => {
		const longPrompt = Array.from({ length: 50 }, (_, i) => `keyword${i}`).join(' ');
		const result = extractKeywordsFromPrompt(longPrompt, 'subject', 5);
		expect(result.length).toBeLessThanOrEqual(5);
	});

	it('deduplicates between subject and prompt', () => {
		const result = extractKeywordsFromPrompt('Find vector databases', 'vector databases');
		const unique = new Set(result);
		expect(result.length).toBe(unique.size);
	});
});
