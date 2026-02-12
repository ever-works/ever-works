import { createBashTool } from 'bash-tool';
import type {
	ISearchFacade,
	IContentExtractorFacade,
	FacadeOptions,
	PipelineProgressCallback
} from '@ever-works/plugin';
import { createSearchTool, createExtractContentTool, createReportProgressTool } from './facade-tools.js';

export interface SandboxAndTools {
	readonly tools: Record<string, unknown>;
	readonly sandbox: { stop?: () => Promise<void> };
}

/**
 * Create the full set of agent tools: bash-tool sandbox tools + facade tools.
 */
export async function createAgentTools(
	files: Record<string, string>,
	facades: {
		searchFacade: ISearchFacade;
		contentExtractorFacade: IContentExtractorFacade;
	},
	facadeOptions: FacadeOptions,
	onProgress: PipelineProgressCallback | undefined,
	totalSteps: number
): Promise<SandboxAndTools> {
	const { tools: bashTools, sandbox } = await createBashTool({ files });

	const tools = {
		...bashTools,
		search: createSearchTool(facades.searchFacade, facadeOptions),
		extractContent: createExtractContentTool(facades.contentExtractorFacade, facadeOptions),
		reportProgress: createReportProgressTool(onProgress, 1, totalSteps)
	};

	return { tools, sandbox };
}
