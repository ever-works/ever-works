import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { PluginExecutionProfile } from '@ever-works/plugin';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginInstallerService } from './plugin-installer.service';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';

/**
 * EW-693 / T25 — execution router (sync vs long-running).
 *
 * Decides whether a plugin capability call executes **in-process**
 * (short / synchronous; via dynamic `import()`) or via the **job
 * runtime** (long-running; isolated Trigger.dev task). Routing is
 * driven by:
 *
 * 1. **Manifest hint** — the plugin author's
 *    `everworks.plugin.executionProfile` (`'sync' | 'long-running'`)
 *    is the most specific signal and wins outright when set.
 * 2. **Operation classification** — when no manifest hint is set,
 *    a built-in taxonomy maps known operation names to a profile:
 *    `pipeline.run`, `deploy.deploy`, `generation.run`,
 *    `*.long-running` → `long-running`; everything else (search,
 *    extract, screenshot, list-models, …) → `sync`.
 * 3. **Bundled mode override** — when
 *    `PluginsModuleOptions.distributionMode === 'bundled'`, every
 *    call resolves to `in-process`. The router still applies the
 *    `ensurePluginAvailable` gate for parity, but in bundled mode
 *    that gate is itself a no-op (FR-22).
 *
 * Result/error shape is unified across both paths (`PluginExecutionResult`)
 * so facades can `await router.dispatch(...)` and not care which
 * runtime ran it.
 */
@Injectable()
export class PluginExecutionRouterService {
    private readonly logger = new Logger(PluginExecutionRouterService.name);
    private readonly distributionMode: 'bundled' | 'dynamic';

    /**
     * Indirection seam for tests + lazy require: production code lazy-
     * imports the actual Trigger.dev task module so packages/agent can
     * be built/loaded without `@trigger.dev/sdk` resolving in bundled-
     * mode-only deployments.
     */
    private triggerDispatcher: TriggerDispatcher | null = null;

    constructor(
        @Inject(PLUGINS_MODULE_OPTIONS)
        options: PluginsModuleOptions,
        private readonly registry: PluginRegistryService,
        @Optional()
        private readonly installer?: PluginInstallerService,
    ) {
        this.distributionMode = options.distributionMode ?? 'bundled';
    }

    /**
     * Test seam — production code resolves the dispatcher lazily.
     */
    setTriggerDispatcherForTests(impl: TriggerDispatcher | null): void {
        this.triggerDispatcher = impl;
    }

    /**
     * EW-693 / FR-17 — Classification only. Pure function over manifest
     * + operation name, with the bundled-mode override applied.
     *
     * Useful for callers that want to log/decide before dispatching
     * (e.g. metrics + activity-log events on long-running entries).
     */
    route(pluginId: string, operation: string): RouteDecision {
        // Bundled mode never hops to the job runtime — the cost/latency
        // of a Trigger.dev round-trip isn't justified when the plugin
        // is statically loaded in every replica (FR-22).
        if (this.distributionMode !== 'dynamic') {
            return { location: 'in-process', reason: 'bundled-mode' };
        }

        const manifestProfile = this.manifestProfileFor(pluginId);
        if (manifestProfile === 'long-running') {
            return { location: 'job-runtime', reason: 'manifest:executionProfile=long-running' };
        }
        if (manifestProfile === 'sync') {
            return { location: 'in-process', reason: 'manifest:executionProfile=sync' };
        }

        const operationProfile = classifyOperation(operation);
        if (operationProfile === 'long-running') {
            return { location: 'job-runtime', reason: `operation-taxonomy:${operation}` };
        }
        return { location: 'in-process', reason: `operation-taxonomy:${operation}` };
    }

    /**
     * Convenience dispatch — picks the right runtime via {@link route},
     * calls `ensurePluginAvailable` (FR-13), invokes the plugin's
     * `operation` method with `args`, and returns the unified
     * {@link PluginExecutionResult} envelope.
     *
     * The execution router does NOT attempt to convert thrown errors
     * into a different shape on the in-process path — it lets the
     * caller see the original error via `result.error`. Trigger.dev
     * errors arrive serialised by the SDK; the router unwraps the
     * `error.message` and tags `error.code` with `JOB_RUNTIME_*` so
     * callers can tell the two paths apart in metrics without losing
     * the underlying message.
     */
    async dispatch<TResult = unknown>(
        pluginId: string,
        operation: string,
        args?: Record<string, unknown>,
    ): Promise<PluginExecutionResult<TResult>> {
        const decision = this.route(pluginId, operation);

        if (decision.location === 'in-process') {
            return this.dispatchSync<TResult>(pluginId, operation, args);
        }
        return this.dispatchLongRunning<TResult>(pluginId, operation, args);
    }

