import type { McpSdkClient } from './mcp-sdk';

/**
 * The seam through which `McpToolSource` obtains a CONNECTED client for a
 * stdio MCP server declared by an installed Agent Plugin package (AP-14).
 *
 * The contract lives here, in `mcp/`, and is implemented in
 * `agent-plugins/` — never the other way round. `mcp/` must not import
 * `agent-plugins/`: the tool source is the generic MCP consumer and has no
 * business knowing how packages are installed, where they live on disk, or
 * what the launch policy is. The API module binds the token; a runtime
 * without Agent Plugins simply has no binding, and the source skips stdio
 * connections with a WARN.
 */
export const MCP_STDIO_LAUNCHER = 'MCP_STDIO_LAUNCHER' as const;

export interface McpStdioLaunch {
    /** A connected, initialized client, ready for listTools / callTool. */
    readonly client: McpSdkClient;
    /** Stops the subprocess. Idempotent; must not throw. */
    close(): Promise<void>;
}

export interface McpStdioLauncher {
    /**
     * Launch the named server from the named package and connect to it.
     *
     * Rejects when the package or server is gone, when the server is not a
     * stdio server, or when deployment policy refuses the launch
     * (`AGENT_PLUGINS_STDIO`). The caller treats every rejection the same
     * way: that connection contributes zero tools, and the run continues.
     */
    launch(request: {
        readonly userId: string;
        readonly packageName: string;
        readonly serverName: string;
    }): Promise<McpStdioLaunch>;
}

/**
 * `mcp_server_connections.url` is NOT NULL and a stdio server has no URL, so
 * a stdio row carries this pseudo-URL instead. It is an OPAQUE POINTER, not
 * an address: nothing dials it, and `isSafeWebhookUrl` never sees it.
 *
 * Keeping stdio servers in the same table is what makes them inherit the
 * whole authorisation story for free — the row is created disabled and
 * unbound, and an agent gets its tools only after an explicit enable plus a
 * binding, exactly like a remote package server. A separate table would have
 * meant re-implementing that gate for the one transport that runs local code.
 */
const STDIO_URL_PREFIX = 'stdio:';

export function stdioConnectionUrl(packageName: string, serverName: string): string {
    return `${STDIO_URL_PREFIX}${packageName}/${serverName}`;
}

/**
 * Read a stdio pseudo-URL back. Returns `null` for anything that is not one,
 * including a row whose transport says stdio but whose URL does not parse —
 * a mismatch is treated as "no tools", never as a guess.
 *
 * The SERVER name is the last segment and the package name is everything
 * before it. Both are already constrained upstream — a manifest name matches
 * `^[a-z0-9][a-z0-9.-]*[a-z0-9]$` and a server name reaching the reconciler
 * matches `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` — so neither can contain `/` and no
 * two pairs can produce the same pointer today. `lastIndexOf` is chosen so
 * that stays true if a scoped name (`@acme/tools`) is ever allowed, rather
 * than because one is allowed now.
 */
export function parseStdioConnectionUrl(
    url: string,
): { packageName: string; serverName: string } | null {
    if (!url.startsWith(STDIO_URL_PREFIX)) return null;
    const rest = url.slice(STDIO_URL_PREFIX.length);
    const cut = rest.lastIndexOf('/');
    if (cut <= 0 || cut === rest.length - 1) return null;
    return { packageName: rest.slice(0, cut), serverName: rest.slice(cut + 1) };
}
