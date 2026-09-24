import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { IJobRuntimeProvider, JobRunResult, PluginExecutionProfile } from '@ever-works/plugin';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginInstallerService } from './plugin-installer.service';
import {
    declaredOperationProfile,
    describeMissingOperation,
    materializePlugin,
    pluginLoadFailure,
    resolvePluginOperation,
} from './plugin-operation.util';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';
import {
    JOB_RUNTIME_PROVIDER_REGISTRY,
    type JobRuntimeProviderRegistry,
} from '../../tasks/job-runtime.providers';
import {
    PLUGIN_OPERATION_DEFAULT_WAIT_MS,
    PLUGIN_OPERATION_DISPATCH_METHOD,
    type PluginOperationDispatch,
} from '../../tasks/plugin-operation-dispatch';

/** Default upper bound between result reads (reads back off from 1 s). */
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/**
 * The floor for `pollIntervalMs`: a caller passing 0 (or a mis-parsed value)
 * must not read the job runtime hundreds of times a second for an hour.
 */
const MIN_POLL_INTERVAL_MS = 250;
/**
 * Consecutive `'unknown'` answers tolerated before the wait gives up with
 * JOB_RUNTIME_RUN_UNREADABLE — which says the run's fate is unknown, never
 * that it failed.
 */
const MAX_UNKNOWN_READS = 5;
/**
 * One read's time limit while waiting. The SDK's `runs.retrieve` has no request
 * timeout of its own and retries, so a stalled API could otherwise hold one
 * read — and the caller's deadline and abort — for minutes. Never longer than
 * what is left before the deadline.
 */
const READ_TIMEOUT_MS = 30_000;
/**
 * A {@link PluginExecutionRouterService.pollLongRunning} read's time limit:
 * well under the 60 s ingress limit its HTTP callers sit behind.
 */
const POLL_READ_TIMEOUT_MS = 20_000;
/**
 * The least time the LAST read — the one made at the deadline — is given, so
 * a run that settled just before the deadline is still seen. The wait can
 * therefore end up to this much after `timeoutMs`.
 */
const FINAL_READ_MIN_MS = 1_000;

