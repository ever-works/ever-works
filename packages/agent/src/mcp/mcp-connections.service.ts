import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import {
    MCP_CONNECTION_NAME_PATTERN,
    type McpConnectionTransport,
    type McpServerConnection,
} from '../entities/mcp-server-connection.entity';
import { McpServerConnectionRepository } from '../database/repositories/mcp-server-connection.repository';
import { AgentMcpServerBindingRepository } from '../database/repositories/agent-mcp-server-binding.repository';
import { AgentRepository } from '../database/repositories/agent.repository';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { isSafeWebhookUrl } from '../utils/ssrf-guard';
import { McpClientService } from './mcp-client.service';

/** Masked API view — auth header VALUES never leave the service. */
export interface McpConnectionView {
    id: string;
    name: string;
    url: string;
    transport: McpConnectionTransport;
    enabled: boolean;
    source: string;
    authHeaderNames: string[];
    lastConnectedAt: Date | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
}

/** Per-agent effective binding state for the MCP Servers tab (plan T27). */
export interface AgentMcpServerState {
    connection: McpConnectionView;
    /** Does this agent get the server's tools right now? */
    effectiveEnabled: boolean;
    /** Where the effective state comes from. */
    bindingSource: 'agent' | 'tenant' | 'none';
    /** True when no agent-level override exists and a tenant binding decides. */
    inheritedFromTenant: boolean;
}

export interface McpConnectionTestResult {
    ok: boolean;
    toolCount: number;
    tools: string[];
    error?: string;
}

/**
 * Agent Plugins MCP slice — CRUD + test + binding resolution for manual
 * MCP connections. Cross-user access resolves to `NotFoundException`
 * (never 403 — no existence leak, security spec §8).
 *
 * Creating a connection also creates an enabled 'tenant' binding, so a
 * fresh manual connection is inherited by all the user's agents
 * immediately and narrowed per agent afterwards (narrow-only semantics,
 * like tool grants).
 */
@Injectable()
export class McpConnectionsService {
    private readonly logger = new Logger(McpConnectionsService.name);