    /**
     * In-process dispatch. Ensures the plugin is installed (no-op in
     * bundled mode), looks it up from the registry, and invokes the
     * named method.
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
            const plugin = registered.plugin as Record<string, unknown>;
            const method = plugin[operation];
            if (typeof method !== 'function') {
                return {
                    ok: false,
                    location: 'in-process',
                    error: {
                        message: `Plugin "${pluginId}" does not implement operation "${operation}".`,
                        code: 'OPERATION_NOT_FOUND',
                    },
                };
            }
            const result = (await (method as (a?: Record<string, unknown>) => unknown).call(
                plugin,
                args,
            )) as TResult;
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
     * Long-running dispatch — hands the operation off to a Trigger.dev
     * task that installs the plugin in the worker's own store (the
     * worker is a separate process; FR-13 applies there too) and
     * invokes it.
     *
     * In bundled mode this method is reachable only if a caller bypasses
     * {@link route} and calls it directly; it still runs through the
     * task layer for behavioural parity with dynamic mode.
     */
    async dispatchLongRunning<TResult = unknown>(
        pluginId: string,
        operation: string,
        args?: Record<string, unknown>,
    ): Promise<PluginExecutionResult<TResult>> {
        try {
            const dispatcher = await this.getTriggerDispatcher();
            const handle = await dispatcher.trigger({ pluginId, operation, args });
            const outcome = (await dispatcher.waitForResult(
                handle,
            )) as PluginExecutionTaskOutcome<TResult>;
            if (outcome?.ok) {
                return { ok: true, location: 'job-runtime', result: outcome.result };
            }
            return {
                ok: false,
                location: 'job-runtime',
                error: {
                    message: outcome?.error?.message ?? 'Trigger.dev task returned an empty result',
                    code: outcome?.error?.code ?? 'JOB_RUNTIME_FAILED',
                },
            };
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
     * Pull the manifest's executionProfile for the plugin id (no
     * fallback — null when not set / not registered). Used by
     * {@link route} as the highest-priority signal.
     */
    private manifestProfileFor(pluginId: string): PluginExecutionProfile | null {
        const registered = this.registry.get(pluginId);
        const profile = registered?.manifest?.executionProfile;
        if (profile === 'sync' || profile === 'long-running') return profile;
        return null;
    }

    private async getTriggerDispatcher(): Promise<TriggerDispatcher> {
        if (this.triggerDispatcher) return this.triggerDispatcher;
        // Lazy-resolve so packages/agent can be required without
        // `@trigger.dev/sdk` available (e.g. in bundled-only deployments
        // or unit tests that mock the dispatcher).
        try {
            const sdk = (await import('@trigger.dev/sdk')) as {
                tasks?: { trigger: typeof defaultTriggerFn };
                wait?: { forRunToComplete?: typeof defaultWaitFn };
            };
            const trigger = sdk.tasks?.trigger;
            const waitForRunToComplete = sdk.wait?.forRunToComplete;
            if (!trigger) {
                throw new Error('@trigger.dev/sdk missing tasks.trigger');
            }
            const dispatcher: TriggerDispatcher = {
                async trigger(payload) {
                    return trigger('run-plugin-operation', payload);
                },
                async waitForResult(handle: { id?: string } & Record<string, unknown>) {
                    if (waitForRunToComplete && handle.id) {
                        const out = (await waitForRunToComplete(handle.id)) as
                            | { output?: unknown }
                            | undefined;
                        return (out?.output ?? null) as PluginExecutionTaskOutcome;
                    }
                    return null;
                },
            };
            this.triggerDispatcher = dispatcher;
            return dispatcher;
        } catch (err) {
            throw new HttpException(
                {
                    statusCode: 500,
                    message:
                        `Long-running plugin execution requires @trigger.dev/sdk. ` +
                        `Either set executionProfile='sync' on the plugin or install ` +
                        `the SDK. Underlying error: ` +
                        (err instanceof Error ? err.message : String(err)),
                },
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }
}

// ─── helpers / types ─────────────────────────────────────────────────

/**
 * Built-in operation taxonomy (T25). Unknown operations default to
 * `sync` — bundled mode + the manifest hint can still override.
 *
 * Suffix wildcards: any operation ending with `.long-running`, `.deploy`,
 * or `.generate` is treated as long-running. This matches the
 * generator pipeline + deployment + site-generation operations
 * already in the codebase.
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

export interface RouteDecision {
    readonly location: 'in-process' | 'job-runtime';
    /** Human-readable explanation pinned in metrics / activity log. */
    readonly reason: string;
}

export interface PluginExecutionResult<TResult = unknown> {
    readonly ok: boolean;
    readonly location: 'in-process' | 'job-runtime';
    readonly result?: TResult;
    readonly error?: {
        readonly message: string;
        readonly code: string;
    };
}

/**
 * Wire-shape the Trigger.dev task returns to the router. Matches the
 * {@link PluginExecutionResult} shape so the router can forward it
 * verbatim.
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

export interface TriggerDispatcher {
    trigger(payload: TriggerDispatchPayload): Promise<{ id?: string } & Record<string, unknown>>;
    waitForResult(handle: { id?: string } & Record<string, unknown>): Promise<unknown>;
}

// Phantom typeof helpers for sdk shim — pure signatures.
declare function defaultTriggerFn(
    id: string,
    payload: unknown,
): Promise<{ id?: string } & Record<string, unknown>>;
declare function defaultWaitFn(id: string): Promise<{ output?: unknown } | undefined>;
