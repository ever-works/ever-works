import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { IJobRuntimeProvider, JobRunResult, PluginExecutionProfile } from '@ever-works/plugin';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginInstallerService } from './plugin-installer.service';
import { materializePlugin, resolvePluginOperation } from './plugin-operation.util';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';
import {
    JOB_RUNTIME_PROVIDER_REGISTRY,
    type JobRuntimeProviderRegistry,
} from '../../tasks/job-runtime.providers';
import {
    PLUGIN_OPERATION_DISPATCH_METHOD,
    type PluginOperationDispatch,
} from '../../tasks/plugin-operation-dispatch';

/** Default wall-clock wait: the task's 60-minute `maxDuration` plus queue time. */
const DEFAULT_WAIT_MS = 65 * 60 * 1000;
/** Default upper bound between result reads (reads back off from 1 s). */
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Consecutive `'unknown'` answers tolerated (a network blip) before giving up. */
const MAX_UNKNOWN_READS = 5;

/**
 * EW-693 / T25 — execution router (sync vs long-running).
 *
 * Decides whether a plugin operation executes **in-process** (short /
 * synchronous) or through the **job runtime** (long-running; the isolated
 * `run-plugin-operation` worker task). In order of precedence:
 *
 * 1. **An explicit profile on the call** (`dispatch(…, { profile })`) — the
 *    caller knows what it is asking for. Honoured in bundled AND dynamic mode.
 * 2. **The manifest hint** — the plugin author's
 *    `everworks.plugin.executionProfile` (`'sync' | 'long-running'`). Also
 *    honoured in both modes: an author who sets it has taken an action, which
 *    FR-22's "bundled deployments that take no action see no change" permits.
 * 3. **Bundled mode** — with no explicit profile, every call stays in-process.
 * 4. **Operation classification** (dynamic mode only) — a built-in taxonomy of
 *    operation names (`pipeline.run`, `*.long-running`, …).
 *
 * The long-running path goes through the platform's JOB RUNTIME, never a
 * vendor SDK imported here: the active provider's
 * `dispatchers.dispatchPluginOperation` starts the run and its
 * `getRunResult` reads the outcome back. (The previous lazy
 * `import('@trigger.dev/sdk')` did not resolve from this package, and waited on
 * `wait.forRunToComplete`, which SDK 4.5.11 does not have — so every
 * long-running call reported "empty result" while the real run kept going.)
 *
 * Two ways to use it:
 * - `dispatch()` / `dispatchLongRunning()` WAIT for the result (deadline,
 *   backoff, `AbortSignal`) — for background callers: other tasks, cron, CLI.
 * - `startLongRunning()` + `pollLongRunning()` — for HTTP callers, which must
 *   not block behind the 60 s ingress limit: start, answer with the run id,
 *   read the outcome once per poll.
 *
 * Result/error shape is unified across both paths (`PluginExecutionResult`).
 */
@Injectable()
export class PluginExecutionRouterService {
    private readonly logger = new Logger(PluginExecutionRouterService.name);
    private readonly distributionMode: 'bundled' | 'dynamic';

    /**
     * Test seam: when set, the long-running path uses this dispatcher instead
     * of the active job runtime.
     */
    private triggerDispatcher: TriggerDispatcher | null = null;

    constructor(
        @Inject(PLUGINS_MODULE_OPTIONS)
        options: PluginsModuleOptions,
        private readonly registry: PluginRegistryService,
        @Optional()
        private readonly installer?: PluginInstallerService,
        @Optional()
        @Inject(JOB_RUNTIME_PROVIDER_REGISTRY)
        private readonly jobRuntimes?: JobRuntimeProviderRegistry | null,
    ) {
        this.distributionMode = options.distributionMode ?? 'bundled';
    }

    /**
     * Test seam — replaces the job-runtime dispatcher.
     */
    setTriggerDispatcherForTests(impl: TriggerDispatcher | null): void {
        this.triggerDispatcher = impl;
    }

