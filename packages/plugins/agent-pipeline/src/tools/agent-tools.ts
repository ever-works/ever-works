import { createBashTool } from 'bash-tool';
import { Bash, ReadWriteFs } from 'just-bash';
import type {
	ISearchFacade,
	IContentExtractorFacade,
	FacadeOptions,
	PipelineProgressCallback
} from '@ever-works/plugin';
import { createSearchTool, createExtractContentTool, createReportProgressTool } from './facade-tools.js';

export interface SandboxAndTools {
	readonly tools: Record<string, unknown>;
}

/**
 * Create the full set of agent tools: bash-tool sandbox tools + facade tools.
 */
export async function createAgentTools(
	workspacePath: string,
	facades: {
		searchFacade: ISearchFacade;
		contentExtractorFacade: IContentExtractorFacade;
	},
	facadeOptions: FacadeOptions,
	onProgress: PipelineProgressCallback | undefined,
	totalSteps: number
): Promise<SandboxAndTools> {
	const fs = new ReadWriteFs({ root: workspacePath });
	const bashInstance = new Bash({ fs });

	const { tools: bashTools } = await createBashTool({ sandbox: bashInstance });

	const tools = {
		...bashTools,
		search: createSearchTool(facades.searchFacade, facadeOptions),
		extractContent: createExtractContentTool(facades.contentExtractorFacade, facadeOptions),
		reportProgress: createReportProgressTool(onProgress, 1, totalSteps)
	};

	return { tools };
}
