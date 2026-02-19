import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import Fuse from 'fuse.js';

export interface ExistingItemEntry {
	slug: string;
	name: string;
	source_url: string;
}

export function createFindItemsTool(workspacePath: string) {
	return tool({
		description:
			'Fuzzy-search existing workspace items by name, slug, or source URL. ' +
			'Returns up to 5 best matches. Use to check if an item exists before creating or modifying it.',
		inputSchema: z.object({
			query: z.string().describe('Item name, slug fragment, or domain to search for')
		}),
		execute: async ({ query }) => {
			const metaPath = join(workspacePath, '_meta', 'existing-items.jsonl');
			try {
				const content = await readFile(metaPath, 'utf-8');
				const items: ExistingItemEntry[] = content
					.split('\n')
					.filter(Boolean)
					.flatMap((line) => {
						try {
							return [JSON.parse(line) as ExistingItemEntry];
						} catch {
							return [];
						}
					});

				if (items.length === 0) {
					return { found: false, matches: [] };
				}

				const fuse = new Fuse(items, {
					keys: [
						{ name: 'name', weight: 0.7 },
						{ name: 'slug', weight: 0.2 },
						{ name: 'source_url', weight: 0.1 }
					],
					threshold: 0.4,
					includeScore: false
				});

				const matches = fuse
					.search(query, { limit: 5 })
					.map(({ item }) => ({ slug: item.slug, name: item.name, source_url: item.source_url }));

				return { found: matches.length > 0, matches };
			} catch {
				return { found: false, matches: [] };
			}
		}
	});
}
