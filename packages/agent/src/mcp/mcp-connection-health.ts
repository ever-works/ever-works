import type { ConnectionHealthErrorCode } from '@ever-works/contracts';
import {
    MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE,
    MCP_MISSING_CREDENTIAL_MESSAGE_PREFIX,
} from './mcp-header-credentials';

/**
 * MCP connection health (AW-15) — the catalogue of classified failure
 * messages `McpClientService` stamps on a connection, and the one mapping
 * from those messages to a health error code.
 *
 * Kept in one pure file so the strings the client writes and the codes the
 * repository derives from them cannot drift: both sides import the same
 * constants. Nothing here ever sees a raw server response.
 */
export const MCP_ERROR_MESSAGES = Object.freeze({
    timeout: 'Request timed out.',
    unauthorized: 'Authentication failed (401). Check the auth header.',
    forbidden: 'Access forbidden (403).',
    notFound: 'Endpoint not found (404). Check the URL.',
    unreachable: 'Server unreachable (connection failed).',
    failed: 'MCP request failed.',
});

/**
 * Map a classified message (as stored in `mcp_server_connections.lastError`)
 * to a health error code. Anything unrecognised is a plain `failed`, which
 * can degrade a connection but never expire it.
 */
export function mcpHealthErrorCode(message: string | null | undefined): ConnectionHealthErrorCode {
    if (typeof message !== 'string' || message.length === 0) return 'failed';
    if (message.startsWith(MCP_MISSING_CREDENTIAL_MESSAGE_PREFIX)) return 'credential_missing';
    // Refusals: a `{{cred.key}}` reference over plain http, or any credential
    // there while the organization requires https. Both start with the same
    // fixed sentence. (Literal credentials that were SENT over plain http are
    // not a failure at all — that success is stamped with the
    // `insecure_transport` warning instead.)
    if (message.startsWith(MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE)) return 'https_required';
    if (message === MCP_ERROR_MESSAGES.unauthorized || message === MCP_ERROR_MESSAGES.forbidden) {
        return 'credential_rejected';
    }
    if (message === MCP_ERROR_MESSAGES.notFound) return 'not_found';
    if (message === MCP_ERROR_MESSAGES.unreachable) return 'unreachable';
    const lower = message.toLowerCase();
    if (lower.includes('timed out') || lower.includes('timeout')) return 'timeout';
    return 'failed';
}
