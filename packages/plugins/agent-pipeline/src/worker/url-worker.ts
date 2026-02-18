import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateText, stepCountIs } from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { IContentExtractorFacade, FacadeOptions, PluginLogger } from '@ever-works/plugin';

import { chunkContent } from './content-chunker.js';
import { buildWorkerSystemPrompt, buildChunkUserPrompt } from './extraction-prompt.js';
import type { WorkerPromptOptions } from './extraction-prompt.js';
import { createCreateFileTool, createUpdateFileTool } from '../tools/file-tools.js';
import { createValidateItemJsonTool } from '../tools/validate-json-tools.js';
import { createPrepareStep } from '../utils/context-compaction.js';
import { wrapReasoningFilteredModel } from '../utils/model-wrapper.js';
import { createToolCallRepairFn, withToolCallingRetry } from '../utils/tool-call-resilience.js';
import {
	getWorkerContentBudgetRatio,
	WORKER_PROMPT_OVERHEAD_TOKENS,
	MIN_CHUNK_CHARS,
	DEFAULT_CONTEXT_BUDGET_RATIO
} from '../types.js';

export interface UrlWorkerContext {
	workerModel: LanguageModelV3;
	maxContextTokens: number;
	contentExtractorFacade: IContentExtractorFacade;
	facadeOptions: FacadeOptions;
	directoryContext: WorkerPromptOptions;
	workspacePath: string;
	logger: PluginLogger;
	signal?: AbortSignal;
}

export interface UrlWorkerResult {
	url: string;
	files: string[];
	count: number;
	error?: string;
}

export async function processUrlWorker(url: string, ctx: UrlWorkerContext): Promise<UrlWorkerResult> {
	const {
		workerModel,
		maxContextTokens,
		contentExtractorFacade,
		facadeOptions,
		directoryContext,
		workspacePath,
		logger,
		signal
	} = ctx;

	try {
		if (signal?.aborted) return { url, files: [], count: 0, error: 'Aborted' };

		const extracted = await contentExtractorFacade.extractContent(url, undefined, facadeOptions);
		if (!extracted?.rawContent) {
			return { url, files: [], count: 0, error: 'Failed to extract content from URL' };
		}

		logger.log(`Worker: extracted ${extracted.rawContent.length} chars from ${url}`);

		const contentRatio = getWorkerContentBudgetRatio(maxContextTokens);
		// Calculate max chars for content chunk based on context budget,
		// accounting for prompt overhead and leaving room for tools and reasoning.
		const maxChunkChars = Math.max(
			Math.floor((maxContextTokens * contentRatio - WORKER_PROMPT_OVERHEAD_TOKENS) * 4),
			MIN_CHUNK_CHARS
		);

		const { chunks, wasSplit } = await chunkContent(extracted.rawContent, maxChunkChars);
		if (wasSplit) {
			logger.log(`Worker: split into ${chunks.length} chunks`);
		}

		// Set up sandbox for tool-based agent
		const [{ createBashTool }, { Bash, ReadWriteFs }] = await Promise.all([
			import('bash-tool'),
			import('just-bash')
		]);

		const sandboxFs = new ReadWriteFs({ root: workspacePath });
		const bashInstance = new Bash({ fs: sandboxFs });
		const { tools: bashTools } = await createBashTool({ sandbox: bashInstance, destination: '/' });

		// Track created files across all chunks
		const createdFiles: string[] = [];

		const sandbox = {
			readFile: (p: string) => sandboxFs.readFile(p),
			writeFiles: (files: Array<{ path: string; content: string }>) => {
				return Promise.all(files.map((f) => sandboxFs.writeFile(f.path, f.content))).then(() => undefined);
			}
		};

		const createFileTool = createCreateFileTool(sandbox, '/', {
			onCreated: async (path, content) => {
				createdFiles.push(path);

				// Append to existing-items index for cross-worker dedup
				try {
					const parsed = JSON.parse(content);
					await appendFile(
						join(workspacePath, '_meta', 'existing-items.jsonl'),
						JSON.stringify({ slug: parsed.slug, name: parsed.name, source_url: parsed.source_url }) + '\n',
						'utf-8'
					);
				} catch {
					/* best-effort */
				}
			}
		});

		const updateFileTool = createUpdateFileTool(sandbox, '/');

		const validateItemJsonTool = createValidateItemJsonTool(sandbox, '/');

		// const wrappedModel = wrapReasoningFilteredModel(workerModel);

		const systemPrompt = buildWorkerSystemPrompt(directoryContext);
		const repairToolCall = createToolCallRepairFn(workerModel, logger);

		for (const chunk of chunks) {
			if (signal?.aborted) break;
			try {
				await withToolCallingRetry(
					() => {
						return generateText({
							model: workerModel,
							system: systemPrompt,
							timeout: 5 * 60 * 1000, // 5 min per chunk
							prompt: buildChunkUserPrompt(
								chunk,
								url,
								createdFiles.length > 0 ? createdFiles : undefined
							),
							tools: {
								bash: bashTools.bash,
								readFile: bashTools.readFile,
								createFile: createFileTool,
								updateFile: updateFileTool,
								validateItemJson: validateItemJsonTool
							} as Parameters<typeof generateText>[0]['tools'],
							stopWhen: stepCountIs(100),
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
					},
					{ providerName: 'worker', modelName: 'url-worker', signal, logger }
				);
			} catch (err) {
				logger.warn(
					`Worker: chunk ${chunk.index + 1}/${chunk.total} failed: ${err instanceof Error ? err.message : err}`
				);
			}
		}

		if (createdFiles.length === 0) {
			return { url, files: [], count: 0, error: 'No items extracted' };
		}

		logger.log(`Worker: created ${createdFiles.length} items from ${url}`);
		return { url, files: createdFiles, count: createdFiles.length };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn(`Worker: failed to process ${url}: ${msg}`);
		return { url, files: [], count: 0, error: msg };
	}
}
