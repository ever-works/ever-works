import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MutableItemData } from '@ever-works/plugin';
import { extractKeywordsFromPrompt } from '@ever-works/plugin/keywords';

export const extractSimpleKeywords = extractKeywordsFromPrompt;

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
