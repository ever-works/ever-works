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

    /**
     * Bumped by every `shutdownAll`.
     *
     * `factory.create()` is asynchronous, so a shutdown can snapshot the
     * running set while a launch is still in flight; the transport would then
     * be added AFTER teardown and never closed, leaking a process for the
     * lifetime of the pod.
     *
     * A COUNTER rather than a boolean, because a boolean has to be cleared at
     * the end of `shutdownAll` for the service to stay reusable — and a launch
     * whose `create()` resolves after that point would see it already false
     * and register into a set that had been emptied. The generation a launch
     * captured cannot be un-changed, so the comparison holds however the two
     * interleave.
     */
    private shutdownGeneration = 0;

    constructor(private readonly dataDirs: AgentPluginPackageDataDirService) {}

    /** Test seam, mirroring the pacote and isomorphic-git injection points. */
    setTransportFactory(factory: StdioTransportFactory): void {
        this.factory = factory;
    }

    async launch(request: StdioLaunchRequest): Promise<RunningStdioServer> {
        // Captured FIRST, before any await. This is the generation the caller
        // launched into; capturing it later would miss a shutdown that ran
        // while the data directory or the launch plan was still being
        // prepared, and those are awaits too.
        const generation = this.shutdownGeneration;

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

        if (this.shutdownGeneration !== generation) {
            // A teardown ran while this process was starting. Close it here
            // rather than registering it: that shutdown already took its
            // snapshot and will never see this transport.
            await transport.close().catch(() => undefined);
            throw new LaunchRefused(
                'Shutdown began while this server was starting; it was stopped again.',
                'shutting-down',
            );
        }

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
        // Bumped BEFORE the snapshot, so a launch that completes during
        // teardown sees a different generation and closes itself rather than
        // registering into a set nobody will read again.
        this.shutdownGeneration += 1;
        const transports = [...this.running];
        this.running.clear();

        const results = await Promise.allSettled(transports.map((t) => t.close()));
        const failed = results.filter((r) => r.status === 'rejected').length;

        if (failed > 0) {
            this.logger.warn(`${failed} stdio server(s) did not shut down cleanly.`);
        }

        // Nothing to reset: the next launch captures the NEW generation and
        // matches it, so the service is reusable without a window in which a
        // late transport can slip through.
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
