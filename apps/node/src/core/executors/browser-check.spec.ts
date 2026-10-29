import { describe, expect, it } from 'vitest';
import { extractTitle } from './browser-check';

describe('extractTitle', () => {
	it('reads the first title, case-insensitively and with attributes, whitespace collapsed', () => {
		expect(extractTitle('<html><head><TITLE lang="en">\n  My   App </TITLE></head>')).toBe('My App');
		expect(extractTitle('<title>One</title><title>Two</title>')).toBe('One');
	});

	it('answers null when there is no title, an empty one, or no closer', () => {
		expect(extractTitle('<html><body>no title</body></html>')).toBeNull();
		expect(extractTitle('<title>   </title>')).toBeNull();
		expect(extractTitle('<title>never closed')).toBeNull();
	});

	it('caps a long title at 200 characters', () => {
		expect(extractTitle(`<title>${'x'.repeat(500)}</title>`)).toHaveLength(200);
	});

	it('stays linear on a page of unclosed openers (CodeQL js/polynomial-redos)', () => {
		const started = Date.now();
		expect(extractTitle('<title'.repeat(50_000))).toBeNull();
		expect(extractTitle('<title>'.repeat(50_000))).toBeNull();
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
