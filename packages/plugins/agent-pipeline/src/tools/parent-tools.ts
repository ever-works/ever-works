import { tool } from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { z } from 'zod';
import type {
	ISearchFacade,
	IContentExtractorFacade,
	IPromptFacade,
	FacadeOptions,
	PipelineProgressCallback,
	PipelineExecutionOptions,
	PluginLogger
} from '@ever-works/plugin';

import { createSearchTool, createReportProgressTool } from './facade-tools.js';
import type { FacadeToolOptions } from './facade-tools.js';
import { readWorkspaceOverview } from './workspace-overview.js';
import { createFindItemsTool } from './find-items-tool.js';
import { processUrlWorker } from '../worker/url-worker.js';
import type { WorkerPromptOptions } from '../worker/extraction-prompt.js';
import { processModification } from '../worker/modification-worker.js';
import { ToolCircuitBreaker } from '../utils/tool-circuit-breaker.js';
import type { TokenUsageAccumulator } from '../types.js';

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
	tokenAccumulator?: TokenUsageAccumulator;
	signal?: AbortSignal;
	promptFacade?: IPromptFacade;
	onLogEntry?: PipelineExecutionOptions['onLogEntry'];
}

export interface ParentToolsResult {
	readonly tools: Record<string, unknown>;
	readonly breaker: ToolCircuitBreaker;
}

export function createParentTools(ctx: ParentToolContext): ParentToolsResult {
	const breaker = new ToolCircuitBreaker({ logger: ctx.logger });
	const toolOptions: FacadeToolOptions = { breaker, logger: ctx.logger };

	const processUrlTool = tool({
		description:
			'Process one URL: extract content, create items, and return the result so the parent agent can decide what to do next.',
		inputSchema: z.object({
			url: z.string().url()
		}),
		execute: async ({ url }) => {
			const workerCtx = {
				workerModel: ctx.workerModel,
				maxContextTokens: ctx.workerMaxContextTokens,
				contentExtractorFacade: ctx.facades.contentExtractorFacade,
				facadeOptions: ctx.facadeOptions,
				directoryContext: ctx.directoryContext,
				workspacePath: ctx.workspacePath,
				breaker,
				logger: ctx.logger,
				tokenAccumulator: ctx.tokenAccumulator,
				signal: ctx.signal,
				promptFacade: ctx.promptFacade,
				onLogEntry: ctx.onLogEntry
			};

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
				tokenAccumulator: ctx.tokenAccumulator,
				signal: ctx.signal,
				promptFacade: ctx.promptFacade,
				facadeOptions: ctx.facadeOptions,
				onLogEntry: ctx.onLogEntry
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
			findItems: createFindItemsTool(ctx.workspacePath),
			processUrl: processUrlTool,
			modifyItems: modifyItemsTool,
			getWorkspaceOverview: getWorkspaceOverviewTool,
			reportProgress: createReportProgressTool(ctx.onProgress, 1, ctx.totalSteps)
		},
		breaker
	};
}
