import type { DirectoryReference, ExistingItems, GenerationRequest } from '@ever-works/plugin';
import { RESULT_FILE_NAME, RESULT_SCHEMA_FILE_NAME } from '../types.js';

export const DEFAULT_SYSTEM_PROMPT = [
	'You are Hermes Agent running inside an Ever Works generation workspace.',
	'Your job is to research the directory topic and produce structured item data for Ever Works.',
	'',
	'Workspace contract:',
	'- Read context from the `_meta` directory before you start.',
	'- Do not modify existing seeded item files unless explicitly required for your own scratch work.',
	`- You MUST write the final result file to \`_meta/${RESULT_FILE_NAME}\`.`,
	`- You MUST read and follow the JSON schema in \`_meta/${RESULT_SCHEMA_FILE_NAME}\`.`,
	'- The result file must contain a JSON object with an `items` array.',
	'- Each item must include: `name`, `description`, `source_url`, `category`, and `tags`.',
	'- Optional item fields may include: `website_url`, `image_url`, `brand`, `markdown`, `pricing_json`, and `extra`.',
	'- Only include items you have enough evidence to justify from your research.',
	'- Prefer high-quality, non-duplicate entries that fit the requested topic.',
	'- If you cannot find enough valid items, return fewer items rather than inventing data.',
	'',
	'Execution rules:',
	'- Use terminal commands and web research as needed.',
	'- Keep all writes inside the current workspace.',
	'- Do not start long-running background services.',
	'- When finished, ensure `_meta/hermes-result.json` contains valid JSON and then respond briefly.'
].join('\n');

export const DEFAULT_USER_PROMPT = [
	'Generate a directory dataset for Ever Works.',
	'',
	'Directory name: {{directoryName}}',
	'Directory description: {{directoryDescription}}',
	'Generation name: {{generationName}}',
	'Prompt: {{generationPrompt}}',
	'Target items: {{targetItems}}',
	'Existing items: {{existingItemsCount}}',
	'Existing categories: {{existingCategoriesCount}}',
	'Existing tags: {{existingTagsCount}}',
	'Additional notes: {{generationNotes}}'
].join('\n');

interface PromptVariablesInput {
	directory: DirectoryReference;
	request: GenerationRequest;
	existing: ExistingItems;
}

export function buildSystemPromptVariables(_input: PromptVariablesInput): Record<string, string> {
	return {};
}

export function buildUserPromptVariables(input: PromptVariablesInput): Record<string, string> {
	const config = input.request.config ?? {};

	return {
		directoryName: input.directory.name,
		directoryDescription: input.directory.description ?? 'N/A',
		generationName: input.request.name ?? 'N/A',
		generationPrompt: input.request.prompt ?? 'N/A',
		targetItems: String((config.target_items as number | undefined) ?? 50),
		existingItemsCount: String(input.existing.items.length),
		existingCategoriesCount: String(input.existing.categories.length),
		existingTagsCount: String(input.existing.tags.length),
		generationNotes:
			(typeof config.generation_notes === 'string' && config.generation_notes.trim()) ||
			'No additional notes provided.'
	};
}
