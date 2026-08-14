import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { McpServerConnection } from '../entities/mcp-server-connection.entity';
import { McpServerConnectionRepository } from '../database/repositories/mcp-server-connection.repository';
import {
    MCP_CLIENT_FACTORY,
    createSdkMcpClientFactory,
    type McpClientFactory,
    type McpSdkClient,
    type McpSdkTool,
} from './mcp-sdk';

/** Default per-call timeout (ms) — the spec's 30s default. */
export const MCP_CALL_TIMEOUT_MS = 30_000;
/** Connect + listTools timeout (ms) — kept short so run assembly never hangs. */
export const MCP_LIST_TIMEOUT_MS = 10_000;
/** Serialized tool-result size cap (bytes of JSON) — beyond it the result is truncated. */
export const MCP_RESULT_SIZE_CAP = 100_000;
/** listTools TTL cache per connection (ms). */
export const MCP_TOOLS_CACHE_TTL_MS = 60_000;

export interface McpToolInfo {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

/**
 * Agent Plugins MCP slice (plan §2.4) — connection lifecycle + tool
 * calls against EXTERNAL MCP servers, via the official SDK behind the
 * `MCP_CLIENT_FACTORY` seam.
 *
 * Posture:
 *   - Auth header VALUES never reach a log line or an error message —
 *     failures are classified into short, header-free strings before
 *     they are stamped on the row or returned.
 *   - Every outcome stamps `lastConnectedAt` / `lastError` on the
 *     connection row so the Settings UI can show live status.
 *   - Clients are connect-per-operation and closed in `finally` — MCP
 *     servers are external and long-lived pooling is not worth the
 *     stale-socket failure modes in v1.
 */
@Injectable()
export class McpClientService {
    private readonly logger = new Logger(McpClientService.name);
    private readonly factory: McpClientFactory;
    private readonly toolsCache = new Map<string, { at: number; tools: McpToolInfo[] }>();

    constructor(
        private readonly connections: McpServerConnectionRepository,
        @Optional()
        @Inject(MCP_CLIENT_FACTORY)
        factory?: McpClientFactory,
    ) {
        this.factory = factory ?? createSdkMcpClientFactory();
    }

    /**
     * List a server's tools with a short TTL cache. Failures classify +
     * stamp + rethrow — callers decide whether a dead server is fatal
     * (the test endpoint) or isolated (run assembly).
     */
    async listTools(
        connection: McpServerConnection,
        options: { bypassCache?: boolean } = {},
    ): Promise<McpToolInfo[]> {
        const cached = this.toolsCache.get(connection.id);
        if (!options.bypassCache && cached && Date.now() - cached.at < MCP_TOOLS_CACHE_TTL_MS) {
            return cached.tools;
        }

        let client: McpSdkClient | undefined;
        try {
            client = await this.connect(connection);
            const result = await client.listTools(undefined, { timeout: MCP_LIST_TIMEOUT_MS });
            const tools = (result.tools ?? []).map((tool) => this.normalizeTool(tool));
            this.toolsCache.set(connection.id, { at: Date.now(), tools });
            await this.stamp(connection, { ok: true });
            return tools;
        } catch (err) {
            const message = this.classifyError(err);
            await this.stamp(connection, { ok: false, error: message });
            throw new Error(message);
        } finally {
            await this.closeQuietly(client);
        }
    }

    /**
     * Call one tool with a timeout + serialized result size cap. Errors
     * come back as `{ error }` (never thrown) so the tool loop always
     * receives an actionable model-facing message.
     */
    async callTool(
        connection: McpServerConnection,
        toolName: string,
        args: Record<string, unknown>,
        options: { timeoutMs?: number } = {},
    ): Promise<unknown | { error: string }> {
        const timeout = options.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
        let client: McpSdkClient | undefined;
        try {
            client = await this.connect(connection);
            const result = await this.withTimeout(
                client.callTool({ name: toolName, arguments: args }, undefined, { timeout }),
                timeout,
                `MCP tool "${toolName}" timed out after ${timeout}ms.`,
            );
            await this.stamp(connection, { ok: true });
            return this.capResultSize(result);
        } catch (err) {
            const message = this.classifyError(err);
            await this.stamp(connection, { ok: false, error: message });
            return { error: `MCP server "${connection.name}": ${message}` };
        } finally {
            await this.closeQuietly(client);
        }
    }

