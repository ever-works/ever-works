import { describe, it, expect } from 'vitest';
import { filterChunk } from '../worker/chunk-prefilter.js';
import type { ExistingItemEntry } from '../tools/find-items-tool.js';

function makeItem(name: string, slug?: string): ExistingItemEntry {
	return { name, slug: slug ?? name.toLowerCase().replace(/\s+/g, '-'), source_url: `https://example.com/${name}` };
}

describe('chunk-prefilter', () => {
	describe('filterChunk', () => {
		it('should return unchanged chunk when no existing items', () => {
			const text = '| [Cat Facts](https://catfact.ninja/) | Daily cat facts |';
			const result = filterChunk(text, []);
			expect(result.text).toBe(text);
			expect(result.removedCount).toBe(0);
			expect(result.remainingCount).toBe(-1);
			expect(result.skip).toBe(false);
		});

		it('should strip table rows for existing items', () => {
			const chunk = [
				'| API | Description | Auth |',
				'|---|---|---|',
				'| [Cat Facts](https://catfact.ninja/) | Daily cat facts | No |',
				'| [Dogs API](https://dog.ceo/) | Dog images | No |',
				'| [New API](https://new.api/) | Brand new API | No |'
			].join('\n');

			const existing = [makeItem('Cat Facts'), makeItem('Dogs API')];
			const result = filterChunk(chunk, existing);

			expect(result.removedCount).toBe(2);
			expect(result.remainingCount).toBe(1);
			expect(result.skip).toBe(false);
			expect(result.text).toContain('New API');
			expect(result.text).not.toContain('Cat Facts');
			expect(result.text).not.toContain('Dogs API');
			// Headers preserved
			expect(result.text).toContain('| API | Description | Auth |');
		});

		it('should skip chunk when all items are existing', () => {
			const chunk = [
				'| API | Description |',
				'|---|---|',
				'| [Cat Facts](https://catfact.ninja/) | Daily cat facts |',
				'| [Dogs API](https://dog.ceo/) | Dog images |'
			].join('\n');

			const existing = [makeItem('Cat Facts'), makeItem('Dogs API')];
			const result = filterChunk(chunk, existing);

			expect(result.removedCount).toBe(2);
			expect(result.remainingCount).toBe(0);
			expect(result.skip).toBe(true);
		});

		it('should skip names shorter than 3 characters to avoid false positives', () => {
			const chunk = '| [Go](https://go.dev/) | Go language | No |';
			const existing = [makeItem('Go')];

			const result = filterChunk(chunk, existing);
			expect(result.removedCount).toBe(0);
			expect(result.remainingCount).toBe(1);
		});

		it('should handle list-style items', () => {
			const chunk = [
				'- [Cat Facts](https://catfact.ninja/) - Daily cat facts',
				'- [Dogs API](https://dog.ceo/) - Dog images',
				'- [Brand New](https://new.api/) - Totally new'
			].join('\n');

			const existing = [makeItem('Cat Facts')];
			const result = filterChunk(chunk, existing);

			expect(result.removedCount).toBe(1);
			expect(result.remainingCount).toBe(2);
			expect(result.text).not.toContain('Cat Facts');
			expect(result.text).toContain('Dogs API');
			expect(result.text).toContain('Brand New');
		});

		it('should preserve non-item lines like headings and blank lines', () => {
			const chunk = [
				'## Animals',
				'',
				'| API | Description |',
				'|---|---|',
				'| [Cat Facts](https://catfact.ninja/) | Daily cat facts |',
				'| [New Animal](https://new.api/) | New animal API |',
				''
			].join('\n');

			const existing = [makeItem('Cat Facts')];
			const result = filterChunk(chunk, existing);

			expect(result.text).toContain('## Animals');
			expect(result.text).toContain('New Animal');
			expect(result.text).not.toContain('Cat Facts');
		});

		it('should match case-insensitively', () => {
			const chunk = '| [CAT FACTS](https://catfact.ninja/) | Daily cat facts |';
			const existing = [makeItem('cat facts')];

			const result = filterChunk(chunk, existing);
			expect(result.removedCount).toBe(1);
			expect(result.skip).toBe(true);
		});
	});
});
