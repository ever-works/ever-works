import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import {
    isConnectionHealth,
    isConnectionHealthErrorCode,
    type ConnectionHealth,
    type ConnectionHealthErrorCode,
} from '@ever-works/contracts';
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
import {
    MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE,
    MCP_ORGANIZATION_REQUIRES_HTTPS_MESSAGE,
    mcpCredentialTransport,
} from './mcp-header-credentials';
import {
    McpCredentialTransportPolicyService,
    type McpCredentialTransportScope,
} from './mcp-credential-transport-policy.service';

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
    /** AW-15 — health derived from every connection attempt; `unknown` until the first. */
    health: ConnectionHealth;
    /** When `health` was last written. */
    healthCheckedAt: Date | null;
    /** Classified code for `lastError` (e.g. `credential_missing`). Never a value. */
    lastErrorCode: ConnectionHealthErrorCode | null;
    /**
     * AW-15 — this connection sends LITERAL auth header values to a
     * plain-http endpoint: it works, but the credential travels unencrypted.
     * Derived from the stored URL + header map, so it is known before the
     * first attempt. Never carries a value.
     */
    insecureCredentialTransport: boolean;
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
        /**
         * AW-15 — the organization setting "Require https for connection
         * credentials". Unbound ⇒ the setting cannot be on, so literal
         * credentials over plain http are accepted exactly as before.
         */
        @Optional() private readonly transportPolicy?: McpCredentialTransportPolicyService,
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
        /**
         * The organization the new row will be stamped with, when the caller
         * knows it (the active request scope). Absent ⇒ a tenant-wide row,
         * which follows the strictest organization in the owner's tenant.
         */
        scope: { organizationId?: string | null } = {},
    ): Promise<McpConnectionView> {
        this.assertValidName(input.name);
        this.assertValidUrl(input.url);
        this.assertValidHeaders(input.authHeaders);
        await this.assertCredentialTransport(input.url, input.transport, input.authHeaders, {
            userId,
            organizationId: scope.organizationId ?? null,
        });

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
        // Checked on the RESULTING endpoint + headers whenever the patch
        // touches either, so neither "add a reference to an http row" nor
        // "move a referencing row to http" can store a connection that would
        // resolve a credential for cleartext. Literal header values over
        // plain http stay accepted (flagged `insecureCredentialTransport`)
        // unless the row's organization requires https. A patch that only
        // renames or toggles `enabled` is never blocked — the connect-time
        // re-check in McpClientService applies the same rules before anything
        // is sent.
        if (
            patch.url !== undefined ||
            patch.authHeaders !== undefined ||
            patch.transport !== undefined
        ) {
            await this.assertCredentialTransport(row.url, row.transport, row.authHeaders, {
                userId,
                organizationId: row.organizationId ?? null,
                tenantId: row.tenantId ?? null,
            });
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

    /**
     * Credential transport rules. Runs AFTER the SSRF check, so it only ever
     * narrows what that guard already admits:
     *
     *   - a `{{cred.key}}` reference needs an `https:` endpoint (resolving
     *     references is new, so refusing it on plain http regresses nothing);
     *   - LITERAL header values over plain http are accepted exactly as before
     *     — the view flags them `insecureCredentialTransport` — unless the
     *     organization turned on "Require https for connection credentials";
     *   - a plain-HTTP connection with no headers is accepted in every case.
     */
    private async assertCredentialTransport(
        url: string,
        transport: McpConnectionTransport | undefined,
        headers: Record<string, string> | null | undefined,
        scope: McpCredentialTransportScope,
    ): Promise<void> {
        const verdict = mcpCredentialTransport({ url, transport, headers });
        if (verdict.verdict === 'refused') {
            throw new BadRequestException(
                `${MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE}. Credential references are only resolved for https:// endpoints: use an https:// URL, or remove the reference.`,
            );
        }
        if (verdict.verdict !== 'insecure' || !this.transportPolicy) return;

        // The setting defaults to off; a read that fails resolves to that
        // default, so an unreadable setting never blocks what worked before.
        let strict = false;
        try {
            strict = await this.transportPolicy.requiresHttpsForCredentials(scope);
        } catch (err) {
            this.logger.warn(
                `Could not read "Require https for connection credentials" for organization ${
                    scope.organizationId ?? '(tenant-wide)'
                } (${err instanceof Error ? err.name : 'unknown error'}); using the default (off).`,
            );
        }
        if (strict) {
            throw new BadRequestException(
                `${MCP_ORGANIZATION_REQUIRES_HTTPS_MESSAGE}. Use an https:// URL, or remove the auth headers.`,
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
            // Header VALUES need the same care as header names: a value
            // carrying CR/LF (trivially pasted from a token file) is
            // rejected by the runtime's `Headers` at CONNECT time, in a
            // TypeError that quotes the value back. Refusing it here means
            // a clear 400 instead of a connection that is permanently
            // broken and whose failure message has to be scrubbed.
            // NEVER name the value in the error — only the header.
            // eslint-disable-next-line no-control-regex
            if (/[\u0000-\u001f\u007f]/.test(value)) {
                throw new BadRequestException(
                    `Value for header "${name}" contains control characters.`,
                );
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
            // A row read before the health columns existed (or a partial
            // fixture) reports "not checked yet" rather than guessing.
            health: isConnectionHealth(row.health) ? row.health : 'unknown',
            healthCheckedAt: row.healthCheckedAt ?? null,
            lastErrorCode: isConnectionHealthErrorCode(row.lastErrorCode)
                ? row.lastErrorCode
                : null,
            insecureCredentialTransport:
                mcpCredentialTransport({
                    url: row.url,
                    transport: row.transport,
                    headers: row.authHeaders,
                }).verdict === 'insecure',
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