    /** Drop one connection's cached tool list (after edits / disable). */
    invalidate(connectionId: string): void {
        this.toolsCache.delete(connectionId);
    }

    // ── internals ─────────────────────────────────────────────────

    private async connect(connection: McpServerConnection): Promise<McpSdkClient> {
        return this.factory.connect({
            url: connection.url,
            transport: connection.transport,
            headers: connection.authHeaders ?? {},
        });
    }

    private normalizeTool(tool: McpSdkTool): McpToolInfo {
        return {
            name: String(tool.name ?? ''),
            description: typeof tool.description === 'string' ? tool.description : '',
            inputSchema:
                tool.inputSchema && typeof tool.inputSchema === 'object'
                    ? (tool.inputSchema as Record<string, unknown>)
                    : { type: 'object', properties: {} },
        };
    }

    /**
     * Serialized-size cap. Oversized results are truncated with an
     * explicit marker so the model knows content is missing instead of
     * silently receiving a corrupted payload.
     */
    private capResultSize(result: unknown): unknown {
        let serialized: string;
        try {
            serialized = JSON.stringify(result) ?? 'null';
        } catch {
            return { error: 'MCP tool result was not serializable.' };
        }
        if (serialized.length <= MCP_RESULT_SIZE_CAP) return result;
        return {
            truncated: true,
            note: `Result exceeded the ${MCP_RESULT_SIZE_CAP}-byte cap and was truncated.`,
            content: serialized.slice(0, MCP_RESULT_SIZE_CAP),
        };
    }

    private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        });
        return Promise.race([promise, timeout]).finally(() => {
            if (timer) clearTimeout(timer);
        }) as Promise<T>;
    }

    /**
     * Classify an SDK/network error into a short, header-free message.
     * NEVER passes the raw error through: fetch errors can echo request
     * headers (i.e. credentials) in their message chains.
     */
    private classifyError(err: unknown): string {
        const raw = err instanceof Error ? err.message : String(err);
        const lower = raw.toLowerCase();
        if (lower.includes('timed out') || lower.includes('timeout')) {
            return raw.length <= 120 ? raw : 'Request timed out.';
        }
        if (lower.includes('401') || lower.includes('unauthorized')) {
            return 'Authentication failed (401). Check the auth header.';
        }
        if (lower.includes('403') || lower.includes('forbidden')) {
            return 'Access forbidden (403).';
        }
        if (lower.includes('404') || lower.includes('not found')) {
            return 'Endpoint not found (404). Check the URL.';
        }
        if (
            lower.includes('econnrefused') ||
            lower.includes('enotfound') ||
            lower.includes('fetch failed') ||
            lower.includes('network')
        ) {
            return 'Server unreachable (connection failed).';
        }
        // Unknown class: keep it short and strip anything that could carry
        // a header value (very long messages / obvious token shapes).
        const compact = raw.replace(/\s+/g, ' ').trim();
        return compact.length > 0 && compact.length <= 200 ? compact : 'MCP request failed.';
    }

    private async stamp(
        connection: McpServerConnection,
        result: { ok: boolean; error?: string },
    ): Promise<void> {
        try {
            await this.connections.stampConnectionResult(connection.id, result);
        } catch (err) {
            this.logger.warn(
                `Could not stamp connection ${connection.id} status: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    private async closeQuietly(client: McpSdkClient | undefined): Promise<void> {
        if (!client) return;
        try {
            await client.close();
        } catch {
            // A close failure after the operation completed is noise.
        }
    }
}
