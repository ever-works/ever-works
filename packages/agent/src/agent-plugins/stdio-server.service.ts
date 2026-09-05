import { Injectable, Logger } from '@nestjs/common';
import type { McpStdioServer } from '@ever-works/agent-plugins';
import { config } from '../config';
import { AgentPluginPackageDataDirService } from './package-data-dir.service';
import { buildLaunchPlan, LaunchRefused, type LaunchPlan } from './stdio-launcher';
import { createStdioSdkClient } from '../mcp/mcp-sdk';
import type { McpSdkClient } from '../mcp/mcp-sdk';

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

/** A launched server plus the client that owns it (AP-14). */
export interface RunningStdioClient extends RunningStdioServer {
    readonly client: McpSdkClient;
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
     * **Nothing calls this yet, and nothing calls `launch` either.** This said
     * "Called at run end", which was not true — the same dead-seam claim this
     * programme has criticised elsewhere, written into a docstring where it
     * would be believed.
     *
     * It matters to whoever finishes AP-14: `launch` and `shutdownAll` have to
     * be wired in the SAME change. Wiring only the spawn leaks one subprocess
     * per run for the lifetime of the pod, and the leak is invisible until the
     * pod is OOM-killed. The generation counter makes the pair safe to
     * interleave; it does not make either safe to omit.
     *
     * Failures are swallowed per process so that one unresponsive server
     * cannot strand the others — a half-completed teardown leaks processes,
     * which is worse than a noisy log line.
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

    /**
     * Launch a server AND connect a client to it (AP-14).
     *
     * The sibling of `launch()` for the tool path: same policy gate, same
     * data directory, same launch plan and the same shutdown-generation
     * race guard — the difference is who starts the transport. `launch()`
     * starts it standalone; here the SDK client does, because it must
     * (`createStdioSdkClient` documents why). Both register into the same
     * `running` set, so `shutdownAll` on module destroy still stops every
     * subprocess this service ever spawned, whoever is holding it.
     */
    async launchClient(request: StdioLaunchRequest): Promise<RunningStdioClient> {
        const generation = this.shutdownGeneration;

        if (!config.agentPlugins.isStdioEnabled()) {
            throw new LaunchRefused(
                'Stdio servers are disabled by policy on this deployment ' +
                    '(AGENT_PLUGINS_STDIO).',
                'disabled-by-policy',
            );
        }

        const pluginData = await this.dataDirs.ensure({
            userId: request.userId,
            packageName: request.packageName,
        });
        const plan = await buildLaunchPlan(request.server, {
            packageRoot: request.packageRoot,
            pluginData,
        });

        const launched = await this.connect({
            command: plan.command,
            args: [...plan.args],
            env: { ...plan.env },
            cwd: plan.cwd,
        });

        if (this.shutdownGeneration !== generation) {
            await launched.close().catch(() => undefined);
            throw new LaunchRefused(
                'Shutdown began while this server was starting; it was stopped again.',
                'shutting-down',
            );
        }

        const handle = { close: () => launched.close() };
        this.running.add(handle);
        this.logger.log(
            `Launched stdio server (client) for package "${request.packageName}" ` +
                `(${plan.resolvesThroughPath ? 'PATH' : 'package-local'}: ${plan.command})`,
        );

        return {
            plan,
            client: launched.client,
            close: async () => {
                this.running.delete(handle);
                await launched.close().catch((err: unknown) => {
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
     * Seam for the spec: the real path spawns a child process, so the tests
     * that are about the GATE and the LIFECYCLE substitute this rather than
     * shelling out. `createStdioSdkClient` itself is exercised against a real
     * child in its own spec — the lesson from the two hangs this epic already
     * shipped is that a seam every test stubs is a seam nothing runs.
     */
    protected connect(params: {
        command: string;
        args: string[];
        env: Record<string, string>;
        cwd: string;
    }): Promise<{ client: McpSdkClient; close(): Promise<void> }> {
        return createStdioSdkClient(params);
    }

    private async getFactory(): Promise<StdioTransportFactory> {
        if (this.factory) return this.factory;
        this.factory = await createStdioTransportFactory();
        return this.factory;
    }
}

/**
 * The factory that actually spawns.
 *
 * Exported, and not inlined into `getFactory`, because it was previously
 * unreachable from any test: every spec injects a fake factory, so the one
 * function that starts a real process ran nowhere. That is the same shape that
 * hid the `pinnedFetch` deadlock, and it hid a second one here.
 */
export async function createStdioTransportFactory(): Promise<StdioTransportFactory> {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    return {
        async create(params) {
            const transport = new StdioClientTransport(params);

            // MANDATORY, not hygiene. `stderr: 'pipe'` keeps a package's output
            // out of the platform's log stream — the whole reason it is not
            // 'inherit' — but the SDK only pipes the child's stderr into a
            // PassThrough and hands it over; nothing reads it. Once roughly
            // 80 KB accumulates (a 16 KB PassThrough plus the ~64 KB OS pipe)
            // backpressure stalls the CHILD mid-write, and an MCP server frozen
            // inside a write to stderr stops answering entirely.
            //
            // Measured against the real SDK: 10 bytes of stderr completes,
            // 200 KB never does, and 200 KB with this line completes. Exactly
            // the size-dependent stealth that let it past review — a chatty
            // debug log is enough to reach it, and nothing looks wrong until a
            // server silently stops responding.
            //
            // `resume()` discards rather than captures. That is deliberate:
            // retaining package stderr would mean either putting attacker-
            // controlled text into our logs (the risk 'pipe' exists to avoid)
            // or building a buffer nothing reads, which is a dead seam.
            // `.on('data')` rather than `.resume()`: the SDK types this as the
            // base `Stream`, which has no `resume`, and attaching a data
            // listener puts the readable into flowing mode — the same drain
            // without an `as` cast over the SDK's own typing.
            transport.stderr?.on('data', () => undefined);

            // AFTER the drain, not before. The SDK builds the stderr
            // PassThrough in the transport's CONSTRUCTOR and exposes it
            // immediately, "allowing callers to attach listeners before the
            // start method is invoked". Starting first leaves a window in
            // which a server that logs on startup blocks mid-write before
            // anything is reading — the identical stall, just harder to hit.
            // Found while writing the AP-14 client path, where the window is
            // not small: draining after `Client.connect()` deadlocks outright,
            // because the child must read `initialize` to let connect resolve.
            await transport.start();

            return transport as unknown as { close(): Promise<void> };
        },
    };
}
