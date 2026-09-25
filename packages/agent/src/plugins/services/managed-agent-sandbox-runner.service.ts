import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SandboxSessionInput, SandboxSessionResult } from '@ever-works/plugin';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';
import {
    PluginExecutionRouterService,
    type LongRunningCancel,
    type LongRunningPoll,
    type PluginExecutionResult,
} from './plugin-execution-router.service';

/**
 * The operation it calls — the pipeline contract's `runSandboxSession`
 * (`IPipelinePlugin`, APW-04 T1). A plugin must declare it in its
 * `everworks.plugin.operations` (long-running) for the router to call it by
 * name on either path.
 */
export const SANDBOX_SESSION_OPERATION = 'runSandboxSession';

/** Where a sandbox session runs. */
export type SandboxSessionLocation = 'in-process' | 'job-runtime';

/** Which tenant a session is for — the Work's (`work.tenantId`). */
export interface SandboxSessionTenantOptions {
    /**
     * The Work's tenant. On the job-runtime path the run is started, read and
     * cancelled through that tenant's view of the runtime (a BYO tenant's own
     * project). Keep it next to the run id. Absent / `null` = the platform
     * runtime. Not used in-process.
     */
    readonly tenantId?: string | null;
}

/** Options for {@link ManagedAgentSandboxRunnerService.start}. */
export interface SandboxSessionStartOptions extends SandboxSessionTenantOptions {
    /**
     * In-process it is the plugin's own signal, exactly as for
     * {@link ManagedAgentSandboxRunnerService.run}. On the job-runtime path a
     * signal that is already aborted starts nothing, and one aborted while the
     * run is being started cancels that run. Once `start()` has answered, the
     * signal is no longer watched: stop the run with
     * {@link ManagedAgentSandboxRunnerService.cancel}.
     */
    readonly signal?: AbortSignal;
}

export interface SandboxSessionRunOptions extends SandboxSessionTenantOptions {
    /**
     * Stops the session. In-process it is the plugin's own signal
     * (`runSandboxSession(input, signal)`), which ends the session and tears
     * its resources down. On the job-runtime path it stops the wait AND
     * cancels the run (`cancelLongRunning`); a signal that is already aborted
     * starts nothing.
     */
    readonly signal?: AbortSignal;
    /**
     * Job-runtime path only: how long to wait for the run (the router's
     * default is the run's whole lifetime). Passing it does NOT cancel the
     * run — the answer carries the run id; keep reading it with {@link poll}.
     */
    readonly timeoutMs?: number;
    /** Job-runtime path only: the upper bound between reads. */
    readonly pollIntervalMs?: number;
}

/** What {@link ManagedAgentSandboxRunnerService.start} answers. */
export type SandboxSessionStart =
    | { readonly ok: true; readonly location: 'job-runtime'; readonly runId: string }
    | PluginExecutionResult<SandboxSessionResult>;

/**
 * EW-693 T26 (owner decision 2026-09-25) — the execution router's first
 * LONG-RUNNING caller: one restricted-network sandbox session
 * (`runSandboxSession`, APW-04 plan §2.6) on a pipeline plugin, started, read,
 * waited on and cancelled through the router.
 *
 * WHICH plugin is the CALLER's choice, passed as `pluginId` on every
 * {@link run} / {@link start} — this runner names none (Constitution
 * Principle II). The pipeline contract says a consumer selects the pipeline by
 * `enforcesRuntimeNetworking` plus a `runSandboxSession` it implements, never
 * by plugin id; APW-04 T48's session runner does that selection (the first
 * ENABLED such pipeline with resolvable settings) and then hands the id it
 * selected to this runner. The plugin must also declare `runSandboxSession`
 * in `everworks.plugin.operations`, or the router refuses the call on either
 * path.
 *
 * WHERE it runs is configuration — `PluginsModuleOptions.sandboxSessionsViaJobRuntime`
 * (`PLUGIN_SANDBOX_SESSIONS_VIA_JOB_RUNTIME` on the API):
 *
 * - **off (default)** — in THIS process, through the plugin
 *   (`router.dispatchSync` with an explicit in-process call and the caller's
 *   signal). That is what a direct `plugin.runSandboxSession(input, signal)`
 *   does, so turning nothing on changes nothing.
 * - **on** — in the `run-plugin-operation` worker task, through the job
 *   runtime: `startLongRunning` / `pollLongRunning` / `cancelLongRunning`
 *   (and `dispatchLongRunning` to wait), with the Work's tenant. The input
 *   crosses the boundary unchanged: `SandboxSessionInput` is data-only by
 *   contract and carries no credential (the plugin resolves its own settings
 *   from `userId` / `workId`), so the job runtime's run record holds no secret.
 *
 * Either way the answer is the router's unified `PluginExecutionResult`, whose
 * `result` is the plugin's `SandboxSessionResult`. {@link poll} and
 * {@link cancel} always go to the job runtime — a run started before the
 * switch was turned off stays readable and cancellable.
 */
@Injectable()
export class ManagedAgentSandboxRunnerService {
    private readonly logger = new Logger(ManagedAgentSandboxRunnerService.name);
    private readonly viaJobRuntime: boolean;

