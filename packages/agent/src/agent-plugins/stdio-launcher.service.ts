import { Injectable, Logger } from '@nestjs/common';
import type { McpStdioServer } from '@ever-works/agent-plugins';
import type { McpStdioLaunch, McpStdioLauncher } from '../mcp/mcp-stdio-launcher';
import { McpServerConfigService } from './mcp-server-config.service';
import { AgentPluginStdioServerService } from './stdio-server.service';

/**
 * Implements `mcp/`'s `McpStdioLauncher` (AP-14): resolve a stdio server
 * declaration from an installed package and launch it with a client
 * attached.
 *
 * This adapter is the ONLY place the two halves meet, and it lives on the
 * `agent-plugins` side on purpose. `mcp/` owns the contract and knows
 * nothing about packages, install paths or launch policy; everything about
 * *what may run and from where* stays here, next to the resolver that
 * already enforces it.
 *
 * The declaration is re-resolved from disk at launch time rather than cached
 * at install time, so a package edited, updated or removed since then is
 * launched as it is NOW — or refused, which is the same answer the resolver
 * gives every other consumer.
 */
@Injectable()
export class AgentPluginStdioLauncherService implements McpStdioLauncher {
    private readonly logger = new Logger(AgentPluginStdioLauncherService.name);

    constructor(
        private readonly servers: McpServerConfigService,
        private readonly stdio: AgentPluginStdioServerService,
    ) {}

    async launch(request: {
        userId: string;
        packageName: string;
        serverName: string;
    }): Promise<McpStdioLaunch> {
        const resolved = await this.servers.resolveForPackage(request.packageName);
        const server = resolved.find((candidate) => candidate.name === request.serverName);

        if (!server) {
            // Covers three cases that are one answer: the package is gone, the
            // server was renamed or removed from `mcp.json`, or the resolver
            // refused it (policy, unsafe namespace, `${PLUGIN_DATA}` in a
            // remote entry). A connection row can outlive any of them.
            throw new Error(
                `MCP server "${request.serverName}" is not currently resolvable from package ` +
                    `"${request.packageName}".`,
            );
        }

        if (server.transport !== 'stdio' || server.config.type !== 'stdio') {
            // A row whose transport says stdio but whose package now declares
            // an HTTP server. Refused rather than dialled: the connection's
            // URL is the opaque `stdio:` pointer, so there is nothing to dial.
            throw new Error(
                `MCP server "${request.serverName}" from package "${request.packageName}" is no ` +
                    `longer a stdio server.`,
            );
        }

        const running = await this.stdio.launchClient({
            server: server.config satisfies McpStdioServer,
            packageRoot: server.provenance.packageRoot,
            userId: request.userId,
            packageName: request.packageName,
        });

        this.logger.log(
            `Launched stdio MCP server "${request.serverName}" from "${request.packageName}" ` +
                `for user ${request.userId}.`,
        );

        return { client: running.client, close: () => running.close() };
    }
}
