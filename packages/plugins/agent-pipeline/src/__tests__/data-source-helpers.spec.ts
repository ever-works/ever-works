import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractSimpleKeywords, appendToJsonlIndex } from '../utils/data-source-helpers';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MutableItemData } from '@ever-works/plugin';

const item = (overrides: Partial<MutableItemData> = {}): MutableItemData =>
	({
		name: 'Test',
		slug: 'test',
		description: 'Test item',
		source_url: 'https://example.com',
		category: 'tools',
		tags: [],
		...overrides
	}) as MutableItemData;

describe('extractSimpleKeywords', () => {
	it('extracts keywords from prompt', () => {
		const result = extractSimpleKeywords('Find the best vector databases for AI');
		expect(result).toContain('vector');
		expect(result).toContain('databases');
	});

	it('includes subject', () => {
		const result = extractSimpleKeywords('Find tools', 'AI Code Editors');
		expect(result).toContain('ai code editors');
	});

	it('filters stop words', () => {
		const result = extractSimpleKeywords('the best and most popular tools');
		expect(result).not.toContain('the');
		expect(result).not.toContain('and');
		expect(result).not.toContain('most');
	});

	it('returns empty for no input', () => {
		expect(extractSimpleKeywords()).toEqual([]);
	});

	it('deduplicates keywords', () => {
		const result = extractSimpleKeywords('vector vector databases');
		const vectorCount = result.filter((k) => k === 'vector').length;
		expect(vectorCount).toBe(1);
	});

	it('limits keyword count', () => {
		const longPrompt = Array.from({ length: 50 }, (_, i) => `keyword${i}`).join(' ');
		const result = extractSimpleKeywords(longPrompt);
		expect(result.length).toBeLessThanOrEqual(15);
	});
});

describe('appendToJsonlIndex', () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = join(tmpdir(), `ds-helper-test-${Date.now()}`);
		await mkdir(join(testDir, '_meta'), { recursive: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it('creates index file when it does not exist', async () => {
		const items = [item({ slug: 'cursor', name: 'Cursor', source_url: 'https://cursor.sh' })];
		await appendToJsonlIndex(testDir, items);

		const content = await readFile(join(testDir, '_meta', 'existing-items.jsonl'), 'utf-8');
		const lines = content.trim().split('\n');
		expect(lines).toHaveLength(1);

		const parsed = JSON.parse(lines[0]);
		expect(parsed.slug).toBe('cursor');
		expect(parsed.name).toBe('Cursor');
		expect(parsed.source_url).toBe('https://cursor.sh');
	});

	it('appends to existing index', async () => {
		const existingLine = JSON.stringify({ slug: 'existing', name: 'Existing', source_url: 'https://existing.com' });
		await writeFile(join(testDir, '_meta', 'existing-items.jsonl'), existingLine + '\n', 'utf-8');

		await appendToJsonlIndex(testDir, [item({ slug: 'new-item', name: 'New', source_url: 'https://new.com' })]);

		const content = await readFile(join(testDir, '_meta', 'existing-items.jsonl'), 'utf-8');
		const lines = content.trim().split('\n');
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).slug).toBe('existing');
		expect(JSON.parse(lines[1]).slug).toBe('new-item');
	});

	it('does nothing for empty items', async () => {
		await appendToJsonlIndex(testDir, []);

		try {
			await readFile(join(testDir, '_meta', 'existing-items.jsonl'), 'utf-8');
			expect.fail('File should not exist');
		} catch {
			// Expected - file should not exist
		}
	});
});
