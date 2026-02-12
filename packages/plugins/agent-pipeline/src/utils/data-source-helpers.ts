import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MutableItemData } from '@ever-works/plugin';

const STOP_WORDS = new Set([
	'the',
	'and',
	'for',
	'are',
	'but',
	'not',
	'you',
	'all',
	'can',
	'had',
	'was',
	'one',
	'our',
	'out',
	'get',
	'has',
	'how',
	'its',
	'may',
	'new',
	'now',
	'see',
	'two',
	'who',
	'did',
	'way',
	'she',
	'use',
	'your',
	'said',
	'what',
	'with',
	'have',
	'from',
	'they',
	'know',
	'been',
	'some',
	'will',
	'when',
	'just',
	'like',
	'than',
	'them',
	'well',
	'were',
	'this',
	'that',
	'about',
	'into',
	'also',
	'more',
	'most',
	'over',
	'such',
	'very',
	'each',
	'make',
	'much',
	'time',
	'come',
	'here',
	'long',
	'many',
	'good',
	'want'
]);

/**
 * Simple keyword extraction — splits on whitespace, filters stop words.
 * No AI call needed; saves tokens.
 */
export function extractSimpleKeywords(prompt?: string, subject?: string): string[] {
	const keywords: string[] = [];

	if (subject) {
		keywords.push(subject.toLowerCase());
	}

	if (prompt) {
		const words = prompt
			.toLowerCase()
			.replace(/[^\w\s]/g, ' ')
			.split(/\s+/)
			.filter((w) => w.length > 2 && !STOP_WORDS.has(w));
		keywords.push(...words.slice(0, 15));
	}

	return [...new Set(keywords)];
}

/**
 * Appends data-source items to the JSONL index so the agent avoids recreating them.
 */
export async function appendToJsonlIndex(workspacePath: string, items: MutableItemData[]): Promise<void> {
	if (items.length === 0) return;

	const indexPath = join(workspacePath, '_meta', 'existing-items.jsonl');

	let existing = '';
	try {
		existing = await readFile(indexPath, 'utf-8');
	} catch {
		// File may not exist yet
	}

	const newLines = items
		.map((item) => JSON.stringify({ slug: item.slug, name: item.name, source_url: item.source_url }))
		.join('\n');

	const content = existing
		? (existing.endsWith('\n') ? existing : existing + '\n') + newLines + '\n'
		: newLines + '\n';

	await writeFile(indexPath, content, 'utf-8');
}
