import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExistingItemEntry } from '../tools/find-items-tool.js';

export interface FilteredChunk {
	/** The chunk text with existing item lines removed */
	text: string;
	/** Number of lines/items removed */
	removedCount: number;
	/** Number of item lines remaining */
	remainingCount: number;
	/** Whether the entire chunk should be skipped (nothing left) */
	skip: boolean;
}

/**
 * Load existing item entries from the workspace's existing-items.jsonl file.
 * Returns an empty array if the file doesn't exist or is empty.
 */
export async function loadExistingItems(workspacePath: string): Promise<ExistingItemEntry[]> {
	const metaPath = join(workspacePath, '_meta', 'existing-items.jsonl');
	try {
		const content = await readFile(metaPath, 'utf-8');
		return content
			.split('\n')
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as ExistingItemEntry];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

/**
 * Remove lines from a chunk that correspond to items already in the directory.
 *
 * Strategy: build a Set of lowercase existing item names, then check each
 * "item line" (table row with a link, or list item with a link) against
 * the set. Lines that match an existing item are removed.
 *
 * Non-item lines (headings, table headers, separators, blank lines) are
 * preserved to maintain context for the AI.
 *
 * If ALL item lines are removed, the chunk is marked for skipping entirely.
 */
export function filterChunk(chunkText: string, existingItems: ExistingItemEntry[]): FilteredChunk {
	if (existingItems.length === 0) {
		return { text: chunkText, removedCount: 0, remainingCount: 0, skip: false };
	}

	// Build a lookup set of lowercase existing names (only names >= 3 chars)
	const existingNames = new Set<string>();
	for (const item of existingItems) {
		if (item.name && item.name.length >= 3) {
			existingNames.add(item.name.toLowerCase());
		}
	}

	const lines = chunkText.split('\n');
	const kept: string[] = [];
	let removedCount = 0;
	let totalItemLines = 0;

	for (const line of lines) {
		const trimmed = line.trim();

		// Detect item lines: table rows with links, or list items with links
		const isItemLine =
			(trimmed.startsWith('|') && trimmed.includes('[') && !trimmed.includes('---')) ||
			/^[-*]\s+\[/.test(trimmed);

		if (!isItemLine) {
			// Keep non-item lines (headings, separators, blank lines, etc.)
			kept.push(line);
			continue;
		}

		totalItemLines++;

		// Extract the link text: [Name](url) → Name
		const linkMatch = trimmed.match(/\[([^\]]+)\]/);
		const itemName = linkMatch ? linkMatch[1].toLowerCase() : null;

		if (itemName && existingNames.has(itemName)) {
			removedCount++;
		} else {
			kept.push(line);
		}
	}

	const remainingCount = totalItemLines - removedCount;
	const skip = totalItemLines > 0 && remainingCount === 0;

	return {
		text: skip ? '' : kept.join('\n'),
		removedCount,
		remainingCount,
		skip
	};
}