    /**
     * EW-693 / FR-17 — classification only. Pure function over the call's
     * profile, the manifest and the operation name, with the bundled-mode rule
     * applied (see the class docstring for the order).
     */
    route(pluginId: string, operation: string, options: RouteOptions = {}): RouteDecision {
        if (options.profile === 'long-running') {
            return { location: 'job-runtime', reason: 'caller:profile=long-running' };
        }
        if (options.profile === 'sync') {
            return { location: 'in-process', reason: 'caller:profile=sync' };
        }

        const manifestProfile = this.manifestProfileFor(pluginId);
        if (manifestProfile === 'long-running') {
            return { location: 'job-runtime', reason: 'manifest:executionProfile=long-running' };
        }
        if (manifestProfile === 'sync') {
            return { location: 'in-process', reason: 'manifest:executionProfile=sync' };
        }

        // With no explicit profile, bundled mode never hops to the job runtime
        // (FR-22): the plugin is statically loaded in every replica.
        if (this.distributionMode !== 'dynamic') {
            return { location: 'in-process', reason: 'bundled-mode' };
        }

        const operationProfile = classifyOperation(operation);
        if (operationProfile === 'long-running') {
            return { location: 'job-runtime', reason: `operation-taxonomy:${operation}` };
        }
        return { location: 'in-process', reason: `operation-taxonomy:${operation}` };
    }

    /**
     * Convenience dispatch — picks the runtime via {@link route} and returns
     * the unified {@link PluginExecutionResult}. On the long-running path it
     * WAITS for the run (see {@link dispatchLongRunning}); an HTTP caller uses
     * {@link startLongRunning} instead.
     */
    async dispatch<TResult = unknown>(
        pluginId: string,
        operation: string,
        args?: Record<string, unknown>,
        options: DispatchOptions = {},
    ): Promise<PluginExecutionResult<TResult>> {
        const decision = this.route(pluginId, operation, { profile: options.profile });

        if (decision.location === 'in-process') {
            return this.dispatchSync<TResult>(pluginId, operation, args);
        }
        return this.dispatchLongRunning<TResult>(pluginId, operation, args, options);
    }

    /**
     * In-process dispatch. Ensures the plugin is installed (no-op in bundled
     * mode), looks it up, loads it, and invokes the named operation — resolved
     * on the materialised plugin (`resolvePluginOperation`), because the
     * registry's lazy proxy answers a function for ANY name.
     */
    async dispatchSync<TResult = unknown>(
        pluginId: string,
        operation: string,
        args?: Record<string, unknown>,
    ): Promise<PluginExecutionResult<TResult>> {
        try {
            if (this.installer) {
                await this.installer.ensurePluginAvailable(pluginId);
            }
            const registered = this.registry.get(pluginId);
            if (!registered) {
                return {
                    ok: false,
                    location: 'in-process',
                    error: {
                        message: `Plugin "${pluginId}" not registered after ensurePluginAvailable.`,
                        code: 'PLUGIN_NOT_REGISTERED',
                    },
                };
            }
            const plugin = await materializePlugin(registered.plugin);
            const method = resolvePluginOperation(plugin, operation);
            if (!method) {
                return {
                    ok: false,
                    location: 'in-process',
                    error: {
                        message: `Plugin "${pluginId}" does not implement operation "${operation}".`,
                        code: 'OPERATION_NOT_FOUND',
                    },
                };
            }
            const result = (await method.call(plugin, args)) as TResult;
            return { ok: true, location: 'in-process', result };
        } catch (err) {
            return {
                ok: false,
                location: 'in-process',
                error: {
                    message: err instanceof Error ? err.message : String(err),
                    code: 'IN_PROCESS_THREW',
                },
            };
        }
    }

