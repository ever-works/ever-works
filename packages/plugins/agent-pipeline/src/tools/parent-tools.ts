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
	PluginLogger,
	ExistingItems
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
	workContext: WorkerPromptOptions;
	existing: ExistingItems;
	onProgress: PipelineProgressCallback | undefined;
	totalSteps: number;
	logger: PluginLogger;
	maxPagesToProcess: number;
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
	const processedUrls = new Map<string, { status: 'created' | 'empty' | 'error'; count: number }>();

	const normalizeTrackedUrl = (raw: string): string => {
		const trimmed = raw.trim();
		if (!trimmed) {
			return trimmed;
		}

		try {
			const parsed = new URL(trimmed);
			const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
			const searchParams = [...parsed.searchParams.entries()]
				.filter(([key]) => !key.toLowerCase().startsWith('utm_'))
				.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
					if (leftKey === rightKey) {
						return leftValue.localeCompare(rightValue);
					}
					return leftKey.localeCompare(rightKey);
				});
			const search = new URLSearchParams(searchParams).toString();

			return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}${search ? `?${search}` : ''}`;
		} catch {
			return trimmed.toLowerCase().replace(/\/+$/, '');
		}
	};

	const classifyProcessedUrlStatus = (result: { count: number; error?: string }): 'created' | 'empty' | 'error' => {
		if (result.count > 0) {
			return 'created';
		}

		const errorMessage = result.error?.toLowerCase() || '';
		if (
			errorMessage.includes('no items extracted') ||
			errorMessage.includes('empty content') ||
			errorMessage.includes('returned empty content')
		) {
			return 'empty';
		}

		return result.error ? 'error' : 'empty';
	};

	const processUrlTool = tool({
		description:
			'Process one URL: extract content, create items, and return the result so the parent agent can decide what to do next.',
		inputSchema: z.object({
			url: z.string().url()
		}),
		execute: async ({ url }) => {
			const normalizedUrl = normalizeTrackedUrl(url);
			const existingRecord = processedUrls.get(normalizedUrl);
			if (existingRecord) {
				return {
					url,
					files: [],
					count: 0,
					skipped: true,
					error: `URL already processed earlier (${existingRecord.status}). Do not retry it.`,
					previousStatus: existingRecord.status,
					previousCount: existingRecord.count,
					remainingUrlBudget: Math.max(0, ctx.maxPagesToProcess - processedUrls.size)
				};
			}

			if (processedUrls.size >= ctx.maxPagesToProcess) {
				return {
					url,
					files: [],
					count: 0,
					skipped: true,
					error:
						`URL budget reached (${ctx.maxPagesToProcess}/${ctx.maxPagesToProcess}). ` +
						'Stop processing URLs and finish with the current results.',
					remainingUrlBudget: 0
				};
			}

			const workerCtx = {
				workerModel: ctx.workerModel,
				maxContextTokens: ctx.workerMaxContextTokens,
				contentExtractorFacade: ctx.facades.contentExtractorFacade,
				facadeOptions: ctx.facadeOptions,
				workContext: ctx.workContext,
				workspacePath: ctx.workspacePath,
				breaker,
				logger: ctx.logger,
				tokenAccumulator: ctx.tokenAccumulator,
				signal: ctx.signal,
				promptFacade: ctx.promptFacade,
				onLogEntry: ctx.onLogEntry
			};

			try {
				const result = await processUrlWorker(url, workerCtx);
				processedUrls.set(normalizedUrl, {
					status: classifyProcessedUrlStatus(result),
					count: result.count
				});
				return {
					...result,
					remainingUrlBudget: Math.max(0, ctx.maxPagesToProcess - processedUrls.size)
				};
			} catch (error) {
				processedUrls.set(normalizedUrl, {
					status: 'error',
					count: 0
				});
				return {
					url,
					files: [],
					count: 0,
					error: error instanceof Error ? error.message : String(error),
					remainingUrlBudget: Math.max(0, ctx.maxPagesToProcess - processedUrls.size)
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
		description: 'Get workspace overview: total items, new items, updated items, categories, tags, brands.',
		inputSchema: z.object({}),
		execute: () => readWorkspaceOverview(ctx.workspacePath, ctx.existing.items)
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
