import { Injectable, Logger } from '@nestjs/common';
import type { Agent } from '../entities/agent.entity';
import type { McpServerConnection } from '../entities/mcp-server-connection.entity';
import type {
    AgentToolDescriptor,
    AgentToolParameterSchema,
} from '../agents/agent-tool.service';
import type { AgentMcpToolSource } from '../agents/agent-mcp-tool-source';
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
    ) {}

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
                const descriptor = this.toDescriptor(connection, tool);
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
            this.logger.warn(`MCP tool name "${name}" exceeds ${MCP_TOOL_NAME_MAX} chars, dropped.`);
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
                return this.client.callTool(connection, tool.name, record);
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
