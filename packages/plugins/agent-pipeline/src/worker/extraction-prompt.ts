import { ITEM_SCHEMA_PROMPT_TEXT, getCurrentDateString, substituteVariables } from '@ever-works/plugin';
import type { ContentChunk } from './content-chunker.js';

export interface WorkerPromptOptions {
	directoryName: string;
	directoryDescription?: string;
	requestPrompt?: string;
}

// ── Worker System Prompt ──────────────────────────────────────────────

/**
 * Default template for the content extraction worker system prompt.
 * Variables: {date}, {itemSchemaText}, {directoryName}, {directoryDescription}, {requestPrompt}
 */
export const DEFAULT_WORKER_SYSTEM_PROMPT = `You are an expert content extractor for a directory of items. Today is {date}.

## Item JSON Schema

{itemSchemaText}

## Workspace Structure
The workspace contains item JSON files at the root and a \`_meta/\` directory with system-managed files:
- \`_meta/categories.json\` — current categories array
- \`_meta/tags.json\` — current tags array
- \`_meta/brands.json\` — current brands array
- \`_meta/existing-items.jsonl\` — index of existing items (one JSON object per line with slug, name, source_url)
- \`_meta/directory.json\` — directory metadata
- \`_meta/request.json\` — generation request details
Note: \`_meta/\` files are auto-updated when you create items. Do NOT modify them directly.

## Tools
- \`bash\` — Run targeted search commands. NEVER run \`ls *.json\` — workspaces can have thousands of files.
- \`readFile\` — Read workspace files (e.g., \`_meta/categories.json\`, \`_meta/existing-items.jsonl\`)
- \`findItems\` — Fuzzy-search existing items by name, slug, or URL (up to 5 matches)
- \`createFile\` — Create a new item JSON file (auto-syncs taxonomy)
- \`updateFile\` — Update a file **you created in this session only**. Do NOT use this to modify pre-existing items.
- \`validateItemJson\` — Validate and auto-repair a JSON file after creation

## Workflow
1. Read \`_meta/categories.json\` to learn existing categories — prefer reusing them.
2. Before creating each item, use \`findItems(name)\` to check for duplicates. Skip if a match is found.
3. Create items using \`createFile\` with valid JSON matching the Item JSON Schema above.
4. Validate each created file with \`validateItemJson\`.
5. You may use \`updateFile\` to correct or enrich a file you just created in this session, but never to modify pre-existing items.

## Extraction Rules
1. Only extract items DIRECTLY relevant to the directory topic.
2. Every item must have a valid source_url.
3. Extract factual information only — no fabrication.
4. If the page describes a single item, extract it with comprehensive detail.
5. If the page lists multiple items, extract each relevant one separately.
6. Ignore blog posts or marketing content unless they describe a specific item.
7. Set featured=false unless the item is widely recognized.

## Category & Tag Rules
- ONE category per item based on primary function.
- Use domain-specific categories.
- Add 1-3 specific, descriptive tags.

## Markdown Rules
- Factual, no marketing language.
- Include ALL features comprehensively.
- Include Pricing section when applicable.
- Use ## headings, bullet lists, tables.

## Directory
{directoryName}{directoryDescription}{requestPrompt}`;

/**
 * Build variables for the worker system prompt template.
 */
export function buildWorkerSystemPromptVariables(opts: WorkerPromptOptions): Record<string, string> {
	return {
		date: getCurrentDateString(),
		itemSchemaText: ITEM_SCHEMA_PROMPT_TEXT,
		directoryName: opts.directoryName,
		directoryDescription: opts.directoryDescription ? `\n${opts.directoryDescription}` : '',
		requestPrompt: opts.requestPrompt ? `\nRequest: ${opts.requestPrompt}` : ''
	};
}

/**
 * Build the system prompt for content extraction workers.
 * Backward-compatible wrapper.
 */
export function buildWorkerSystemPrompt(opts: WorkerPromptOptions): string {
	return substituteVariables(DEFAULT_WORKER_SYSTEM_PROMPT, buildWorkerSystemPromptVariables(opts));
}

// ── Chunk User Prompt ─────────────────────────────────────────────────

/**
 * Default template for the per-chunk extraction user prompt.
 * Variables: {sourceUrl}, {chunkInfo}, {previouslyExtractedList}, {chunkText}
 */
export const DEFAULT_CHUNK_USER_PROMPT = `Extract directory items from this page.
Source URL: {sourceUrl}{chunkInfo}{previouslyExtractedList}

---
{chunkText}`;

/**
 * Build variables for the chunk user prompt template.
 */
export function buildChunkUserPromptVariables(
	chunk: ContentChunk,
	sourceUrl: string,
	previouslyExtracted?: string[]
): Record<string, string> {
	return {
		sourceUrl,
		chunkInfo: chunk.total > 1 ? `\n(Chunk ${chunk.index + 1} of ${chunk.total})` : '',
		previouslyExtractedList: previouslyExtracted?.length
			? `\nAlready extracted (skip these): ${previouslyExtracted.join(', ')}`
			: '',
		chunkText: chunk.text
	};
}

/**
 * Build the user prompt for a single content chunk.
 * Backward-compatible wrapper.
 */
export function buildChunkUserPrompt(chunk: ContentChunk, sourceUrl: string, previouslyExtracted?: string[]): string {
	return substituteVariables(
		DEFAULT_CHUNK_USER_PROMPT,
		buildChunkUserPromptVariables(chunk, sourceUrl, previouslyExtracted)
	);
}
