import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { McpServerConnection } from '../entities/mcp-server-connection.entity';
import { McpServerConnectionRepository } from '../database/repositories/mcp-server-connection.repository';
import { CREDENTIAL_RESOLVER, type CredentialResolver } from '../policy/credential-resolver';
import { redactCredentialValues } from '../policy/credential-interpolation';
import {
    MCP_CLIENT_FACTORY,
    createSdkMcpClientFactory,
    type McpClientFactory,
    type McpSdkClient,
    type McpSdkTool,
} from './mcp-sdk';
import {
    McpHeaderCredentialMissingError,
    McpInsecureCredentialTransportError,
    collectHeaderCredentialRefs,
    mcpCredentialTransport,
    resolveHeaderCredentials,
} from './mcp-header-credentials';
import { MCP_ERROR_MESSAGES } from './mcp-connection-health';
import { McpCredentialTransportPolicyService } from './mcp-credential-transport-policy.service';

/** Default per-call timeout (ms) — the spec's 30s default. */
export const MCP_CALL_TIMEOUT_MS = 30_000;
/** Connect + listTools timeout (ms) — kept short so run assembly never hangs. */
export const MCP_LIST_TIMEOUT_MS = 10_000;
/** Serialized tool-result size cap (bytes of JSON) — beyond it the result is truncated. */
export const MCP_RESULT_SIZE_CAP = 100_000;
/** listTools TTL cache per connection (ms). */
export const MCP_TOOLS_CACHE_TTL_MS = 60_000;

/**
 * Per-attempt holder for the credential values resolved into this attempt's
 * headers. Declared in the calling method's own stack frame and handed to
 * `connect()` so the error path can redact them — never stored on the
 * service, the entity or the tools cache.
 */
