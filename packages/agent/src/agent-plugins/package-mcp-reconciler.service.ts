import { Injectable, Logger } from '@nestjs/common';
import { McpServerConnectionRepository } from '../database/repositories/mcp-server-connection.repository';
import {
    MCP_CONNECTION_NAME_PATTERN,
    type McpServerConnection,
} from '../entities/mcp-server-connection.entity';
import {
    McpServerConfigService,
    type ResolvedMcpServer,
    type SkippedMcpReason,
    type SkippedMcpServer,
} from './mcp-server-config.service';
import { isSafeWebhookUrl } from '../utils/ssrf-guard';

/**
 * Bridges package-declared MCP servers into the EXISTING MCP connection
 * machinery (`mcp_server_connections` + `agent_mcp_server_bindings` + the
 * client and tool source shipped in #2082).
 *
 * ## Why a bridge rather than a parallel system
 *
 * `McpServerConnection.source` is typed `'manual' | 'package'`, with the
 * comment "'package' reserved for the agent-plugins package work" — the seam
 * for exactly this was designed in advance. Building a second binding table
 * for package servers would have duplicated a whole working subsystem: the
 * client, the tool source, the per-agent overrides, the SSRF and redirect
 * policy, and the API and UI that manage them. Everything here therefore
 * produces ordinary connection rows and stops.
 *
 * ## Package servers are created UNBOUND, and that is the point
 *
 * `McpConnectionsService.create` gives a manual connection a tenant-level
 * binding with `enabled: true`, so every agent can use it immediately. That is
 * right for a connection a user deliberately added, and **wrong** for one that
 * arrived inside a package: installing a package would silently grant every
 * agent network reach to whatever that package declares.
 *
 * So a reconciled connection is created with `enabled: false` and **no
 * binding at all**. Declaration and authorisation stay separate — a human has
 * to enable it and bind it, exactly as they would for a server they had never
 * seen before, which is what a package server is.
 */

/** Only remote transports can become a connection; the row is URL-shaped. */
const REMOTE_TRANSPORTS = new Set(['streamable-http', 'sse']);

export interface ReconcileResult {
    /** Connections created for newly-seen package servers. */
    readonly created: readonly string[];
    /** Already present and unchanged. */
    readonly unchanged: readonly string[];
    /** Existing rows whose URL or transport was updated to match the package. */
    readonly updated: readonly string[];
    /**
     * Declared servers that cannot become a connection, with the reason.
     *
     * Reuses the resolver's shape rather than a narrower local one, so the
     * `code` and `enableable` fields survive this boundary. Narrowing here
     * would drop exactly the AP-19 signal a UI needs to offer "enable stdio"
     * instead of "contact the package author".
     */
    readonly skipped: readonly SkippedMcpServer[];
}

/**
 * Derive a connection name from a package server.
 *
 * `mcp_server_connections.name` must match
 * `^[a-z0-9][a-z0-9-]{0,79}$` and is unique per user, while a package name is
 * a reverse-domain string and a server name can carry underscores. The derived
 * name therefore includes BOTH so two packages declaring `api` do not collide,
 * and is lower-cased and stripped to the permitted charset.
 *
 * Returns null when nothing usable survives, rather than inventing a name that
 * would silently point at the wrong server.
 */
