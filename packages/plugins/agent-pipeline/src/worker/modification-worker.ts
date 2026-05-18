import { streamText, stepCountIs, ToolSet } from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { PluginLogger, IPromptFacade, FacadeOptions, PipelineExecutionOptions } from '@ever-works/plugin';
import type { TemplateVariables } from '@ever-works/plugin';
import { getCurrentDateString, ITEM_SCHEMA_PROMPT_TEXT, substituteVariables } from '@ever-works/plugin';

import { createUpdateFileTool } from '../tools/file-tools.js';
import { createFindItemsTool } from '../tools/find-items-tool.js';
import { createValidateItemJsonTool } from '../tools/validate-json-tools.js';
import { createPrepareStep } from '../utils/context-compaction.js';
import { createToolCallRepairFn, withToolCallingRetry } from '../utils/tool-call-resilience.js';
import { DEFAULT_CONTEXT_BUDGET_RATIO, MODIFICATION_WORKER_MAX_STEPS } from '../types.js';
import type { TokenUsageAccumulator } from '../types.js';
import { PROMPT_KEYS } from '../prompt-keys.js';
import { consumeStreamWithLogging } from '../utils/stream-text-logging.js';

export interface ModificationWorkerContext {
	model: LanguageModelV3;
	maxContextTokens: number;
	workspacePath: string;
	logger: PluginLogger;
	tokenAccumulator?: TokenUsageAccumulator;
	signal?: AbortSignal;
	promptFacade?: IPromptFacade;
	facadeOptions?: FacadeOptions;
	onLogEntry?: PipelineExecutionOptions['onLogEntry'];
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

		// H-24: audit-log every bash invocation when AGENT_BASH_AUDIT_LOG is
		// set. This is JS-implemented bash (just-bash), so there's no OS
		// shell escape risk — but a prompt-injected model can still write
		// attacker-chosen content to files in the workspace, and the audit
		// log lets us reconstruct what happened after the fact. Logger
		// stream is intentional: we want the log line in the existing
		// structured logging so it ends up in CloudWatch / Loki / Sentry
		// breadcrumbs alongside every other agent action.
		const auditEnabled = process.env.AGENT_BASH_AUDIT_LOG === 'true';
		if (auditEnabled && bashTools.bash && typeof bashTools.bash === 'object') {
			const original = (bashTools.bash as { execute?: (...a: unknown[]) => unknown }).execute;
			if (typeof original === 'function') {
				(bashTools.bash as { execute: (...a: unknown[]) => unknown }).execute = (...args: unknown[]) => {
					try {
						const arg0 = args[0];
						const summary =
							arg0 && typeof arg0 === 'object'
								? JSON.stringify(arg0).slice(0, 4096)
								: String(arg0).slice(0, 4096);
						logger?.log(`[bash-audit] workspace=${workspacePath} args=${summary}`);
					} catch {
						/* never let audit logging break the call */
					}
					return (original as (...a: unknown[]) => unknown).apply(bashTools.bash, args);
				};
			}
		}

		const sandbox = {
			readFile: (p: string) => fs.readFile(p),
			writeFiles: (files: Array<{ path: string; content: string }>) => {
				return Promise.all(files.map((f) => fs.writeFile(f.path, f.content))).then(() => undefined);
			}
		};

		const modifiedFiles: string[] = [];

		const updateFileTool = createUpdateFileTool(sandbox, '/', {
			onUpdated: async (path) => {
				if (!modifiedFiles.includes(path)) {
					modifiedFiles.push(path);
				}
			}
		});
		const validateItemJsonTool = createValidateItemJsonTool(sandbox, '/');

		const repairToolCall = createToolCallRepairFn(model, logger);

		const sysTemplate = (
			ctx.promptFacade && ctx.facadeOptions
				? await ctx.promptFacade.getPrompt(
						PROMPT_KEYS.MODIFICATION_SYSTEM,
						DEFAULT_MODIFICATION_SYSTEM_PROMPT,
						ctx.facadeOptions
					)
				: DEFAULT_MODIFICATION_SYSTEM_PROMPT
		) as typeof DEFAULT_MODIFICATION_SYSTEM_PROMPT;
		const systemPrompt = substituteVariables(sysTemplate, buildModificationSystemPromptVariables());

