/**
 * Agents/Skills/Tasks PR #1017 — Phase 16.10.
 *
 * Token + contract for the Agent plugin pass-through tools
 * (`searchWeb`, `screenshot`, `extractContent`). Same circular-dep
 * dodge as the Phase-15.5 post-processor and Phase-16.6 git facade
 * tokens: `agent-tool.service.ts` injects this via `@Optional()` so
 * the descriptor list can be built without a runtime dependency on
 * the concrete `SearchFacadeService` / `ScreenshotFacadeService` /
 * `ContentExtractorFacadeService` graph.
 *
 * The platform adapter forwards each call into the real facade, with
 * the Agent's `userId` / `agentId` / `workId` / optional `taskId`
 * threaded onto the `FacadeOptions` so Phase 15.6 attribution lands
 * on every resulting `PluginUsageEvent`.
 */

export interface AgentSearchWebInput {
	userId: string;
	agentId: string;
	workId?: string;
	taskId?: string;
	query: string;
	maxResults?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
}

export interface AgentSearchWebResult {
	results: Array<{
		title: string;
		url: string;
		snippet?: string | null;
		publishedDate?: string | null;
		score?: number;
	}>;
}

export interface AgentScreenshotInput {
	userId: string;
	agentId: string;
	workId?: string;
	taskId?: string;
	url: string;
	viewportWidth?: number;
	viewportHeight?: number;
	fullPage?: boolean;
}

export interface AgentScreenshotResult {
	success: boolean;
	imageUrl?: string | null;
	cacheUrl?: string | null;
}

export interface AgentExtractContentInput {
	userId: string;
	agentId: string;
	workId?: string;
	taskId?: string;
	url: string;
	/** Cap on raw content length returned to the model (defaults to 50 KB). */
	maxChars?: number;
}

export interface AgentExtractContentResult {
	url: string;
	content: string;
	contentLength: number;
	providerId?: string | null;
}

export interface AgentPluginToolsFacade {
	searchWeb(input: AgentSearchWebInput): Promise<AgentSearchWebResult>;
	screenshot(input: AgentScreenshotInput): Promise<AgentScreenshotResult>;
	extractContent(input: AgentExtractContentInput): Promise<AgentExtractContentResult>;
}

export const AGENT_PLUGIN_TOOLS_FACADE = 'AGENT_PLUGIN_TOOLS_FACADE' as const;
