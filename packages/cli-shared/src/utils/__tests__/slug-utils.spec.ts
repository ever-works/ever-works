import { describe, it, expect } from 'vitest';
import { slugify, validateSlug, generateIncrementedSlug } from '../slug-utils.js';

describe('slugify', () => {
	it('lowercases and replaces spaces with hyphens', () => {
		expect(slugify('Hello World')).toBe('hello-world');
	});

	it('strips non-alphanumeric characters', () => {
		expect(slugify('Hello, World! 2026?')).toBe('hello-world-2026');
	});

	it('collapses consecutive whitespace and hyphens', () => {
		expect(slugify('hello   world')).toBe('hello-world');
		expect(slugify('hello---world')).toBe('hello-world');
	});

	it('trims leading and trailing hyphens', () => {
		expect(slugify('  hello  ')).toBe('hello');
		expect(slugify('-hello-')).toBe('hello');
	});

	it('returns empty string for input with only special characters', () => {
		expect(slugify('!!!')).toBe('');
	});

	it('preserves digits and existing hyphens', () => {
		expect(slugify('react-19')).toBe('react-19');
	});
});

describe('validateSlug', () => {
	it('accepts a typical valid slug', () => {
		expect(validateSlug('hello-world')).toBe(true);
		expect(validateSlug('a-b-c-2026')).toBe(true);
	});

	it('rejects slugs that are too short', () => {
		expect(validateSlug('a')).toMatch(/at least 2/);
	});

	it('rejects slugs that are too long (>50)', () => {
		expect(validateSlug('a'.repeat(51))).toMatch(/less than 50/);
	});

	it('rejects slugs with disallowed characters', () => {
		expect(validateSlug('Hello-World')).toMatch(/lowercase/);
		expect(validateSlug('hello world')).toMatch(/lowercase/);
		expect(validateSlug('hello_world')).toMatch(/lowercase/);
	});

	it('rejects slugs starting or ending with a hyphen', () => {
		expect(validateSlug('-hello')).toMatch(/start or end with a hyphen/);
		expect(validateSlug('hello-')).toMatch(/start or end with a hyphen/);
	});

	it('rejects slugs with consecutive hyphens', () => {
		expect(validateSlug('hello--world')).toMatch(/consecutive hyphens/);
	});
});

describe('generateIncrementedSlug', () => {
	it('appends -N to the base slug', () => {
		expect(generateIncrementedSlug('hello', 1)).toBe('hello-1');
		expect(generateIncrementedSlug('a-b', 42)).toBe('a-b-42');
	});
});