    /**
     * Long-running dispatch: start the `run-plugin-operation` worker task
     * through the active job runtime and WAIT for its outcome — at most
     * `options.timeoutMs` (default 65 minutes), reading back off from 1 s to
     * `options.pollIntervalMs`, stopping early on `options.signal`. Giving up
     * never cancels the run: the answer carries its `runId` so the caller can
     * keep reading it with {@link pollLongRunning}.
     */
    async dispatchLongRunning<TResult = unknown>(
        pluginId: string,
        operation: string,
        args?: Record<string, unknown>,
        options: LongRunningOptions = {},
    ): Promise<PluginExecutionResult<TResult>> {
        let runId: string | undefined;
        try {
            const dispatcher = this.triggerDispatcher ?? this.jobRuntimeDispatcher(options);
            if (!dispatcher) return jobRuntimeUnavailable();
            const handle = await dispatcher.trigger({ pluginId, operation, args });
            runId = typeof handle?.id === 'string' && handle.id ? handle.id : undefined;
            if (!runId) {
                return {
                    ok: false,
                    location: 'job-runtime',
                    error: {
                        message: 'The job runtime did not accept the run (it answered no run id).',
                        code: 'JOB_RUNTIME_DISPATCH_FAILED',
                    },
                };
            }
            const outcome = (await dispatcher.waitForResult(
                handle,
            )) as PluginExecutionTaskOutcome<TResult> | null;
            return fromTaskOutcome(outcome, runId);
        } catch (err) {
            return {
                ok: false,
                location: 'job-runtime',
                ...(runId ? { runId } : {}),
                error: {
                    message: err instanceof Error ? err.message : String(err),
                    code: 'JOB_RUNTIME_DISPATCH_FAILED',
                },
            };
        }
    }

    /**
     * Start a long-running operation WITHOUT waiting — for HTTP callers. Answers
     * `{ ok: true, runId }`, or the failure that prevented the start. Read the
     * outcome with {@link pollLongRunning}.
     */
    async startLongRunning(
        pluginId: string,
        operation: string,
        args?: Record<string, unknown>,
    ): Promise<
        { ok: true; location: 'job-runtime'; runId: string } | PluginExecutionResult<never>
    > {
        const provider = this.activeProvider();
        const dispatch = provider ? dispatchMethodOf(provider) : null;
        if (!provider || !dispatch) return jobRuntimeUnavailable();
        try {
            const runId = await dispatch({ pluginId, operation, args });
            if (!runId) {
                return {
                    ok: false,
                    location: 'job-runtime',
                    error: {
                        message: 'The job runtime did not accept the run (it answered no run id).',
                        code: 'JOB_RUNTIME_DISPATCH_FAILED',
                    },
                };
            }
            return { ok: true, location: 'job-runtime', runId };
        } catch (err) {
            return {
                ok: false,
                location: 'job-runtime',
                error: {
                    message: err instanceof Error ? err.message : String(err),
                    code: 'JOB_RUNTIME_DISPATCH_FAILED',
                },
            };
        }
    }

    /**
     * ONE read of a long-running run started earlier: `{ done: false }` while it
     * is queued or running, else the final {@link PluginExecutionResult}.
     */
    async pollLongRunning<TResult = unknown>(runId: string): Promise<LongRunningPoll<TResult>> {
        const provider = this.activeProvider();
        if (!provider || typeof provider.getRunResult !== 'function') {
            return { done: true, runId, result: { ...jobRuntimeUnavailable(), runId } };
        }
        const read = await readRunResult(provider, runId);
        if (read.status === 'queued' || read.status === 'running' || read.status === 'unknown') {
            return { done: false, runId, status: read.status };
        }
        return {
            done: true,
            runId,
            result: fromTaskOutcome(outcomeOf<TResult>(read, runId), runId),
        };
    }

    /**
     * Pull the manifest's executionProfile for the plugin id (null when not
     * set / not registered). Used by {@link route}.
     */
    private manifestProfileFor(pluginId: string): PluginExecutionProfile | null {
        const registered = this.registry.get(pluginId);
        const profile = registered?.manifest?.executionProfile;
        if (profile === 'sync' || profile === 'long-running') return profile;
        return null;
    }

    private activeProvider(): IJobRuntimeProvider | null {
        try {
            return this.jobRuntimes?.getActive() ?? null;
        } catch {
            return null;
        }
    }

    /**
     * The default long-running dispatcher: the active job runtime's
     * `dispatchPluginOperation` to start the run, its `getRunResult` to wait.
     * `null` when no runtime is active or it cannot do request/response work.
     */
    private jobRuntimeDispatcher(options: LongRunningOptions): TriggerDispatcher | null {
        const provider = this.activeProvider();
        const dispatch = provider ? dispatchMethodOf(provider) : null;
        if (!provider || !dispatch || typeof provider.getRunResult !== 'function') return null;
        return {
            trigger: async (payload) => {
                const runId = await dispatch(payload);
                return runId ? { id: runId } : {};
            },
            waitForResult: (handle) => this.awaitRunOutcome(provider, String(handle.id), options),
        };
    }