    constructor(
        private readonly connections: McpServerConnectionRepository,
        private readonly bindings: AgentMcpServerBindingRepository,
        private readonly client: McpClientService,
        private readonly agents: AgentRepository,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    // ── connection CRUD ───────────────────────────────────────────

    async list(userId: string): Promise<McpConnectionView[]> {
        const rows = await this.connections.findByUser(userId);
        return rows.map((row) => this.toView(row));
    }

    async get(userId: string, id: string): Promise<McpConnectionView> {
        const row = await this.requireConnection(userId, id);
        return this.toView(row);
    }

    async create(
        userId: string,
        input: {
            name: string;
            url: string;
            transport: McpConnectionTransport;
            authHeaders?: Record<string, string>;
        },
    ): Promise<McpConnectionView> {
        this.assertValidName(input.name);
        this.assertValidUrl(input.url);
        this.assertValidHeaders(input.authHeaders);

        const existing = await this.connections.findByUserAndName(userId, input.name);
        if (existing) {
            throw new ConflictException(`A connection named "${input.name}" already exists.`);
        }

        const row = await this.connections.create({
            userId,
            name: input.name,
            url: input.url,
            transport: input.transport,
            authHeaders: input.authHeaders ?? null,
            enabled: true,
            source: 'manual',
        });

        // Tenant-level inherit row: every agent gets the connection until
        // an agent-level override narrows it.
        await this.bindings.upsert({
            userId,
            connectionId: row.id,
            targetType: 'tenant',
            targetId: null,
            enabled: true,
        });

        await this.logActivity(userId, ActivityActionType.MCP_CONNECTION_CREATED, row);
        return this.toView(row);
    }

    async update(
        userId: string,
        id: string,
        patch: {
            name?: string;
            url?: string;
            transport?: McpConnectionTransport;
            authHeaders?: Record<string, string> | null;
            enabled?: boolean;
        },
    ): Promise<McpConnectionView> {
        const row = await this.requireConnection(userId, id);

        if (patch.name !== undefined && patch.name !== row.name) {
            this.assertValidName(patch.name);
            const clash = await this.connections.findByUserAndName(userId, patch.name);
            if (clash) {
                throw new ConflictException(`A connection named "${patch.name}" already exists.`);
            }
            row.name = patch.name;
        }
        if (patch.url !== undefined) {
            this.assertValidUrl(patch.url);
            row.url = patch.url;
        }
        if (patch.transport !== undefined) row.transport = patch.transport;
        if (patch.authHeaders !== undefined) {
            this.assertValidHeaders(patch.authHeaders ?? undefined);
            row.authHeaders = patch.authHeaders;
        }
        if (patch.enabled !== undefined) row.enabled = patch.enabled;

        const saved = await this.connections.save(row);
        this.client.invalidate(id);
        await this.logActivity(userId, ActivityActionType.MCP_CONNECTION_UPDATED, saved);
        return this.toView(saved);
    }

    async remove(userId: string, id: string): Promise<{ deleted: true }> {
        const row = await this.requireConnection(userId, id);
        await this.connections.deleteByIdAndUser(id, userId);
        this.client.invalidate(id);
        await this.logActivity(userId, ActivityActionType.MCP_CONNECTION_DELETED, row);
        return { deleted: true };
    }

    /** Connect + listTools; stamps lastConnectedAt/lastError either way. */
    async test(userId: string, id: string): Promise<McpConnectionTestResult> {
        const row = await this.requireConnection(userId, id);
        try {
            const tools = await this.client.listTools(row, { bypassCache: true });
            await this.logActivity(userId, ActivityActionType.MCP_CONNECTION_TESTED, row, {
                toolCount: tools.length,
            });
            return { ok: true, toolCount: tools.length, tools: tools.map((tool) => tool.name) };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.logActivity(userId, ActivityActionType.MCP_CONNECTION_TESTED, row, {
                error: message,
            });
            return { ok: false, toolCount: 0, tools: [], error: message };
        }
    }

    // ── per-agent bindings (plan T27) ─────────────────────────────

    async listForAgent(userId: string, agentId: string): Promise<AgentMcpServerState[]> {
        await this.requireAgent(userId, agentId);
        const [rows, bindingRows] = await Promise.all([
            this.connections.findByUser(userId),
            this.bindings.findForAgent(userId, agentId),
        ]);

        return rows.map((row) => {
            const agentRow = bindingRows.find(
                (b) => b.connectionId === row.id && b.targetType === 'agent',
            );
            const tenantRow = bindingRows.find(
                (b) => b.connectionId === row.id && b.targetType === 'tenant',
            );
            const bindingSource: AgentMcpServerState['bindingSource'] = agentRow
                ? 'agent'
                : tenantRow
                  ? 'tenant'
                  : 'none';
            const boundEnabled = agentRow ? agentRow.enabled : (tenantRow?.enabled ?? false);
            return {
                connection: this.toView(row),
                effectiveEnabled: row.enabled && boundEnabled,
                bindingSource,
                inheritedFromTenant: !agentRow && !!tenantRow,
            };
        });
    }

    /** Upsert the agent-level override row ({enabled} narrows or re-binds). */
    async setAgentBinding(
        userId: string,
        agentId: string,
        connectionId: string,
        enabled: boolean,
    ): Promise<AgentMcpServerState> {
        await this.requireAgent(userId, agentId);
        const row = await this.requireConnection(userId, connectionId);
        await this.bindings.upsert({
            userId,
            connectionId,
            targetType: 'agent',
            targetId: agentId,
            enabled,
        });
        await this.logActivity(userId, ActivityActionType.MCP_BINDING_UPDATED, row, {
            agentId,
            enabled,
        });
        const states = await this.listForAgent(userId, agentId);
        return states.find((s) => s.connection.id === connectionId)!;
    }

    /** Remove the agent-level override → revert to tenant inheritance. */
    async clearAgentBinding(
        userId: string,
        agentId: string,
        connectionId: string,
    ): Promise<AgentMcpServerState> {
        await this.requireAgent(userId, agentId);
        const row = await this.requireConnection(userId, connectionId);
        await this.bindings.deleteOne(userId, connectionId, 'agent', agentId);
        await this.logActivity(userId, ActivityActionType.MCP_BINDING_UPDATED, row, {
            agentId,
            reverted: true,
        });
        const states = await this.listForAgent(userId, agentId);
        return states.find((s) => s.connection.id === connectionId)!;
    }

    /**
     * The connections whose tools one agent's runs should expose:
     * connection enabled AND (agent override enabled, or — absent an
     * override — tenant binding enabled). Used by `McpToolSource`.
     */
    async resolveEffectiveConnections(
        userId: string,
        agentId: string,
    ): Promise<McpServerConnection[]> {
        const [rows, bindingRows] = await Promise.all([
            this.connections.findEnabledByUser(userId),
            this.bindings.findForAgent(userId, agentId),
        ]);
        return rows.filter((row) => {
            const agentRow = bindingRows.find(
                (b) => b.connectionId === row.id && b.targetType === 'agent',
            );
            if (agentRow) return agentRow.enabled;
            const tenantRow = bindingRows.find(
                (b) => b.connectionId === row.id && b.targetType === 'tenant',
            );
            return tenantRow?.enabled ?? false;
        });
    }

    // ── internals ─────────────────────────────────────────────────

    private async requireConnection(userId: string, id: string): Promise<McpServerConnection> {
        const row = await this.connections.findByIdAndUser(id, userId);
        if (!row) throw new NotFoundException(`MCP connection ${id} not found.`);
        return row;
    }

    private async requireAgent(userId: string, agentId: string): Promise<void> {
        const agent = await this.agents.findByIdAndUser(agentId, userId);
        if (!agent) throw new NotFoundException(`Agent ${agentId} not found.`);
    }

    private assertValidName(name: string): void {
        if (!MCP_CONNECTION_NAME_PATTERN.test(name)) {
            throw new BadRequestException(
                'Connection name must be 1-80 chars of lowercase letters, digits and hyphens (it becomes the mcp__<name>__<tool> prefix).',
            );
        }
    }

    /**
     * The URL is operator-supplied but still reaches a server-side
     * fetcher — apply the same lexical SSRF guard as the model-facing
     * URL tools (blocks non-HTTP(S) schemes, private/loopback/link-local
     * IPs and cloud-metadata hosts).
     */
    private assertValidUrl(url: string): void {
        if (!isSafeWebhookUrl(url)) {
            throw new BadRequestException(
                'URL must be http(s) to a public host (private, loopback, link-local, and cloud-metadata addresses are blocked).',
            );
        }
    }

    private assertValidHeaders(headers?: Record<string, string>): void {
        if (!headers) return;
        const entries = Object.entries(headers);
        if (entries.length > 10) {
            throw new BadRequestException('At most 10 auth headers are supported.');
        }
        for (const [name, value] of entries) {
            if (!/^[A-Za-z0-9-]{1,128}$/.test(name)) {
                throw new BadRequestException(`Invalid header name "${name}".`);
            }
            if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
                throw new BadRequestException(`Invalid value for header "${name}".`);
            }
        }
    }

    private toView(row: McpServerConnection): McpConnectionView {
        return {
            id: row.id,
            name: row.name,
            url: row.url,
            transport: row.transport,
            enabled: row.enabled,
            source: row.source,
            // Masking: names only — values NEVER leave the service layer.
            authHeaderNames: row.authHeaders ? Object.keys(row.authHeaders) : [],
            lastConnectedAt: row.lastConnectedAt ?? null,
            lastError: row.lastError ?? null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }

    private async logActivity(
        userId: string,
        actionType: ActivityActionType,
        connection: McpServerConnection,
        details: Record<string, unknown> = {},
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                action: actionType,
                actionType,
                status: ActivityStatus.COMPLETED,
                summary: `MCP connection ${connection.name} — ${actionType}`,
                details: { connectionId: connection.id, name: connection.name, ...details },
            });
        } catch (err) {
            this.logger.warn(`Failed to log activity ${actionType}: ${err}`);
        }
    }
}