interface ResolvedSecretsSink {
    secrets?: ReadonlyMap<string, string>;
    /**
     * Set when this attempt sends LITERAL credentials to a plain-http
     * endpoint — allowed, as it always was, and stamped as the
     * `insecure_transport` warning on success.
     */
    insecureTransport?: boolean;
}

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
 *   - `{{cred.key}}` references in a stored header are resolved through the
 *     `CREDENTIAL_RESOLVER` port immediately before EVERY connection attempt
 *     (listing tools, calling a tool, a Settings test alike). The resolved
 *     values exist only inside that attempt; a key the resolver cannot
 *     supply refuses the attempt before any request is sent.
 *   - Transport: a `{{cred.key}}` reference is refused on a plain-http
 *     endpoint (before any lookup). LITERAL header values keep working over
 *     plain http exactly as before, and a successful attempt is stamped with
 *     the `insecure_transport` warning. An organization with "Require https
 *     for connection credentials" on refuses those too.
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
        /**
         * Resolves `{{cred.key}}` header references. Optional so a runtime
         * that has not bound the port keeps working for every connection
         * whose headers hold literal values — but a header that DOES
         * reference a key then fails closed (the key counts as missing),
         * never forwarded verbatim.
         */
        @Optional()
        @Inject(CREDENTIAL_RESOLVER)
        private readonly credentials?: CredentialResolver,
        /**
         * Reads the organization setting "Require https for connection
         * credentials". Consulted only for literal credentials over plain
         * http. Unbound ⇒ the setting cannot be on, so those keep working.
         */
        @Optional()
        private readonly transportPolicy?: McpCredentialTransportPolicyService,
    ) {
        this.factory = factory ?? createSdkMcpClientFactory();
    }

    /**
     * List a server's tools with a short TTL cache. Failures classify +
     * stamp + rethrow — callers decide whether a dead server is fatal
     * (the test endpoint) or isolated (run assembly).
     */
    /**
     * List tools over a client the CALLER owns and keeps (AP-14).
     *
     * The dial-per-call shape of `listTools`/`callTool` is right for an HTTP
     * server and wrong for a stdio one, where "connect" means "spawn": a
     * reconnect per tool call would respawn the subprocess every time. The
     * run-scoped path therefore opens one client, hands it here, and closes
     * it at run end — while timeouts, error classification, the result cap
     * and status stamping stay in this one place rather than being
     * reimplemented alongside.
     */
    async listToolsOver(
        client: McpSdkClient,
        connection: McpServerConnection,
    ): Promise<McpToolInfo[]> {
        try {
            const result = await client.listTools(undefined, { timeout: MCP_LIST_TIMEOUT_MS });
            const tools = (result.tools ?? []).map((tool) => this.normalizeTool(tool));
            await this.stamp(connection, { ok: true });
            return tools;
        } catch (err) {
            const message = this.classifyError(err, connection);
            await this.stamp(connection, { ok: false, error: message });
            throw new Error(message);
        }
    }

    /** Call one tool over a caller-owned client. See {@link listToolsOver}. */
    async callToolOver(
        client: McpSdkClient,
        connection: McpServerConnection,
        toolName: string,
        args: Record<string, unknown>,
        options: { timeoutMs?: number } = {},
    ): Promise<unknown | { error: string }> {
        const timeout = options.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
        try {
            const result = await this.withTimeout(
                client.callTool({ name: toolName, arguments: args }, undefined, { timeout }),
                timeout,
                `MCP tool "${toolName}" timed out after ${timeout}ms.`,
            );
            await this.stamp(connection, { ok: true });
            return this.capResultSize(result);
        } catch (err) {
            const message = this.classifyError(err, connection);
            await this.stamp(connection, { ok: false, error: message });
            return { error: `MCP server "${connection.name}": ${message}` };
        }
    }

    async listTools(
        connection: McpServerConnection,
        options: { bypassCache?: boolean } = {},
    ): Promise<McpToolInfo[]> {
        const cached = this.toolsCache.get(connection.id);
        if (!options.bypassCache && cached && Date.now() - cached.at < MCP_TOOLS_CACHE_TTL_MS) {
            return cached.tools;
        }

        let client: McpSdkClient | undefined;
        const resolved: ResolvedSecretsSink = {};
        try {
            client = await this.connect(connection, resolved);
            const result = await client.listTools(undefined, { timeout: MCP_LIST_TIMEOUT_MS });
            const tools = (result.tools ?? []).map((tool) => this.normalizeTool(tool));
            this.toolsCache.set(connection.id, { at: Date.now(), tools });
            await this.stamp(connection, this.successOutcome(resolved));
            return tools;
        } catch (err) {
            const message = this.classifyError(err, connection, resolved.secrets);
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
        const resolved: ResolvedSecretsSink = {};
        try {
            client = await this.connect(connection, resolved);
            const result = await this.withTimeout(
                client.callTool({ name: toolName, arguments: args }, undefined, { timeout }),
                timeout,
                `MCP tool "${toolName}" timed out after ${timeout}ms.`,
            );
            await this.stamp(connection, this.successOutcome(resolved));
            // A server that reflects its own auth header in a RESULT must
            // not hand a resolved credential to the model.
            return this.capResultSize(
                resolved.secrets && resolved.secrets.size > 0
                    ? redactCredentialValues(result, resolved.secrets)
                    : result,
            );
        } catch (err) {
            const message = this.classifyError(err, connection, resolved.secrets);
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

    /**
     * Connect with an EXPLICIT timeout.
     *
     * The SDK's own `connect()` bounds nothing that matters here: the
     * `initialize` request falls back to the SDK's 60s default, and the
     * SSE transport's `start()` resolves only when the server emits its
     * `endpoint` event — a server that accepts the stream and then goes
     * quiet leaves that promise UNSETTLED FOREVER. Since `connect` is
     * awaited inside run assembly (`McpToolSource.buildTools` →
     * `AgentToolService.resolveGrantedTools`), an unbounded connect hangs
     * the whole run, not just the MCP tools. This race is the only bound.
     *
     * A late-arriving success is closed rather than leaked — otherwise a
     * slow server would strand an open socket per attempt.
     */
    private async connect(
        connection: McpServerConnection,
        sink?: ResolvedSecretsSink,
    ): Promise<McpSdkClient> {
        // Resolved BEFORE the factory is called: a refusal here means no
        // request has left the platform.
        const headers = await this.resolveConnectHeaders(connection, sink);
        const pending = this.factory.connect({
            url: connection.url,
            transport: connection.transport,
            headers,
        });
        try {
            return await this.withTimeout(
                pending,
                MCP_LIST_TIMEOUT_MS,
                `Connection to MCP server "${connection.name}" timed out after ${MCP_LIST_TIMEOUT_MS}ms.`,
            );
        } catch (err) {
            void pending.then((client) => this.closeQuietly(client)).catch(() => undefined);
            throw err;
        }
    }

    /**
     * Build the headers for ONE connection attempt.
     *
     *  1. Scheme re-check, before any credential is looked up. A
     *     `{{cred.key}}` reference aimed at a plain-http endpoint is refused.
     *     LITERAL values over plain http are sent exactly as before and the
     *     attempt is marked `insecure_transport` — unless the connection's
     *     organization requires https, which refuses them (and so does a
     *     setting that cannot be read).
     *  2. No `{{cred.key}}` reference ⇒ the stored headers are used exactly
     *     as today.
     *  3. Otherwise the keys are resolved for the connection's owner, a
     *     missing key refuses the attempt naming the key, and the
     *     substituted headers are a NEW object handed only to the factory.
     *     They are never assigned to the entity, the tools cache, a log line
     *     or an error message; the values reach `sink` solely so the error
     *     path can scrub them.
     */
    private async resolveConnectHeaders(
        connection: McpServerConnection,
        sink?: ResolvedSecretsSink,
    ): Promise<Record<string, string>> {
        const stored = connection.authHeaders ?? {};
        const transport = mcpCredentialTransport({
            url: connection.url,
            transport: connection.transport,
            headers: stored,
        });
        if (transport.verdict === 'refused') {
            throw new McpInsecureCredentialTransportError(transport.reason);
        }
        if (transport.verdict === 'insecure') {
            await this.assertOrganizationAllowsPlainHttp(connection);
            if (sink) sink.insecureTransport = true;
        }

        const keys = collectHeaderCredentialRefs(stored);
        if (keys.length === 0) return stored;

        let available: ReadonlyMap<string, string> = new Map();
        if (this.credentials) {
            try {
                available = await this.credentials.resolve(
                    {
                        userId: connection.userId,
                        organizationId: connection.organizationId ?? null,
                        tenantId: connection.tenantId ?? null,
                    },
                    keys,
                );
            } catch (err) {
                // Fail closed. The resolver's own message is not trusted to
                // be value-free, so only the error class is logged.
                this.logger.warn(
                    `Credential lookup failed for MCP connection ${connection.id} (${
                        err instanceof Error ? err.name : 'unknown error'
                    }); refusing to connect.`,
                );
                throw new McpHeaderCredentialMissingError(keys);
            }
        }

        const result = resolveHeaderCredentials(stored, available);
        if (result.missing.length > 0) {
            throw new McpHeaderCredentialMissingError(result.missing);
        }
        if (sink) sink.secrets = result.secrets;
        return result.headers;
    }

    /**
     * Literal credentials over plain http: refused only when the connection's
     * organization turned on "Require https for connection credentials", or
     * when that setting cannot be read. Otherwise allowed, as before.
     */
    private async assertOrganizationAllowsPlainHttp(
        connection: McpServerConnection,
    ): Promise<void> {
        if (!this.transportPolicy) return;
        let strict: boolean;
        try {
            strict = await this.transportPolicy.requiresHttpsForCredentials({
                userId: connection.userId,
                organizationId: connection.organizationId ?? null,
                tenantId: connection.tenantId ?? null,
            });
        } catch {
            throw new McpInsecureCredentialTransportError('policy_unavailable');
        }
        if (strict) throw new McpInsecureCredentialTransportError('organization_policy');
    }

    /** `{ ok: true }` — plus the `insecure_transport` warning when this attempt sent literal credentials over plain http. */
    private successOutcome(sink: ResolvedSecretsSink): {
        ok: true;
        warning?: 'insecure_transport';
    } {
        return sink.insecureTransport ? { ok: true, warning: 'insecure_transport' } : { ok: true };
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
     * Strip this connection's auth header VALUES out of a message before
     * anything else looks at it.
     *
     * Not theoretical: `new Headers({...})` reports a malformed value by
     * quoting it verbatim — `Headers.append: "Bearer <token>" is an
     * invalid header value.` — and that message reaches `classifyError`,
     * whose unknown-class branch passes short messages through. Without
     * this scrub the token lands in `mcp_server_connections.lastError` (a
     * PLAINTEXT column), in the `GET /api/mcp-connections` response, on
     * the Settings screen, and — via `callTool`'s `{ error }` — in the
     * model's conversation history.
     *
     * Runs on the RAW message so no later transform (whitespace collapse,
     * truncation) can reconstitute a partial value.
     */
    private redactHeaderValues(
        message: string,
        connection: McpServerConnection,
        secrets?: ReadonlyMap<string, string>,
    ): string {
        let out = message;
        // Values resolved from `{{cred.key}}` references are what was
        // actually SENT, so they are what a header-echoing error can quote.
        // Plausible-length secrets become `[redacted:cred.<key>]`; anything
        // shorter is scrubbed the same way a stored value is.
        if (secrets && secrets.size > 0) {
            out = redactCredentialValues(out, secrets);
            for (const value of secrets.values()) {
                if (typeof value !== 'string' || value.length === 0) continue;
                out = out.split(value).join('***');
            }
        }
        for (const value of Object.values(connection.authHeaders ?? {})) {
            if (typeof value !== 'string' || value.length === 0) continue;
            out = out.split(value).join('***');
        }
        return out;
    }

    /**
     * Classify an SDK/network error into a short, header-free message.
     * NEVER passes the raw error through: fetch errors can echo request
     * headers (i.e. credentials) in their message chains.
     */
    private classifyError(
        err: unknown,
        connection: McpServerConnection,
        secrets?: ReadonlyMap<string, string>,
    ): string {
        // Refusals raised before any request was sent carry their own fixed,
        // value-free message (key names only).
        if (err instanceof McpHeaderCredentialMissingError) return err.message;
        if (err instanceof McpInsecureCredentialTransportError) return err.message;
        const raw = this.redactHeaderValues(
            err instanceof Error ? err.message : String(err),
            connection,
            secrets,
        );
        const lower = raw.toLowerCase();
        if (lower.includes('timed out') || lower.includes('timeout')) {
            return raw.length <= 120 ? raw : MCP_ERROR_MESSAGES.timeout;
        }
        if (lower.includes('401') || lower.includes('unauthorized')) {
            return MCP_ERROR_MESSAGES.unauthorized;
        }
        if (lower.includes('403') || lower.includes('forbidden')) {
            return MCP_ERROR_MESSAGES.forbidden;
        }
        if (lower.includes('404') || lower.includes('not found')) {
            return MCP_ERROR_MESSAGES.notFound;
        }
        if (
            lower.includes('econnrefused') ||
            lower.includes('enotfound') ||
            lower.includes('fetch failed') ||
            lower.includes('network')
        ) {
            return MCP_ERROR_MESSAGES.unreachable;
        }
        // Unknown class: keep it short and strip anything that could carry
        // a header value (very long messages / obvious token shapes).
        const compact = raw.replace(/\s+/g, ' ').trim();
        return compact.length > 0 && compact.length <= 200 ? compact : MCP_ERROR_MESSAGES.failed;
    }

    private async stamp(
        connection: McpServerConnection,
        result: { ok: boolean; error?: string; warning?: 'insecure_transport' },
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