    /** Read `runId` until it settles, the deadline passes, or the signal aborts. */
    private async awaitRunOutcome(
        provider: IJobRuntimeProvider,
        runId: string,
        options: LongRunningOptions,
    ): Promise<PluginExecutionTaskOutcome> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
        const maxInterval = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        const deadline = Date.now() + timeoutMs;
        let interval = Math.min(1_000, maxInterval);
        let unknownReads = 0;

        for (;;) {
            if (options.signal?.aborted) {
                return taskFailure(
                    'JOB_RUNTIME_WAIT_ABORTED',
                    `Stopped waiting for run ${runId}; the run itself was not cancelled.`,
                );
            }
            const read = await readRunResult(provider, runId);
            if (read.status === 'unknown') {
                unknownReads += 1;
                if (unknownReads >= MAX_UNKNOWN_READS) {
                    return taskFailure(
                        'JOB_RUNTIME_FAILED',
                        `Run ${runId} could not be read from the job runtime.`,
                    );
                }
            } else if (read.status !== 'queued' && read.status !== 'running') {
                return outcomeOf(read, runId);
            } else {
                unknownReads = 0;
            }
            if (Date.now() + interval > deadline) {
                this.logger.warn(
                    `Stopped waiting for plugin operation run ${runId} after ${timeoutMs} ms.`,
                );
                return taskFailure(
                    'JOB_RUNTIME_WAIT_TIMEOUT',
                    `Run ${runId} did not finish within ${timeoutMs} ms. It was NOT cancelled; read it again later.`,
                );
            }
            await sleep(interval, options.signal);
            interval = Math.min(maxInterval, interval * 2);
        }
    }
}

// ─── helpers / types ─────────────────────────────────────────────────

function dispatchMethodOf(provider: IJobRuntimeProvider): PluginOperationDispatch | null {
    const dispatchers = provider.dispatchers as unknown as Record<string, unknown> | undefined;
    const dispatch = dispatchers?.[PLUGIN_OPERATION_DISPATCH_METHOD];
    if (typeof dispatch !== 'function') return null;
    return (payload) => (dispatch as PluginOperationDispatch).call(dispatchers, payload);
}

/** `getRunResult`, never throwing — a throw is an `'unknown'` read. */
async function readRunResult(provider: IJobRuntimeProvider, runId: string): Promise<JobRunResult> {
    try {
        return (await provider.getRunResult!(runId)) ?? { status: 'unknown' };
    } catch {
        return { status: 'unknown' };
    }
}

/** A settled read as the task's envelope: its own output when completed, else a failure. */
function outcomeOf<TResult = unknown>(
    read: JobRunResult,
    runId: string,
): PluginExecutionTaskOutcome<TResult> {
    if (read.status === 'completed') {
        return isTaskOutcome(read.output)
            ? (read.output as PluginExecutionTaskOutcome<TResult>)
            : taskFailure(
                  'JOB_RUNTIME_FAILED',
                  `Run ${runId} completed without a result envelope.`,
              );
    }
    if (read.status === 'cancelled') {
        return taskFailure(
            'JOB_RUNTIME_CANCELLED',
            read.error?.message ?? `Run ${runId} was cancelled.`,
        );
    }
    return taskFailure('JOB_RUNTIME_FAILED', read.error?.message ?? `Run ${runId} failed.`);
}

function isTaskOutcome(value: unknown): value is PluginExecutionTaskOutcome {
    return (
        !!value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean'
    );
}

function taskFailure(code: string, message: string): PluginExecutionTaskOutcome<never> {
    return { ok: false, error: { code, message } };
}

function fromTaskOutcome<TResult>(
    outcome: PluginExecutionTaskOutcome<TResult> | null | undefined,
    runId: string,
): PluginExecutionResult<TResult> {
    if (outcome?.ok) {
        return { ok: true, location: 'job-runtime', runId, result: outcome.result };
    }
    return {
        ok: false,
        location: 'job-runtime',
        runId,
        error: {
            message: outcome?.error?.message ?? 'The job runtime returned an empty result',
            code: outcome?.error?.code ?? 'JOB_RUNTIME_FAILED',
        },
    };
}

