import type { DirectoryReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import { ITEM_SCHEMA_TEXT } from './item-schema.js';

export interface SystemPromptOptions {
	readonly directory: DirectoryReference;
	readonly request: GenerationRequest;
	readonly existing: ExistingItems;
}

/**
 * Build the system prompt appended to Claude Code's built-in system prompt.
 * Uses --append-system-prompt to preserve Claude Code's tool capabilities.
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
	const { directory, existing } = options;
	const existingCount = existing.items.length;
	const hasExisting = existingCount > 0;

	const sections: string[] = [];

	// Role
	sections.push(
		'You are a directory content generator. Your job is to research and create high-quality ' +
			'directory entries as individual JSON files in the current workspace.'
	);

	// Workspace structure
	sections.push(
		'\n## Workspace Structure\n' +
			'- Each item is a separate `.json` file in the workspace root (e.g., `my-item.json`)\n' +
			'- The `_meta/` subdirectory contains metadata:\n' +
			'  - `_meta/categories.json` - Array of category objects `[{ "id": "...", "name": "..." }]`\n' +
			'  - `_meta/tags.json` - Array of tag objects `[{ "id": "...", "name": "..." }]`\n' +
			'  - `_meta/brands.json` - Array of brand objects `[{ "id": "...", "name": "..." }]`\n' +
			'  - `_meta/directory.json` - Directory metadata (read-only)\n' +
			'  - `_meta/request.json` - Generation request (read-only)'
	);

	// Item schema
	sections.push(`\n## Item JSON Schema\n\n${ITEM_SCHEMA_TEXT}`);

	// Rules
	sections.push(
		'\n## Rules\n' +
			'1. Only create entries for REAL items that actually exist. Never invent fictitious items.\n' +
			"2. Every `source_url` must be a valid, working URL to the item's official page.\n" +
			'3. Use web search to verify items and find accurate information.\n' +
			'4. Use consistent category names across all items.\n' +
			'5. Write each item as a separate JSON file in the workspace root (not to stdout).\n' +
			'6. File names should be URL-friendly slugs (e.g., `my-awesome-tool.json`).\n' +
			'7. After creating all items, update `_meta/categories.json`, `_meta/tags.json`, ' +
			'and `_meta/brands.json` with all unique values used.'
	);

	// Dedup instructions when existing items are present
	if (hasExisting) {
		sections.push(
			`\n## Existing Items (${existingCount} items)\n` +
				'The workspace already contains JSON files for existing items. ' +
				'READ these files first to understand what already exists.\n' +
				'- Do NOT create duplicates of existing items.\n' +
				'- You may update existing item files if you find better/newer information.\n' +
				'- Focus on creating NEW items that complement the existing collection.'
		);
	}

	// Directory context
	if (directory.description) {
		sections.push(
			`\n## Directory Context\n` + `Directory: ${directory.name}\n` + `Description: ${directory.description}`
		);
	}

	return sections.join('\n');
}

/**
 * Build the user prompt passed as the -p argument.
 * This is the main instruction telling Claude Code what to generate.
 */
export function buildUserPrompt(options: SystemPromptOptions): string {
	const { directory, request, existing } = options;
	const parts: string[] = [];

	if (request.prompt) {
		parts.push(request.prompt);
	} else if (request.name) {
		parts.push(`Generate directory items for: ${request.name}`);
	} else {
		parts.push(`Generate directory items for: ${directory.name}`);
	}

	if (directory.description && !request.prompt?.includes(directory.description)) {
		parts.push(`\nDirectory description: ${directory.description}`);
	}

	if (existing.items.length > 0) {
		parts.push(
			`\nThere are ${existing.items.length} existing items in the workspace. ` +
				'Read them first, then add new complementary items.'
		);
	}

	parts.push(
		'\nResearch the topic thoroughly using web search, then create item JSON files ' +
			'in the workspace. Update the _meta/ files when done.'
	);

	return parts.join('\n');
}
