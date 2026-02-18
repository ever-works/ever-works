import { ITEM_SCHEMA_PROMPT_TEXT, getCurrentDateString } from '@ever-works/plugin';
import type { ContentChunk } from './content-chunker.js';

export interface WorkerPromptOptions {
	directoryName: string;
	directoryDescription?: string;
	requestPrompt?: string;
}

export function buildWorkerSystemPrompt(opts: WorkerPromptOptions): string {
	const sections: string[] = [
		`You are an expert content extractor for a directory of items. Today is ${getCurrentDateString()}.`,
		`\n## Item JSON Schema\n\n${ITEM_SCHEMA_PROMPT_TEXT}`,
		'\n## Workspace Structure\n' +
			'The workspace contains item JSON files at the root and a `_meta/` directory with system-managed files:\n' +
			'- `_meta/categories.json` — current categories array\n' +
			'- `_meta/tags.json` — current tags array\n' +
			'- `_meta/brands.json` — current brands array\n' +
			'- `_meta/existing-items.jsonl` — index of existing items (one JSON object per line with slug, name, source_url)\n' +
			'- `_meta/directory.json` — directory metadata\n' +
			'- `_meta/request.json` — generation request details\n' +
			'Note: `_meta/` files are auto-updated when you create items. Do NOT modify them directly.',
		'\n## Tools\n' +
			'- `bash` — Run targeted search commands. NEVER run `ls *.json` — workspaces can have thousands of files.\n' +
			'- `readFile` — Read workspace files (e.g., `_meta/categories.json`, `_meta/existing-items.jsonl`)\n' +
			'- `createFile` — Create a new item JSON file (auto-syncs taxonomy)\n' +
			'- `updateFile` — Update an existing file\n' +
			'- `validateItemJson` — Validate and auto-repair a JSON file after creation',
		'\n## Workflow\n' +
			'1. Read `_meta/categories.json` to learn existing categories — prefer reusing them.\n' +
			'2. Before creating each item, check `_meta/existing-items.jsonl` for duplicates using case-insensitive partial matching:\n' +
			'   - `grep -i "keyword" _meta/existing-items.jsonl`\n' +
			'   - Try multiple variations (partial name, domain, abbreviation) to catch fuzzy matches.\n' +
			'3. Create items using `createFile` with valid JSON matching the Item JSON Schema above.\n' +
			'4. Validate each created file with `validateItemJson`.',
		'\n## Extraction Rules\n' +
			'1. Only extract items DIRECTLY relevant to the directory topic.\n' +
			'2. Every item must have a valid source_url.\n' +
			'3. Extract factual information only — no fabrication.\n' +
			'4. If the page describes a single item, extract it with comprehensive detail.\n' +
			'5. If the page lists multiple items, extract each relevant one separately.\n' +
			'6. Ignore blog posts or marketing content unless they describe a specific item.\n' +
			'7. Set featured=false unless the item is widely recognized.',
		'\n## Category & Tag Rules\n' +
			'- ONE category per item based on primary function.\n' +
			'- Use domain-specific categories.\n' +
			'- Add 1-3 specific, descriptive tags.',
		'\n## Markdown Rules\n' +
			'- Factual, no marketing language.\n' +
			'- Include ALL features comprehensively.\n' +
			'- Include Pricing section when applicable.\n' +
			'- Use ## headings, bullet lists, tables.',
		`\n## Directory\n${opts.directoryName}` +
			(opts.directoryDescription ? `\n${opts.directoryDescription}` : '') +
			(opts.requestPrompt ? `\nRequest: ${opts.requestPrompt}` : '')
	];

	return sections.join('\n');
}

export function buildChunkUserPrompt(chunk: ContentChunk, sourceUrl: string, previouslyExtracted?: string[]): string {
	const parts = [`Extract directory items from this page.\nSource URL: ${sourceUrl}`];

	if (chunk.total > 1) {
		parts.push(`\n(Chunk ${chunk.index + 1} of ${chunk.total})`);
	}

	if (previouslyExtracted?.length) {
		parts.push(`\nAlready extracted (skip these): ${previouslyExtracted.join(', ')}`);
	}

	parts.push(`\n---\n${chunk.text}`);
	return parts.join('\n');
}
