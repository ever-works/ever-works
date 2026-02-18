import { describe, it, expect } from 'vitest';
import { chunkContent } from '../worker/content-chunker';

describe('chunkContent', () => {
	it('returns a single chunk when content fits', async () => {
		const content = 'Short content';
		const result = await chunkContent(content, 1000);

		expect(result.wasSplit).toBe(false);
		expect(result.chunks).toHaveLength(1);
		expect(result.chunks[0].text).toBe(content);
		expect(result.chunks[0].index).toBe(0);
		expect(result.chunks[0].total).toBe(1);
	});

	it('returns a single chunk when content equals maxChunkChars', async () => {
		const content = 'x'.repeat(500);
		const result = await chunkContent(content, 500);

		expect(result.wasSplit).toBe(false);
		expect(result.chunks).toHaveLength(1);
	});

	it('splits content into multiple chunks when too large', async () => {
		const content = Array.from({ length: 100 }, (_, i) =>
			`## Section ${i}\n\nThis is section ${i} with some content to fill space. `.repeat(5)
		).join('\n\n');

		const result = await chunkContent(content, 2000);

		expect(result.wasSplit).toBe(true);
		expect(result.chunks.length).toBeGreaterThan(1);
		expect(result.chunks[0].index).toBe(0);
		expect(result.chunks[result.chunks.length - 1].index).toBe(result.chunks.length - 1);
		expect(result.chunks[0].total).toBe(result.chunks.length);
	});

	it('preserves markdown boundary splitting', async () => {
		const content = [
			'## Section 1\n\nContent for section 1. '.repeat(50),
			'## Section 2\n\nContent for section 2. '.repeat(50),
			'## Section 3\n\nContent for section 3. '.repeat(50)
		].join('\n\n');

		const result = await chunkContent(content, 2000);

		expect(result.wasSplit).toBe(true);
		expect(result.chunks.length).toBeGreaterThanOrEqual(2);
	});

	it('handles empty content', async () => {
		const result = await chunkContent('', 1000);

		expect(result.wasSplit).toBe(false);
		expect(result.chunks).toHaveLength(1);
		expect(result.chunks[0].text).toBe('');
	});

	it('indexes chunks correctly', async () => {
		const content = 'word '.repeat(5000);
		const result = await chunkContent(content, 1000);

		expect(result.wasSplit).toBe(true);
		for (let i = 0; i < result.chunks.length; i++) {
			expect(result.chunks[i].index).toBe(i);
			expect(result.chunks[i].total).toBe(result.chunks.length);
		}
	});
});