/**
 * EW-693 / T25 — execution router (sync vs long-running).
 *
 * Decides whether a plugin operation executes **in-process** (short /
 * synchronous) or through the **job runtime** (long-running; the isolated
 * `run-plugin-operation` worker task). In order of precedence:
 *
 * 1. **An explicit profile on the call** (`dispatch(…, { profile })`) — the
 *    caller knows what it is asking for. Honoured in bundled AND dynamic mode.
 * 2. **The operation's declared profile** — `executionProfile` on its entry in
 *    `everworks.plugin.operations` (FR-17's declared, per-operation
 *    classification). Honoured in both modes, like the next one.
 * 3. **The manifest hint** — the plugin author's
 *    `everworks.plugin.executionProfile` (`'sync' | 'long-running'`). Also
 *    honoured in both modes: an author who sets it has taken an action, which
 *    FR-22's "bundled deployments that take no action see no change" permits.
 * 4. **Bundled mode** — with no explicit profile, every call stays in-process.
 * 5. **Operation classification** (dynamic mode only) — a built-in taxonomy of
 *    operation names (`pipeline.run`, `*.long-running`, …).
 *
 * Only operations the plugin DECLARES in `everworks.plugin.operations` can be
 * called, on either path (`resolvePluginOperation`).
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

        const operationProfile = declaredOperationProfile(
            this.registry.get(pluginId)?.manifest,
            operation,
        );
        if (operationProfile) {
            return {
                location: operationProfile === 'long-running' ? 'job-runtime' : 'in-process',
                reason: `manifest:operations[${operation}].executionProfile=${operationProfile}`,
            };
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

        const taxonomyProfile = classifyOperation(operation);
        if (taxonomyProfile === 'long-running') {
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
     * mode), looks it up, loads it, and invokes the named operation — one the
     * manifest DECLARES, resolved on the materialised plugin
     * (`resolvePluginOperation`), because the registry's lazy proxy answers a
     * function for ANY name. A plugin in `error` state — before loading, or
     * after its `onLoad` failed while loading — answers PLUGIN_LOAD_FAILED and
     * runs nothing.
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
            const failedBefore = pluginLoadFailure(registered, pluginId);
            if (failedBefore) return pluginLoadFailed(failedBefore);
            let plugin: object;
            try {
                plugin = await materializePlugin(registered.plugin);
            } catch (err) {
                return pluginLoadFailed(
                    `Plugin "${pluginId}" could not be loaded: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
            // `onLoad` runs inside the first materialisation, and its failure is
            // recorded on the registry entry rather than thrown — read it again.
            // The registry mutates its entries in place, so `registered` now
            // carries the state (and manifest) as they are after loading.
            const failedAfter = pluginLoadFailure(registered, pluginId);
            if (failedAfter) return pluginLoadFailed(failedAfter);
            const manifest = registered.manifest;
            const method = resolvePluginOperation(plugin, operation, manifest);
            if (!method) {
                return {
                    ok: false,
                    location: 'in-process',
                    error: {
                        message: describeMissingOperation(pluginId, operation, manifest),
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
     * `options.timeoutMs` (default: the run's whole lifetime, queue TTL plus
     * `maxDuration` plus boot — `PLUGIN_OPERATION_DEFAULT_WAIT_MS`), reading
     * back off from 1 s to `options.pollIntervalMs`, each read time-limited,
     * stopping early on `options.signal`. Giving up never cancels the run: the
     * answer carries its `runId` so the caller can keep reading it with
     * {@link pollLongRunning}. The codes that mean "gave up, fate unknown" are
     * JOB_RUNTIME_WAIT_TIMEOUT, JOB_RUNTIME_WAIT_ABORTED and
     * JOB_RUNTIME_RUN_UNREADABLE — none of them says the run failed.
     * JOB_RUNTIME_OUTPUT_UNREADABLE says it COMPLETED (do not dispatch it again)
     * but its output could not be read.
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
     * is queued or running — or unreadable right now, including a read that
     * took longer than `POLL_READ_TIMEOUT_MS` — else the final
     * {@link PluginExecutionResult}. A run that completed but whose output could
     * not be read this time is `done`, with JOB_RUNTIME_OUTPUT_UNREADABLE: its
     * work is over and it must not be dispatched again (a later poll may still
     * return the output).
     */
    async pollLongRunning<TResult = unknown>(runId: string): Promise<LongRunningPoll<TResult>> {
        const provider = this.activeProvider();
        if (!provider || typeof provider.getRunResult !== 'function') {
            return { done: true, runId, result: { ...jobRuntimeUnavailable(), runId } };
        }
        const read = await readRunResult(provider, runId, POLL_READ_TIMEOUT_MS);
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

    /**
     * Read `runId` until it settles, the deadline passes, the signal aborts, or
     * it stays unreadable for {@link MAX_UNKNOWN_READS} reads in a row. Each
     * read is limited to the time left (at most {@link READ_TIMEOUT_MS}) and
     * ends early on an abort, so neither the deadline nor the signal waits on
     * a stalled API. The last sleep is cut to the time left, and one final read
     * is made AT the deadline (given at least {@link FINAL_READ_MIN_MS}), so a
     * run that finished inside the budget is not reported as timed out.
     *
     * A completed run whose output could not be read (`outputUnavailable`) is
     * read again like an unreadable one; if it stays that way, the answer is
     * JOB_RUNTIME_OUTPUT_UNREADABLE — terminal, "completed, do not re-dispatch"
     * — not RUN_UNREADABLE's "may still be running".
     */
    private async awaitRunOutcome(
        provider: IJobRuntimeProvider,
        runId: string,
        options: LongRunningOptions,
    ): Promise<PluginExecutionTaskOutcome> {
        const timeoutMs = Math.max(
            0,
            finiteOr(options.timeoutMs, PLUGIN_OPERATION_DEFAULT_WAIT_MS),
        );
        const maxInterval = Math.max(
            MIN_POLL_INTERVAL_MS,
            finiteOr(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
        );
        const { signal } = options;
        const deadline = Date.now() + timeoutMs;
        let interval = Math.min(1_000, maxInterval);
        let unknownReads = 0;
        const aborted = () =>
            taskFailure(
                'JOB_RUNTIME_WAIT_ABORTED',
                `Stopped waiting for run ${runId}; the run itself was not cancelled.`,
            );

        for (;;) {
            if (signal?.aborted) return aborted();
            const read = await readRunResult(
                provider,
                runId,
                Math.min(READ_TIMEOUT_MS, Math.max(deadline - Date.now(), FINAL_READ_MIN_MS)),
                signal,
            );
            const outputUnavailable = isOutputUnavailable(read);
            if (
                !outputUnavailable &&
                read.status !== 'unknown' &&
                read.status !== 'queued' &&
                read.status !== 'running'
            ) {
                // A settled run is answered even if the caller aborted meanwhile.
                return outcomeOf(read, runId);
            }
            if (signal?.aborted) return aborted();
            if (outputUnavailable || read.status === 'unknown') {
                unknownReads += 1;
                if (unknownReads >= MAX_UNKNOWN_READS) {
                    // Neither says the run failed. A run that COMPLETED is done,
                    // though, and must not be dispatched again.
                    return outputUnavailable
                        ? outcomeOf(read, runId)
                        : taskFailure(
                              'JOB_RUNTIME_RUN_UNREADABLE',
                              `Run ${runId} could not be read from the job runtime ${unknownReads} times in a row. ` +
                                  'It was NOT cancelled and may still be running; read it again later.',
                          );
                }
            } else {
                unknownReads = 0;
            }
            const left = deadline - Date.now();
            if (left <= 0) {
                this.logger.warn(
                    `Stopped waiting for plugin operation run ${runId} after ${timeoutMs} ms.`,
                );
                return taskFailure(
                    'JOB_RUNTIME_WAIT_TIMEOUT',
                    `Run ${runId} did not finish within ${timeoutMs} ms. It was NOT cancelled; read it again later.`,
                );
            }
            // Never sleep past the deadline: the next read is the final one.
            await sleep(Math.min(interval, left), signal);
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

const UNKNOWN_READ: JobRunResult = { status: 'unknown' };

/**
 * `getRunResult`, never throwing and never taking longer than `timeoutMs` or
 * past an abort: a throw, a timeout and an abort are all an `'unknown'` read.
 * A read that loses the race is left to settle on its own — its outcome is
 * dropped, and a rejection is already handled.
 */
async function readRunResult(
    provider: IJobRuntimeProvider,
    runId: string,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<JobRunResult> {
    if (signal?.aborted) return UNKNOWN_READ;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const cutOff = new Promise<JobRunResult>((resolve) => {
        timer = setTimeout(() => resolve(UNKNOWN_READ), timeoutMs);
        onAbort = () => resolve(UNKNOWN_READ);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
    const read = Promise.resolve()
        .then(() => provider.getRunResult!(runId))
        .then(
            (result) => result ?? UNKNOWN_READ,
            () => UNKNOWN_READ,
        );
    try {
        return await Promise.race([read, cutOff]);
    } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
}

/** `value` when it is a finite number, else `fallback` (NaN, ±Infinity, absent). */
function finiteOr(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function pluginLoadFailed(message: string): PluginExecutionResult<never> {
    return { ok: false, location: 'in-process', error: { message, code: 'PLUGIN_LOAD_FAILED' } };
}

/** A completed run whose output the runtime could not read this time. */
function isOutputUnavailable(read: JobRunResult): boolean {
    return read.status === 'completed' && read.outputUnavailable === true;
}

/** A settled read as the task's envelope: its own output when completed, else a failure. */
function outcomeOf<TResult = unknown>(
    read: JobRunResult,
    runId: string,
): PluginExecutionTaskOutcome<TResult> {
    if (isOutputUnavailable(read)) {
        return taskFailure(
            'JOB_RUNTIME_OUTPUT_UNREADABLE',
            `Run ${runId} COMPLETED, but its output could not be read. Its work is done — do NOT ` +
                'dispatch it again; reading the run again may return the output.',
        );
    }
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

/**
 * Wait `ms`, or less if `signal` aborts. Resolves at once on an
 * already-aborted signal, and leaves no listener behind either way — the wait
 * can take hundreds of steps against one long-lived signal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
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
    /**
     * Wall-clock budget for waiting on the run; default
     * `PLUGIN_OPERATION_DEFAULT_WAIT_MS` (80 minutes). Not a finite number =
     * the default; negative = 0.
     */
    readonly timeoutMs?: number;
    /**
     * Upper bound between result reads; default 5 000 ms (reads back off from
     * 1 s). Never below 250 ms; not a finite number = the default.
     */
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