export function connectionNameFor(packageName: string, serverName: string): string | null {
    const slug = `${packageName}-${serverName}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 80)
        .replace(/-+$/gu, '');

    return MCP_CONNECTION_NAME_PATTERN.test(slug) ? slug : null;
}

@Injectable()
export class PackageMcpReconcilerService {
    private readonly logger = new Logger(PackageMcpReconcilerService.name);

    constructor(
        private readonly resolver: McpServerConfigService,
        private readonly connections: McpServerConnectionRepository,
    ) {}

    /**
     * Make the connection rows for `userId` agree with what installed packages
     * declare.
     *
     * Idempotent: running it twice creates nothing the second time. It does
     * NOT delete connections for servers that have disappeared — a row may
     * carry an operator's binding and auth headers, and silently discarding
     * that because a directory was momentarily unreadable would be worse than
     * leaving a stale row that is visibly disabled.
     */
    async reconcile(userId: string): Promise<ReconcileResult> {
        const resolution = await this.resolver.resolveAll();
        const created: string[] = [];
        const unchanged: string[] = [];
        const updated: string[] = [];
        const skipped: SkippedMcpServer[] = [];

        if (!resolution.enabled) {
            return { created, unchanged, updated, skipped };
        }

        // Carry forward whatever the resolver already refused, so one report
        // explains every declared server rather than two half-reports.
        for (const entry of resolution.skipped) {
            skipped.push(entry);
        }

        for (const server of resolution.servers) {
            const outcome = await this.reconcileOne(userId, server);
            if (outcome.kind === 'skipped') {
                skipped.push({
                    name: server.name,
                    packageName: server.provenance.packageName,
                    reason: outcome.reason,
                    code: outcome.code,
                    enableable: outcome.enableable,
                });
                continue;
            }
            if (outcome.kind === 'created') created.push(outcome.name);
            else if (outcome.kind === 'updated') updated.push(outcome.name);
            else unchanged.push(outcome.name);
        }

        if (created.length > 0 || updated.length > 0) {
            this.logger.log(
                `Package MCP reconcile for ${userId}: ${created.length} created, ` +
                    `${updated.length} updated, ${unchanged.length} unchanged, ` +
                    `${skipped.length} skipped`,
            );
        }

        return { created, unchanged, updated, skipped };
    }

    private async reconcileOne(
        userId: string,
        server: ResolvedMcpServer,
    ): Promise<
        | { kind: 'created' | 'updated' | 'unchanged'; name: string }
        | { kind: 'skipped'; reason: string; code: SkippedMcpReason; enableable: boolean }
    > {
        if (!REMOTE_TRANSPORTS.has(server.transport)) {
            return {
                kind: 'skipped',
                reason:
                    `Transport "${server.transport}" cannot become a connection — a ` +
                    `connection row is URL-shaped. A stdio server is launched as a ` +
                    `subprocess and never becomes a connection at all.`,
                code: 'unsupported-transport',
                enableable: false,
            };
        }

        if (server.toolNamespace === null) {
            // The resolver already decided the name cannot be embedded in
            // `mcp__<server>__<tool>` without ambiguity; creating a connection
            // for it would produce tools nothing can address.
            return {
                kind: 'skipped',
                reason: `Server name "${server.name}" is not safe to use as a tool namespace.`,
                code: 'unsafe-namespace',
                enableable: false,
            };
        }

        const name = connectionNameFor(server.provenance.packageName, server.name);
        if (!name) {
            return {
                kind: 'skipped',
                reason:
                    `Could not derive a valid connection name from ` +
                    `"${server.provenance.packageName}" + "${server.name}".`,
                code: 'underivable-name',
                enableable: false,
            };
        }

        const url = (server.config as { url?: string }).url;
        if (!url) {
            return {
                kind: 'skipped',
                reason: 'Remote server declared no URL.',
                code: 'underivable-name',
                enableable: false,
            };
        }

        // The SAME lexical SSRF guard `McpConnectionsService.assertValidUrl`
        // applies to an operator-entered URL. Writing to the repository
        // directly bypasses that service, so the check has to be repeated
        // here — and a package URL deserves it more than an operator's does,
        // since nobody typed it. Without this a package could declare
        // `http://169.254.169.254/...` or a loopback address and have it
        // written into a connection row that looks ordinary; the row is
        // created disabled, but an operator enabling something plausible
        // would then point the client at a private address.
        if (!isSafeWebhookUrl(url)) {
            return {
                kind: 'skipped',
                reason:
                    `URL is not a public http(s) address — private, loopback, link-local ` +
                    `and cloud-metadata addresses are blocked.`,
                code: 'unsafe-url',
                enableable: false,
            };
        }

        const existing = await this.connections.findByUserAndName(userId, name);

        if (!existing) {
            await this.connections.create({
                userId,
                name,
                url,
                transport: server.transport as McpServerConnection['transport'],
                authHeaders: null,
                // Disabled, and with NO binding created. See the class
                // docstring: a package must not grant reach by arriving.
                enabled: false,
                source: 'package',
            });
            return { kind: 'created', name };
        }

        // Never touch a row a human created by hand. A package that happens to
        // derive the same name must not silently repoint a manual connection
        // at an address the operator did not choose.
        if (existing.source !== 'package') {
            return {
                kind: 'skipped',
                reason:
                    `A manually-created connection named "${name}" already exists; ` +
                    `refusing to overwrite it.`,
                code: 'name-taken',
                enableable: false,
            };
        }

        if (existing.url === url && existing.transport === server.transport) {
            return { kind: 'unchanged', name };
        }

        // The package changed where its server lives. Update the address, but
        // leave `enabled` and any bindings exactly as the operator set them —
        // a new URL is not a reason to re-authorise, nor to revoke.
        existing.url = url;
        existing.transport = server.transport as McpServerConnection['transport'];
        await this.connections.save(existing);
        return { kind: 'updated', name };
    }
}
