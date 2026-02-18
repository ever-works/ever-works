import { tool } from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { z } from 'zod';
import type {
	ISearchFacade,
	IContentExtractorFacade,
	FacadeOptions,
	PipelineProgressCallback,
	PluginLogger
} from '@ever-works/plugin';

import { createSearchTool, createReportProgressTool } from './facade-tools.js';
import type { FacadeToolOptions } from './facade-tools.js';
import { readWorkspaceOverview } from './workspace-overview.js';
import { processUrlWorker } from '../worker/url-worker.js';
import type { WorkerPromptOptions } from '../worker/extraction-prompt.js';
import { processModification } from '../worker/modification-worker.js';
import { ToolCircuitBreaker } from '../utils/tool-circuit-breaker.js';
import { MAX_URLS_PER_BATCH } from '../types.js';

export interface ParentToolContext {
	workspacePath: string;
	facades: {
		searchFacade: ISearchFacade;
		contentExtractorFacade: IContentExtractorFacade;
	};
	facadeOptions: FacadeOptions;
	workerModel: LanguageModelV3;
	workerMaxContextTokens: number;
	parentModel: LanguageModelV3;
	parentMaxContextTokens: number;
	directoryContext: WorkerPromptOptions;
	onProgress: PipelineProgressCallback | undefined;
	totalSteps: number;
	logger: PluginLogger;
	signal?: AbortSignal;
}

export interface ParentToolsResult {
	readonly tools: Record<string, unknown>;
	readonly breaker: ToolCircuitBreaker;
}

export function createParentTools(ctx: ParentToolContext): ParentToolsResult {
	const breaker = new ToolCircuitBreaker({ logger: ctx.logger });
	const toolOptions: FacadeToolOptions = { breaker, logger: ctx.logger };

	const processUrlsTool = tool({
		description: 'Process 1-10 URLs in parallel: extract content, create items, with best-effort deduplication.',
		inputSchema: z.object({
			urls: z.array(z.string().url()).min(1).max(MAX_URLS_PER_BATCH)
		}),
		// Cross-URL dedup within a batch is best-effort (parallel workers share no state);
		// duplicates are caught by the post-pipeline metadata merge.
		execute: async ({ urls }) => {
			const workerCtx = {
				workerModel: ctx.workerModel,
				maxContextTokens: ctx.workerMaxContextTokens,
				contentExtractorFacade: ctx.facades.contentExtractorFacade,
				facadeOptions: ctx.facadeOptions,
				directoryContext: ctx.directoryContext,
				workspacePath: ctx.workspacePath,
				logger: ctx.logger,
				signal: ctx.signal
			};

			const mapper = async (url: string) => {
				try {
					return await processUrlWorker(url, workerCtx);
				} catch (error) {
					return {
						url,
						files: [],
						count: 0,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			};

			const pMap = (await import('p-map')).default;

			return pMap(urls, mapper, { concurrency: 2 });
		}
	});

	const modifyItemsTool = tool({
		description: 'Modify existing items: reorganize, merge categories, update fields.',
		inputSchema: z.object({
			instructions: z.string()
		}),
		execute: ({ instructions }) => {
			return processModification(instructions, {
				model: ctx.parentModel,
				maxContextTokens: ctx.parentMaxContextTokens,
				workspacePath: ctx.workspacePath,
				logger: ctx.logger,
				signal: ctx.signal
			});
		}
	});

	const getWorkspaceOverviewTool = tool({
		description: 'Get workspace overview: item count, categories, tags, brands.',
		inputSchema: z.object({}),
		execute: () => readWorkspaceOverview(ctx.workspacePath)
	});

	return {
		tools: {
			search: createSearchTool(ctx.facades.searchFacade, ctx.facadeOptions, toolOptions),
			processUrls: processUrlsTool,
			modifyItems: modifyItemsTool,
			getWorkspaceOverview: getWorkspaceOverviewTool,
			reportProgress: createReportProgressTool(ctx.onProgress, 1, ctx.totalSteps)
		},
		breaker
	};
}
