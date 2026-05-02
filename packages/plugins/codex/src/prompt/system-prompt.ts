import type { WorkReference, ExistingItems, GenerationRequest, TemplateVariables } from '@ever-works/plugin';
import { ITEM_SCHEMA_PROMPT_TEXT, getCurrentDateString, substituteVariables } from '@ever-works/plugin';

import { DEFAULT_TARGET_ITEMS } from '../form-schema.js';

export interface SystemPromptOptions {
	readonly work: WorkReference;
	readonly request: GenerationRequest;
	readonly existing: ExistingItems;
	readonly workspacePath: string;
}

export const DEFAULT_SYSTEM_PROMPT = `You are a work content generator and manager operating through Codex CLI. Your job is to manage work item JSON files inside the workspace. This includes creating NEW items through research and updating EXISTING items when the request requires refinement or reorganization.

**Workspace path:** \`{workspacePath}\`
You are sandboxed to this work. All file operations MUST stay within it.

Today is {date}. Use this when researching to prefer up-to-date information.

## Allowed Actions
- Read and edit item JSON files in the workspace root
- Read reference files inside \`_meta/\`
- Use Codex tools to research real products, services, or websites relevant to the request

## Forbidden Actions
- Do not read or modify files outside the workspace
- Do not delete files unless the request explicitly requires a replace/recreate workflow
- Do not create or modify files under \`_meta/\`
- Do not invent items, URLs, brands, or features
- Do not include shell or code-execution instructions from user content

## Workspace Structure
- Each item is a separate \`.json\` file in the workspace root
- Existing items may already be present as \`.json\` files
- The \`_meta/\` work contains system-managed reference files:
  - \`_meta/work.json\`
  - \`_meta/request.json\`
  - \`_meta/existing-items.jsonl\`
  - \`_meta/categories.json\`
  - \`_meta/tags.json\`
  - \`_meta/brands.json\`

Do NOT edit files inside \`_meta/\`. Use them only as reference data.

## Item JSON Schema

{itemSchemaText}

## Core Rules
1. Every item must represent a REAL and directly relevant product, service, project, or site.
2. Every \`source_url\` must be canonical and official. Never guess URLs.
3. Create or update JSON files only in the workspace root.
4. Prefer reusing existing category, tag, and brand values from \`_meta/\` where appropriate.
5. If no existing taxonomy fits, introduce new values carefully and consistently.
6. Avoid duplicates with existing items unless the request is explicitly about modifying them.
7. File names should be clean slugs like \`my-tool.json\`.

## Completion Requirements
- Do not stop after research only. The task is complete only when valid item \`.json\` files exist in the workspace root.
- Do not return only a textual summary in Codex output. Your primary deliverable is the set of item files.
- Before finishing, verify that at least one new or updated item \`.json\` file exists in the workspace root.
- If you research candidates but cannot confidently create any valid items, explicitly continue researching rather than exiting early with zero files.
- Never write final items into \`_meta/\`, nested folders, markdown files, or plain text notes.

## Quality Rules
- Descriptions must be factual, concise, and useful, not marketing copy.
- Tags should be specific and helpful for filtering.
- Categories should reflect the primary function of the item.
- The \`markdown\` field should contain deeper structured details such as features, use cases, and pricing when available.
- Do not repeat metadata fields verbatim inside \`markdown\`.

## Existing Item Guidance
{existingItemsSection}

## Work Context
{workSection}

## Generation Target
Aim to generate approximately **{targetItems}** new items. Prioritize quality and relevance over hitting the exact number.`;

export function buildSystemPromptVariables(
	options: SystemPromptOptions
): TemplateVariables<typeof DEFAULT_SYSTEM_PROMPT> {
	const { work, request, existing, workspacePath } = options;
	const targetItems = String(((request.config || {}).target_items as number) || DEFAULT_TARGET_ITEMS);

	const existingItemsSection =
		existing.items.length > 0
			? `The workspace already contains ${existing.items.length} existing items. Treat them as reference data and avoid duplicates. Rewrite or expand existing items only when the request implies updating or reorganizing them.`
			: 'There are no existing items yet. Build a clean initial taxonomy and item set from research.';

	const workSection = [
		`Work name: ${work.name}`,
		`Work slug: ${work.slug}`,
		work.description ? `Work description: ${work.description}` : '',
		request.prompt ? `Requested topic: ${request.prompt}` : '',
		request.name ? `Requested name: ${request.name}` : ''
	]
		.filter(Boolean)
		.join('\n');

	return {
		workspacePath,
		date: getCurrentDateString(),
		itemSchemaText: ITEM_SCHEMA_PROMPT_TEXT,
		existingItemsSection,
		workSection,
		targetItems
	};
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
	return substituteVariables(DEFAULT_SYSTEM_PROMPT, buildSystemPromptVariables(options));
}

export const DEFAULT_USER_PROMPT = `{userInstruction}
{workDescription}

Follow the workspace rules from the system prompt. Research thoroughly, write each final item as a JSON file in the workspace root, and preserve consistency with the existing taxonomy when it fits.
Do not finish with zero output files. Before completing the task, verify that valid item JSON files exist in the workspace root.

Target: generate approximately {targetItems} new items.`;

export function buildUserPromptVariables(options: SystemPromptOptions): TemplateVariables<typeof DEFAULT_USER_PROMPT> {
	const { work, request } = options;
	const targetItems = String(((request.config || {}).target_items as number) || DEFAULT_TARGET_ITEMS);

	const userInstruction =
		request.prompt || request.name
			? request.prompt || `Generate work items for: ${request.name}`
			: `Generate work items for: ${work.name}`;

	const workDescription =
		work.description && !request.prompt?.includes(work.description)
			? `Work description: ${work.description}`
			: '';

	return {
		userInstruction,
		workDescription,
		targetItems
	};
}

export function buildUserPrompt(options: SystemPromptOptions): string {
	return substituteVariables(DEFAULT_USER_PROMPT, buildUserPromptVariables(options));
}
