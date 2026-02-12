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
	// Dynamic imports — bash-tool and just-bash are ESM-only
	const [{ createBashTool }, { Bash, ReadWriteFs }] = await Promise.all([import('bash-tool'), import('just-bash')]);

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
