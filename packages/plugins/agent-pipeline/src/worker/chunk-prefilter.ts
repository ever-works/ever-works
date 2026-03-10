import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExistingItemEntry } from '../tools/find-items-tool.js';

export interface FilteredChunk {
	text: string;
	removedCount: number;
	/** -1 when filtering was not applied (no existing items) */
	remainingCount: number;
	skip: boolean;
}

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
 * Strip lines matching existing items from chunk text.
 * Non-item lines (headings, separators) are preserved for context.
 * If all item lines are removed, the chunk is marked for skipping.
 */
export function filterChunk(chunkText: string, existingItems: ExistingItemEntry[]): FilteredChunk {
	if (existingItems.length === 0) {
		return { text: chunkText, removedCount: 0, remainingCount: -1, skip: false };
	}

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

		const isItemLine =
			(trimmed.startsWith('|') && trimmed.includes('[') && !trimmed.includes('---')) ||
			/^[-*]\s+\[/.test(trimmed);

		if (!isItemLine) {
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