function jobRuntimeUnavailable(): PluginExecutionResult<never> {
    return {
        ok: false,
        location: 'job-runtime',
        error: {
            message:
                'No job runtime that can run long-running plugin operations is active ' +
                '(none registered, or it has no dispatchPluginOperation / getRunResult).',
            code: 'JOB_RUNTIME_UNAVAILABLE',
        },
    };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}

/**
 * Built-in operation taxonomy (T25) — consulted in DYNAMIC mode only, when the
 * call and the manifest name no profile. Unknown operations default to `sync`.
 *
 * Suffix wildcards: any operation ending with `.long-running`, `.deploy`,
 * `.generate` or `.run-pipeline` is treated as long-running. (These dotted names
 * are never plugin method names, so a call routed by them alone answers
 * OPERATION_NOT_FOUND in the worker; an explicit profile is the reliable way.)
 */
export function classifyOperation(operation: string): PluginExecutionProfile {
    if (!operation) return 'sync';
    const lower = operation.toLowerCase();

    const exact: Record<string, PluginExecutionProfile> = {
        'pipeline.run': 'long-running',
        'deploy.deploy': 'long-running',
        'generation.run': 'long-running',
        'generation.generate': 'long-running',
        'work.generate': 'long-running',
        'work.import': 'long-running',
    };
    if (exact[lower] !== undefined) return exact[lower];

    if (
        lower.endsWith('.long-running') ||
        lower.endsWith('.deploy') ||
        lower.endsWith('.generate') ||
        lower.endsWith('.run-pipeline')
    ) {
        return 'long-running';
    }

    return 'sync';
}

export interface RouteOptions {
    /** An explicit execution profile for this call — honoured in bundled AND dynamic mode. */
    readonly profile?: PluginExecutionProfile;
}

export interface LongRunningOptions {
    /** Wall-clock budget for waiting on the run; default 65 minutes. */
    readonly timeoutMs?: number;
    /** Upper bound between result reads; default 5 000 ms (reads back off from 1 s). */
    readonly pollIntervalMs?: number;
    /** Stop waiting early (the run is NOT cancelled). */
    readonly signal?: AbortSignal;
}

export interface DispatchOptions extends RouteOptions, LongRunningOptions {}

export interface RouteDecision {
    readonly location: 'in-process' | 'job-runtime';
    /** Human-readable explanation pinned in metrics / activity log. */
    readonly reason: string;
}

export interface PluginExecutionResult<TResult = unknown> {
    readonly ok: boolean;
    readonly location: 'in-process' | 'job-runtime';
    /** The job-runtime run id — keep it to read the run again later. */
    readonly runId?: string;
    readonly result?: TResult;
    readonly error?: {
        readonly message: string;
        readonly code: string;
    };
}

/** One {@link PluginExecutionRouterService.pollLongRunning} read. */
export type LongRunningPoll<TResult = unknown> =
    | {
          readonly done: false;
          readonly runId: string;
          readonly status: 'queued' | 'running' | 'unknown';
      }
    | {
          readonly done: true;
          readonly runId: string;
          readonly result: PluginExecutionResult<TResult>;
      };

/**
 * Wire-shape the worker task returns to the router. Matches the
 * {@link PluginExecutionResult} shape so the router can forward it verbatim.
 */
export interface PluginExecutionTaskOutcome<TResult = unknown> {
    readonly ok: boolean;
    readonly result?: TResult;
    readonly error?: { readonly message: string; readonly code: string };
}

export interface TriggerDispatchPayload {
    readonly pluginId: string;
    readonly operation: string;
    readonly args?: Record<string, unknown>;
}

/** The long-running dispatcher seam: start a run, then wait for its outcome. */
export interface TriggerDispatcher {
    trigger(payload: TriggerDispatchPayload): Promise<{ id?: string } & Record<string, unknown>>;
    waitForResult(handle: { id?: string } & Record<string, unknown>): Promise<unknown>;
}
