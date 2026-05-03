import type { WorkReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import { createWorkCliPromptHelpers } from '@ever-works/plugin/cli-pipeline';
import { DEFAULT_TARGET_ITEMS } from '../form-schema.js';

export interface SystemPromptOptions {
	readonly work: WorkReference;
	readonly request: GenerationRequest;
	readonly existing: ExistingItems;
	readonly workspacePath: string;
}

const EXISTING_ITEMS_LOOKUP_INSTRUCTIONS =
	'To check for duplicates, **use `grep`** on the index — do NOT read the entire file:\n' +
	'- Search for URLs: `grep "example.com" _meta/existing-items.jsonl`\n' +
	'- Search for names: `grep -i "keyword" _meta/existing-items.jsonl`';

const promptHelpers = createWorkCliPromptHelpers<SystemPromptOptions>({
	resolveTargetItems: ({ request }) => ((request.config || {}).target_items as number) || DEFAULT_TARGET_ITEMS,
	existingItemsLookupInstructions: EXISTING_ITEMS_LOOKUP_INSTRUCTIONS
});

export const DEFAULT_SYSTEM_PROMPT = promptHelpers.DEFAULT_SYSTEM_PROMPT;
export const DEFAULT_USER_PROMPT = promptHelpers.DEFAULT_USER_PROMPT;
export const buildSystemPromptVariables = promptHelpers.buildSystemPromptVariables;
export const buildSystemPrompt = promptHelpers.buildSystemPrompt;
export const buildUserPromptVariables = promptHelpers.buildUserPromptVariables;
export const buildUserPrompt = promptHelpers.buildUserPrompt;
