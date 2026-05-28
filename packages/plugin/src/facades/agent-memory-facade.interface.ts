import type { IBaseFacade } from './base-facade.interface.js';
import type { FacadeOptions } from './facade-options.interface.js';
import type {
	AgentMemorySession,
	AgentMemoryRecord,
	AgentMemorySearchResponse,
	AgentMemoryContext
} from '../contracts/capabilities/agent-memory.interface.js';

/**
 * Inputs to the facade-facing `saveMemory` (the `settings` field that
 * the plugin contract takes is filled in by the facade — callers don't
 * need to know).
 */
export interface AgentMemorySaveFacadeInput {
	readonly content: string;
	readonly tags?: readonly string[];
	readonly metadata?: Record<string, unknown>;
	readonly sessionId?: string;
	readonly projectId?: string;
}

export interface AgentMemorySearchFacadeInput {
	readonly query: string;
	readonly limit?: number;
	readonly tags?: readonly string[];
	readonly sessionId?: string;
	readonly projectId?: string;
}

export interface AgentMemoryContextFacadeInput {
	readonly query?: string;
	readonly purpose?: string;
	readonly sessionId?: string;
	readonly projectId?: string;
	readonly maxTokens?: number;
}

export interface AgentMemoryListSessionsFacadeInput {
	readonly limit?: number;
	readonly projectId?: string;
}

/**
 * Facade interface for the `agent-memory` capability — exposed to
 * pipeline steps via `StepExecutionContext.agentMemoryFacade`.
 *
 * The shape mirrors the unbound `IAgentMemoryFacade` (from
 * `contracts/capabilities/agent-memory.interface.ts`) but uses the
 * proper `FacadeOptions` type instead of `unknown`. The implementation
 * in `@ever-works/agent` (AgentMemoryFacadeService) satisfies both
 * shapes simultaneously.
 *
 * Steps obtain a "bound" instance via the pipeline facade service —
 * `workId` / `userId` / `providerOverride` are pre-filled, so step
 * code calls `agentMemoryFacade.saveMemory({ content: '...' })`
 * without threading the full options bag through every call.
 */
export interface IAgentMemoryStepFacade extends IBaseFacade {
	openSession(
		metadata: Record<string, unknown> | undefined,
		facadeOptions: FacadeOptions
	): Promise<AgentMemorySession>;

	closeSession(sessionId: string, facadeOptions: FacadeOptions): Promise<void>;

	saveMemory(input: AgentMemorySaveFacadeInput, facadeOptions: FacadeOptions): Promise<AgentMemoryRecord>;

	searchMemory(input: AgentMemorySearchFacadeInput, facadeOptions: FacadeOptions): Promise<AgentMemorySearchResponse>;

	buildContext(input: AgentMemoryContextFacadeInput, facadeOptions: FacadeOptions): Promise<AgentMemoryContext>;

	deleteEntry(id: string, facadeOptions: FacadeOptions): Promise<void>;

	listSessions(
		options: AgentMemoryListSessionsFacadeInput | undefined,
		facadeOptions: FacadeOptions
	): Promise<readonly AgentMemorySession[]>;
}
