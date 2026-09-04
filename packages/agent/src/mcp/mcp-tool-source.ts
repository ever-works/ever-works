import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Agent } from '../entities/agent.entity';
import type { McpServerConnection } from '../entities/mcp-server-connection.entity';
import type { AgentToolDescriptor, AgentToolParameterSchema } from '../agents/agent-tool.service';
import type { AgentMcpToolSource } from '../agents/agent-mcp-tool-source';
import { PluginUsageRepository } from '../database/repositories/plugin-usage.repository';
import { PluginUsageCapability } from '../entities/plugin-usage-event.entity';
import { McpClientService, type McpToolInfo } from './mcp-client.service';
import { McpConnectionsService } from './mcp-connections.service';

/** `mcp__<server>__<tool>` must stay within provider tool-name limits. */
export const MCP_TOOL_NAME_MAX = 128;
const MCP_DESCRIPTION_MAX = 1024;

/**
 * Agent Plugins MCP slice (plan §2.4, T26) — the tool source that turns
 * an agent's bound+enabled MCP connections into `AgentToolDescriptor`s
 * named `mcp__<server>__<tool>`.
 *
 * Injected into `AgentToolService.resolveGrantedTools` through the
 * `AGENT_MCP_TOOL_SOURCE` token (same optional-source posture as
 * `AGENT_DOMAIN_TOOL_SOURCES`), so MCP tools ride the existing funnel:
 * grant-matrix filtering, run-level WARN logs, and untrusted-result
 * fencing all apply for free.
 *
 * Failure isolation: a dead server contributes ZERO tools plus a warn
 * log — it never fails run assembly (spec §6.2.2 posture).
 *
 * Gate: MCP tools are outbound network calls, so they ride the same
 * `permissions.canCallExternalTools` gate as searchWeb / screenshot /
 * extractContent / sendEmail.
 */
@Injectable()
export class McpToolSource implements AgentMcpToolSource {
    private readonly logger = new Logger(McpToolSource.name);

    constructor(
        private readonly connections: McpConnectionsService,
        private readonly client: McpClientService,
        // @Optional() so every existing construction of this class keeps
        // working and so a context without a database still builds tools.
        // Usage accounting is an observation, never a precondition for a tool
        // being callable.
        @Optional()
        private readonly usage?: PluginUsageRepository,
    ) {}

    /**
     * Record one MCP tool invocation (T28).
     *
     * Best-effort in two distinct senses, both deliberate:
     *
     * - It NEVER throws into the tool call. An accounting failure that broke
     *   a working tool would trade a complete ledger for a broken agent, which
     *   is the wrong way round.
     * - It records only when the agent has a `workId`. `plugin_usage_events`
     *   requires one, and an agent scoped to a Mission or Idea has none.
     *   Making that column nullable is a migration on a table five other
     *   capabilities write to, which is a larger change than this feature
     *   should make on its own — so unscoped agents are simply not counted,
     *   and that is stated rather than hidden.
     */
    private async recordInvocation(agent: Agent, connection: McpServerConnection): Promise<void> {
        if (!this.usage || !agent.workId) return;
        try {
            await this.usage.record({
                workId: agent.workId,
                userId: agent.userId,
                pluginId: `mcp:${connection.name}`.slice(0, 128),
                capability: PluginUsageCapability.MCP,
                units: 1,
                costCents: 0,
                metadata: { connectionId: connection.id, source: connection.source },
            });
        } catch (err) {
            this.logger.debug(
                `Usage accounting failed for MCP tool call on "${connection.name}": ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    async buildTools(agent: Agent): Promise<AgentToolDescriptor[]> {
        if (!agent.permissions?.canCallExternalTools) return [];

        let effective: McpServerConnection[];
        try {
            effective = await this.connections.resolveEffectiveConnections(agent.userId, agent.id);
        } catch (err) {
            this.logger.warn(
                `Agent ${agent.id}: MCP connection resolution failed (no MCP tools this run): ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return [];
        }
        if (effective.length === 0) return [];

        const out: AgentToolDescriptor[] = [];
        const seen = new Set<string>();
        for (const connection of effective) {
            let tools: McpToolInfo[];
            try {
                tools = await this.client.listTools(connection);
            } catch (err) {
                // Dead server → zero tools + WARN, never a failed run.
                this.logger.warn(
                    `Agent ${agent.id}: MCP server "${connection.name}" unavailable (skipped): ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
                continue;
            }
            for (const tool of tools) {
                const descriptor = this.toDescriptor(agent, connection, tool);
                if (!descriptor) continue;
                if (seen.has(descriptor.name)) {
                    this.logger.warn(
                        `Agent ${agent.id}: duplicate MCP tool name "${descriptor.name}" dropped.`,
                    );
                    continue;
                }
                seen.add(descriptor.name);
                out.push(descriptor);
            }
        }
        return out;
    }

    // ── internals ─────────────────────────────────────────────────

    private toDescriptor(
        agent: Agent,
        connection: McpServerConnection,
        tool: McpToolInfo,
    ): AgentToolDescriptor | null {
        const sanitizedTool = this.sanitizeToolName(tool.name);
        if (!sanitizedTool) {
            this.logger.warn(
                `MCP server "${connection.name}": tool with unusable name ${JSON.stringify(
                    tool.name,
                )} dropped.`,
            );
            return null;
        }
        const name = `mcp__${connection.name}__${sanitizedTool}`;
        if (name.length > MCP_TOOL_NAME_MAX) {
            this.logger.warn(
                `MCP tool name "${name}" exceeds ${MCP_TOOL_NAME_MAX} chars, dropped.`,
            );
            return null;
        }

        const schema =
            tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
        const properties =
            schema['properties'] && typeof schema['properties'] === 'object'
                ? (schema['properties'] as Record<string, AgentToolParameterSchema>)
                : {};
        const required = Array.isArray(schema['required'])
            ? (schema['required'] as unknown[]).filter(
                  (item): item is string => typeof item === 'string',
              )
            : [];

        return {
            name,
            description: this.sanitizeDescription(connection.name, tool.description),
            // JSON-schema passthrough: the server's schema is already the
            // shape providers expect; property entries are structurally
            // compatible with AgentToolParameterSchema.
            parameters: { type: 'object', properties, required },
            invoke: async (args: unknown) => {
                const record =
                    args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
                const result = await this.client.callTool(connection, tool.name, record);
                // Started but NOT awaited. The helper swallows its own
                // rejections, but `repository.save()` can still stall — and a
                // stalled write would hold a successful tool response open,
                // making accounting a latency and availability dependency of
                // every tool call. It is an observation; it must not sit in
                // the response path.
                //
                // After the call, so a failed tool is not counted as usage.
                void this.recordInvocation(agent, connection);
                return result;
            },
        };
    }

    /** Server-supplied names are untrusted — keep a safe charset only. */
    private sanitizeToolName(raw: string): string | null {
        const cleaned = String(raw ?? '')
            .replace(/[^A-Za-z0-9_-]/g, '_')
            .replace(/_{3,}/g, '__')
            .replace(/^_+|_+$/g, '');
        return cleaned.length > 0 ? cleaned : null;
    }

    /** Strip control chars, prefix the server name, cap the length. */
    private sanitizeDescription(serverName: string, raw: string): string {
        // eslint-disable-next-line no-control-regex
        const cleaned = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
        const prefixed = `[${serverName}] ${cleaned.trim()}`.trim();
        return prefixed.length > MCP_DESCRIPTION_MAX
            ? `${prefixed.slice(0, MCP_DESCRIPTION_MAX - 1)}…`
            : prefixed;
    }
}