    constructor(
        @Inject(PLUGINS_MODULE_OPTIONS)
        options: PluginsModuleOptions,
        private readonly router: PluginExecutionRouterService,
    ) {
        this.viaJobRuntime = options?.sandboxSessionsViaJobRuntime === true;
    }

    /** Where {@link run} and {@link start} run a session on this process. */
    location(): SandboxSessionLocation {
        return this.viaJobRuntime ? 'job-runtime' : 'in-process';
    }

    /**
     * Run ONE session on `pluginId` — the pipeline plugin the caller selected
     * — and wait for its terminal state. For background callers (tasks,
     * cron); an HTTP caller that must not block uses {@link start} +
     * {@link poll}.
     */
    async run(
        pluginId: string,
        input: SandboxSessionInput,
        options: SandboxSessionRunOptions = {},
    ): Promise<PluginExecutionResult<SandboxSessionResult>> {
        if (!this.viaJobRuntime) {
            return this.router.dispatchSync<SandboxSessionResult>(
                pluginId,
                SANDBOX_SESSION_OPERATION,
                asArgs(input),
                options.signal ? { signal: options.signal } : {},
            );
        }

        if (options.signal?.aborted) return abortedBeforeStart();
        const result = await this.router.dispatchLongRunning<SandboxSessionResult>(
            pluginId,
            SANDBOX_SESSION_OPERATION,
            asArgs(input),
            {
                tenantId: options.tenantId,
                signal: options.signal,
                timeoutMs: options.timeoutMs,
                pollIntervalMs: options.pollIntervalMs,
            },
        );
        // The caller's signal stops an in-process session; on this path the
        // router only stopped WAITING, so stop the run too.
        if (!result.ok && result.error?.code === 'JOB_RUNTIME_WAIT_ABORTED' && result.runId) {
            await this.cancelAborted(result.runId, options.tenantId);
        }
        return result;
    }

    /**
     * Start ONE session on `pluginId` — the pipeline plugin the caller
     * selected — without waiting. On the job-runtime path this answers
     * `{ ok: true, location: 'job-runtime', runId }` (read it with
     * {@link poll}, passing the same `tenantId`). In-process there is no run
     * to read: the session runs to completion here and its result is
     * answered, exactly as {@link run} would.
     */
    async start(
        pluginId: string,
        input: SandboxSessionInput,
        options: SandboxSessionStartOptions = {},
    ): Promise<SandboxSessionStart> {
        if (!this.viaJobRuntime) {
            return this.run(pluginId, input, { signal: options.signal });
        }

        if (options.signal?.aborted) return abortedBeforeStart();
        const started = await this.router.startLongRunning(
            pluginId,
            SANDBOX_SESSION_OPERATION,
            asArgs(input),
            { tenantId: options.tenantId },
        );
        // Aborted while the run was being started: the caller has given up on
        // it, so do not leave it running.
        if (started.ok && started.runId && options.signal?.aborted) {
            await this.cancelAborted(started.runId, options.tenantId);
            return {
                ok: false,
                location: 'job-runtime',
                runId: started.runId,
                error: {
                    code: 'JOB_RUNTIME_WAIT_ABORTED',
                    message:
                        'Aborted while the sandbox session was being started; its run was cancelled.',
                },
            };
        }
        return started;
    }

    /** ONE read of a session run started by {@link start}. */
    poll(
        runId: string,
        options: SandboxSessionTenantOptions = {},
    ): Promise<LongRunningPoll<SandboxSessionResult>> {
        return this.router.pollLongRunning<SandboxSessionResult>(runId, {
            tenantId: options.tenantId,
        });
    }

    /**
     * Cancel a session run started by {@link start}. The worker task is
     * stopped by the job runtime; see the router's `cancelLongRunning`.
     */
    cancel(runId: string, options: SandboxSessionTenantOptions = {}): Promise<LongRunningCancel> {
        return this.router.cancelLongRunning(runId, { tenantId: options.tenantId });
    }

    /** Cancel a run whose caller aborted; a cancel not confirmed is logged. */
    private async cancelAborted(runId: string, tenantId?: string | null): Promise<void> {
        const cancel = await this.cancel(runId, { tenantId });
        // `in` checks, not `cancel.ok`: this package builds without
        // strictNullChecks, where the boolean discriminant does not narrow.
        const why =
            'error' in cancel
                ? cancel.error.message
                : 'cancelled' in cancel && !cancel.cancelled
                  ? 'the runtime did not know the run, or it had ended'
                  : null;
        if (why) {
            this.logger.warn(
                `Sandbox session run ${runId} was aborted, but its cancel was not confirmed (${why}).`,
            );
        }
    }
}

/** The answer when the caller's signal was aborted before anything started. */
function abortedBeforeStart(): PluginExecutionResult<never> {
    return {
        ok: false,
        location: 'job-runtime',
        error: {
            code: 'JOB_RUNTIME_WAIT_ABORTED',
            message: 'Aborted before the sandbox session was started; nothing was dispatched.',
        },
    };
}

/** The input as the router's `args` — it crosses the RPC boundary unchanged. */
function asArgs(input: SandboxSessionInput): Record<string, unknown> {
    return input as unknown as Record<string, unknown>;
}
