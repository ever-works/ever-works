import { Injectable, Logger } from '@nestjs/common';
import type { McpStdioServer } from '@ever-works/agent-plugins';
import { config } from '../config';
import { AgentPluginPackageDataDirService } from './package-data-dir.service';
import { buildLaunchPlan, LaunchRefused, type LaunchPlan } from './stdio-launcher';

/**
 * Spawns a package-declared stdio MCP server (T30, second half).
 *
 * `stdio-launcher.ts` decides *what* would run; this decides *whether*, and
 * then actually runs it. Keeping the two apart means every rule about
 * environments, binaries and working directories is unit-tested against
 * plain values, and this file is only about the gate, the lifecycle and the
 * teardown.
 *
 * ## The gate is checked HERE as well as in the resolver
 *
 * `McpServerConfigService` already refuses to resolve a stdio server when
 * `AGENT_PLUGINS_STDIO` is off, so in practice nothing reaches this method
 * with the gate closed. It is checked again anyway, because this is the
 * function that actually spawns a process: a future caller that obtains a
 * server declaration by some other route would otherwise bypass the only
 * thing standing between a package and execution. A gate that lives at one
 * call site is a gate that the next call site forgets.
 */

/** Subset of the SDK transport this service constructs, so tests need no SDK. */
export interface StdioTransportFactory {
    create(params: {
        command: string;
        args: string[];
        env: Record<string, string>;
        cwd: string;
        stderr: 'pipe';
    }): Promise<{ close(): Promise<void> }>;
}

export interface StdioLaunchRequest {
    readonly server: McpStdioServer;
    readonly packageRoot: string;
    readonly userId: string;
    readonly packageName: string;
}

export interface RunningStdioServer {
    readonly plan: LaunchPlan;
    close(): Promise<void>;
}

@Injectable()
export class AgentPluginStdioServerService {
    private readonly logger = new Logger(AgentPluginStdioServerService.name);
    private factory: StdioTransportFactory | null = null;

    /** Every process this service has started, so teardown can be exhaustive. */
    private readonly running = new Set<{ close(): Promise<void> }>();

    constructor(private readonly dataDirs: AgentPluginPackageDataDirService) {}

    /** Test seam, mirroring the pacote and isomorphic-git injection points. */
    setTransportFactory(factory: StdioTransportFactory): void {
        this.factory = factory;
    }

    async launch(request: StdioLaunchRequest): Promise<RunningStdioServer> {
        if (!config.agentPlugins.isStdioEnabled()) {
            throw new LaunchRefused(
                'Stdio servers are disabled by policy on this deployment ' +
                    '(AGENT_PLUGINS_STDIO).',
                'disabled-by-policy',
            );
        }

        // The data directory is created HERE rather than at install: a
        // directory created at install is missing on every replica that did
        // not perform it, and on any replica whose volume was recreated.
        const pluginData = await this.dataDirs.ensure({
            userId: request.userId,
            packageName: request.packageName,
        });

        const plan = await buildLaunchPlan(request.server, {
            packageRoot: request.packageRoot,
            pluginData,
        });

        const factory = await this.getFactory();
        const transport = await factory.create({
            command: plan.command,
            args: [...plan.args],
            env: { ...plan.env },
            cwd: plan.cwd,
            // NOT 'inherit', which is the SDK default. A package's stderr
            // would otherwise be written straight into the API's own log
            // stream, where it is indistinguishable from platform output and
            // can forge log lines.
            stderr: 'pipe',
        });

        this.running.add(transport);
        this.logger.log(
            `Launched stdio server for package "${request.packageName}" ` +
                `(${plan.resolvesThroughPath ? 'PATH' : 'package-local'}: ${plan.command})`,
        );

        return {
            plan,
            close: async () => {
                this.running.delete(transport);
                await transport.close().catch((err: unknown) => {
                    this.logger.warn(
                        `Failed to close stdio server for "${request.packageName}": ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                });
            },
        };
    }

    /**
     * Stop every process this service started.
     *
     * Called at run end. Failures are swallowed per process so that one
     * unresponsive server cannot strand the others — a half-completed
     * teardown leaks processes for the lifetime of the pod, which is worse
     * than a noisy log line.
     */
    async shutdownAll(): Promise<{ stopped: number; failed: number }> {
        const transports = [...this.running];
        this.running.clear();

        const results = await Promise.allSettled(transports.map((t) => t.close()));
        const failed = results.filter((r) => r.status === 'rejected').length;

        if (failed > 0) {
            this.logger.warn(`${failed} stdio server(s) did not shut down cleanly.`);
        }
        return { stopped: results.length - failed, failed };
    }

    private async getFactory(): Promise<StdioTransportFactory> {
        if (this.factory) return this.factory;

        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

        this.factory = {
            async create(params) {
                const transport = new StdioClientTransport(params);
                await transport.start();
                return transport as unknown as { close(): Promise<void> };
            },
        };
        return this.factory;
    }
}
