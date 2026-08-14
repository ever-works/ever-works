import type { Agent } from '../entities/agent.entity';
import type { AgentToolDescriptor } from './agent-tool.service';

/**
 * Agent Plugins MCP slice (plan §2.4, T26) — the optional injection seam
 * that hands `AgentToolService` the MCP tool descriptors for one agent.
 *
 * Same circular-dep dodge and posture as `AGENT_DOMAIN_TOOL_SOURCES`:
 * the implementation (`McpToolSource`, `packages/agent/src/mcp/`) needs
 * repositories + the MCP client, which must not become runtime imports
 * of the `agents/` subpath. The api-side @Global() AgentsModule binds
 * the token; `AgentToolService` injects it `@Optional()` so runtimes
 * without the MCP module behave exactly as before.
 *
 * The source is consumed inside `resolveGrantedTools` (the async
 * companion), NOT `resolveAllowedTools`: building MCP descriptors
 * requires I/O (DB + a possibly-cached listTools round-trip), and
 * appending before the grant partition means `mcp__<server>__<tool>`
 * names flow through the tool-grant matrix for free.
 */
export const AGENT_MCP_TOOL_SOURCE = 'AGENT_MCP_TOOL_SOURCE' as const;

export interface AgentMcpToolSource {
    /**
     * Resolve the agent's bound + enabled MCP connections into tool
     * descriptors named `mcp__<server>__<tool>`. MUST be failure-
     * isolated: a dead server or a resolution error yields fewer (or
     * zero) tools, never a rejection that fails run assembly.
     */
    buildTools(agent: Agent): Promise<AgentToolDescriptor[]>;
}
