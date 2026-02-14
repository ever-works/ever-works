import type {
	ISearchFacade,
	IContentExtractorFacade,
	FacadeOptions,
	PipelineProgressCallback,
	PluginLogger
} from '@ever-works/plugin';
import { createSearchTool, createExtractContentTool, createReportProgressTool } from './facade-tools.js';
import { createCreateFileTool, createUpdateFileTool } from './file-tools.js';
import { ToolCircuitBreaker } from '../utils/tool-circuit-breaker.js';

export interface SandboxAndTools {
	readonly tools: Record<string, unknown>;
	readonly breaker: ToolCircuitBreaker;
}

export async function createAgentTools(
	workspacePath: string,
	facades: {
		searchFacade: ISearchFacade;
		contentExtractorFacade: IContentExtractorFacade;
	},
	facadeOptions: FacadeOptions,
	onProgress: PipelineProgressCallback | undefined,
	totalSteps: number,
	logger: PluginLogger
): Promise<SandboxAndTools> {
	// Dynamic imports — bash-tool and just-bash are ESM-only
	const [{ createBashTool }, { Bash, ReadWriteFs }] = await Promise.all([import('bash-tool'), import('just-bash')]);

	const fs = new ReadWriteFs({ root: workspacePath });
	const bashInstance = new Bash({ fs });

	const { tools: bashTools, sandbox: wrappedSandbox } = await createBashTool({
		sandbox: bashInstance,
		destination: '/'
	});

	const breaker = new ToolCircuitBreaker({ logger });
	const toolOptions = { breaker, logger };

	const tools = {
		bash: bashTools.bash,
		readFile: bashTools.readFile,
		createFile: createCreateFileTool(wrappedSandbox, '/'),
		updateFile: createUpdateFileTool(wrappedSandbox, '/'),
		search: createSearchTool(facades.searchFacade, facadeOptions, toolOptions),
		extractContent: createExtractContentTool(facades.contentExtractorFacade, facadeOptions, toolOptions),
		reportProgress: createReportProgressTool(onProgress, 1, totalSteps)
	};

	return { tools, breaker };
}
