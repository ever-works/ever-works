import type { DirectoryReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import { createDirectoryCliPromptHelpers } from '@ever-works/plugin/cli-pipeline';
import { DEFAULT_TARGET_ITEMS } from '../form-schema.js';

export interface SystemPromptOptions {
	readonly directory: DirectoryReference;
	readonly request: GenerationRequest;
	readonly existing: ExistingItems;
	readonly workspacePath: string;
}

const EXISTING_ITEMS_LOOKUP_INSTRUCTIONS =
	'To check for duplicates, use the built-in search tools on the index instead of reading the entire file.\n' +
	'- Search for URLs by domain or exact URL fragments in `_meta/existing-items.jsonl`\n' +
	'- Search for names with case-insensitive matching in `_meta/existing-items.jsonl`';

const promptHelpers = createDirectoryCliPromptHelpers<SystemPromptOptions>({
	resolveTargetItems: ({ request }) => ((request.config || {}).target_items as number) || DEFAULT_TARGET_ITEMS,
	existingItemsLookupInstructions: EXISTING_ITEMS_LOOKUP_INSTRUCTIONS
});

export const DEFAULT_SYSTEM_PROMPT = promptHelpers.DEFAULT_SYSTEM_PROMPT;
export const DEFAULT_USER_PROMPT = promptHelpers.DEFAULT_USER_PROMPT;
export const buildSystemPromptVariables = promptHelpers.buildSystemPromptVariables;
export const buildSystemPrompt = promptHelpers.buildSystemPrompt;
export const buildUserPromptVariables = promptHelpers.buildUserPromptVariables;
export const buildUserPrompt = promptHelpers.buildUserPrompt;