		const result = await withToolCallingRetry(
			async () => {
				const result = streamText({
					model,
					system: systemPrompt,
					prompt: instructions,
					tools: {
						bash: bashTools.bash,
						readFile: bashTools.readFile,
						findItems: createFindItemsTool(workspacePath),
						updateFile: updateFileTool,
						validateItemJson: validateItemJsonTool
					} as ToolSet,
					stopWhen: stepCountIs(MODIFICATION_WORKER_MAX_STEPS),
					prepareStep: createPrepareStep({
						maxContextTokens,
						budgetRatio: DEFAULT_CONTEXT_BUDGET_RATIO,
						maxSingleOutputChars: Math.floor(maxContextTokens * 0.1 * 4),
						logger
					}),
					abortSignal: signal,
					experimental_repairToolCall: repairToolCall,
					experimental_telemetry: { isEnabled: true }
				});

				await consumeStreamWithLogging(result, {
					onLogEntry: ctx.onLogEntry,
					scope: 'Modification worker',
					stepIndex: 1,
					source: 'pipeline'
				});
				return result;
			},
			{ providerName: 'worker', modelName: 'modification-worker', signal, logger }
		);
		ctx.tokenAccumulator?.addWorker(await result.totalUsage);

		logger.log(`Modification worker: ${modifiedFiles.length} files modified`);
		return { modifiedFiles, count: modifiedFiles.length };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn(`Modification worker failed: ${msg}`);
		return { modifiedFiles: [], count: 0, error: msg };
	}
}

/**
 * Default template for the modification worker system prompt.
 * Variables: {date}, {itemSchemaText}
 */
export const DEFAULT_MODIFICATION_SYSTEM_PROMPT = `You are a work item modifier. Today is {date}.

## Tools
- \`bash\` — Run targeted search commands to find items. NEVER \`ls *.json\` — workspaces can have thousands of files.
- \`readFile\` — Read a workspace file
- \`findItems\` — Fuzzy-search items by name, slug, or URL. Returns up to 5 best matches.
- \`updateFile\` — Update an existing file
- \`validateItemJson\` — Validate and auto-repair JSON after each update

## Item JSON Schema

{itemSchemaText}

## Category & Tag Rules
- Each item must have ONE category based on its primary function.
- Use domain-specific categories (e.g., "Monitoring", "CI/CD", "Data Visualization").
- Avoid duplicate or overlapping categories — merge similar ones when instructed.
- Add 1-3 specific, descriptive tags per item.
- When merging categories, update ALL items that reference the old category name.

## Markdown Rules
The \`markdown\` field is for detailed product/service information only:
- Factual, no marketing language.
- Use ## headings, bullet lists, tables.
- Include Pricing section when applicable.
- Do NOT repeat metadata already in other JSON fields (category, tags, brand, source_url).

## Workflow
1. Read \`_meta/categories.json\`, \`_meta/tags.json\` for current taxonomy.
2. Use \`findItems(name)\` to check if the target item exists and get its slug (slug = filename, e.g. slug "gauzy" → file "gauzy.json").
   For broader content-based searches (e.g., all items in a category), use: \`grep -rli "keyword" --include="*.json" .\`
3. \`readFile\` to inspect matched items.
4. \`updateFile\` to apply modifications.
5. Run \`validateItemJson\` after each \`updateFile\`.
6. If validation repaired formatting, verify the intended change is still present.

## Rules
- Only modify as instructed
- Do NOT create new items or modify \`_meta/\` files
- Preserve unchanged fields
- Ensure modified items still conform to the Item JSON Schema above`;

/**
 * Build variables for the modification system prompt template.
 */
export function buildModificationSystemPromptVariables(): TemplateVariables<typeof DEFAULT_MODIFICATION_SYSTEM_PROMPT> {
	return {
		date: getCurrentDateString(),
		itemSchemaText: ITEM_SCHEMA_PROMPT_TEXT
	};
}

/**
 * Build the system prompt for the modification worker.
 * Backward-compatible wrapper.
 */
export function buildModificationSystemPrompt(): string {
	return substituteVariables(DEFAULT_MODIFICATION_SYSTEM_PROMPT, buildModificationSystemPromptVariables());
}
