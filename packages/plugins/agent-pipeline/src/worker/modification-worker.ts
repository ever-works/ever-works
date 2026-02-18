import { generateText, stepCountIs, tool, wrapLanguageModel } from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { z } from 'zod';
import type { PluginLogger } from '@ever-works/plugin';
import { getCurrentDateString, ITEM_SCHEMA_PROMPT_TEXT } from '@ever-works/plugin';

import { createUpdateFileTool } from '../tools/file-tools.js';
import { createValidateItemJsonTool } from '../tools/validate-json-tools.js';
import { createPrepareStep } from '../utils/context-compaction.js';
import { DEFAULT_CONTEXT_BUDGET_RATIO } from '../types.js';

export interface ModificationWorkerContext {
	model: LanguageModelV3;
	maxContextTokens: number;
	workspacePath: string;
	logger: PluginLogger;
	signal?: AbortSignal;
}

export interface ModificationWorkerResult {
	modifiedFiles: string[];
	count: number;
	error?: string;
}

export async function processModification(
	instructions: string,
	ctx: ModificationWorkerContext
): Promise<ModificationWorkerResult> {
	const { model, maxContextTokens, workspacePath, logger, signal } = ctx;

	try {
		if (signal?.aborted) return { modifiedFiles: [], count: 0, error: 'Aborted' };

		const [{ createBashTool }, { Bash, ReadWriteFs }] = await Promise.all([
			import('bash-tool'),
			import('just-bash')
		]);

		const fs = new ReadWriteFs({ root: workspacePath });
		const bashInstance = new Bash({ fs });
		const { tools: bashTools } = await createBashTool({ sandbox: bashInstance, destination: '/' });

		const modifiedFiles: string[] = [];

		const sandbox = {
			readFile: (p: string) => fs.readFile(p),
			writeFiles: (files: Array<{ path: string; content: string }>) => {
				return Promise.all(files.map((f) => fs.writeFile(f.path, f.content))).then(() => undefined);
			}
		};

		const updateFileTool = createUpdateFileTool(sandbox, '/', {
			onUpdated: async (path) => {
				if (!modifiedFiles.includes(path)) modifiedFiles.push(path);
			}
		});
		const validateItemJsonTool = createValidateItemJsonTool(sandbox, '/');

		const wrappedModel = wrapLanguageModel({
			model,
			middleware: {
				specificationVersion: 'v3',
				transformParams: async ({ params }) => ({
					...params,
					prompt: params.prompt.map((msg) =>
						msg.role === 'assistant'
							? { ...msg, content: msg.content.filter((part) => part.type !== 'reasoning') }
							: msg
					)
				})
			}
		});

		await generateText({
			model: wrappedModel,
			system: buildModificationSystemPrompt(),
			prompt: instructions,
			tools: {
				bash: bashTools.bash,
				readFile: bashTools.readFile,
				updateFile: updateFileTool,
				validateItemJson: validateItemJsonTool
			} as Parameters<typeof generateText>[0]['tools'],
			stopWhen: stepCountIs(200),
			prepareStep: createPrepareStep({
				maxContextTokens,
				budgetRatio: DEFAULT_CONTEXT_BUDGET_RATIO,
				maxSingleOutputChars: Math.floor(maxContextTokens * 0.1 * 4),
				logger
			}),
			abortSignal: signal
		});

		logger.log(`Modification worker: ${modifiedFiles.length} files modified`);
		return { modifiedFiles, count: modifiedFiles.length };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn(`Modification worker failed: ${msg}`);
		return { modifiedFiles: [], count: 0, error: msg };
	}
}

function buildModificationSystemPrompt(): string {
	return [
		`You are a directory item modifier. Today is ${getCurrentDateString()}.`,
		'',
		'## Tools',
		'- `bash` — Run commands to list files, search content',
		'- `readFile` — Read a workspace file',
		'- `updateFile` — Update an existing file',
		'- `validateItemJson` — Validate and auto-repair JSON after each update',
		'- `reportProgress` — Report progress',
		'',
		`## Item JSON Schema\n\n${ITEM_SCHEMA_PROMPT_TEXT}`,
		'',
		'## Category & Tag Rules',
		'- Each item must have ONE category based on its primary function.',
		'- Use domain-specific categories (e.g., "Monitoring", "CI/CD", "Data Visualization").',
		'- Avoid duplicate or overlapping categories — merge similar ones when instructed.',
		'- Add 1-3 specific, descriptive tags per item.',
		'- When merging categories, update ALL items that reference the old category name.',
		'',
		'## Markdown Rules',
		'- Factual, no marketing language.',
		'- Use ## headings, bullet lists, tables.',
		'- Include Pricing section when applicable.',
		'',
		'## Workflow',
		'1. `ls *.json` to list items',
		'2. Read `_meta/categories.json`, `_meta/tags.json` for current taxonomy',
		'3. `readFile` to inspect items needing changes',
		'4. `updateFile` to apply modifications',
		'5. Immediately run `validateItemJson` after each `updateFile`',
		'6. If validation repaired formatting, confirm the intended semantic change still exists',
		'7. `reportProgress` to report status',
		'',
		'## Rules',
		'- Only modify as instructed',
		'- Do NOT create new items or modify `_meta/` files',
		'- Preserve unchanged fields',
		'- Ensure modified items still conform to the Item JSON Schema above'
	].join('\n');
}
