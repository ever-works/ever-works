import { Injectable, Logger } from '@nestjs/common';
import type {
    WorkReference,
    GenerationRequest,
    ExistingItems,
    PipelineExecutionOptions,
    PipelineProgressCallback,
    PipelineResult,
    IPipelinePlugin,
    IPlugin,
} from '@ever-works/plugin';
import {
    isPipelinePlugin,
    isStepOrchestratablePipeline,
    PLUGIN_CAPABILITIES,
} from '@ever-works/plugin';

import { StepPipelineExecutorService } from './step-pipeline-executor.service';
import { FullPipelineExecutorService } from './full-pipeline-executor.service';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import { materializeUsablePlugin } from '../plugins/services/plugin-operation.util';

export type PipelineExecutionMode = 'step' | 'full';

/**
 * Main entry point for pipeline execution.
 * Routes to step-based or self-managed execution based on pipeline plugin type.
 *
 * All pipelines are `IPipelinePlugin`. Routing logic:
 * - Engine-orchestratable pipelines (e.g. standard-pipeline) → StepPipelineExecutorService
 * - Self-managed pipelines (e.g. claude-code) → FullPipelineExecutorService
 */
@Injectable()
export class PipelineOrchestratorService {
    private readonly logger = new Logger(PipelineOrchestratorService.name);

    constructor(
        private readonly stepExecutor: StepPipelineExecutorService,
        private readonly fullExecutor: FullPipelineExecutorService,
        private readonly registry: PluginRegistryService,
    ) {}

    async execute(
        work: WorkReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        const pipelineId = request.providers?.pipeline;

        const plugin = await this.resolvePipelinePlugin(pipelineId, work.id, work.user?.id);

        const mode: PipelineExecutionMode = isStepOrchestratablePipeline(plugin) ? 'step' : 'full';

        this.logger.log(
            `Executing pipeline for work "${work.id}" in ${mode} mode (via plugin: ${plugin.id})`,
        );

        if (mode === 'step') {
            return this.stepExecutor.execute(plugin, work, request, existing, options, onProgress);
        }

        return this.fullExecutor.execute(plugin, work, request, existing, options, onProgress);
    }

    /** Execute with explicit mode selection */
    async executeWithMode(
        mode: PipelineExecutionMode,
        work: WorkReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        this.logger.log(`Executing pipeline for work "${work.id}" in forced ${mode} mode`);

        if (mode === 'full') {
            // Find a self-managed (non-step-orchestratable) pipeline plugin
            const fullPlugin = (await this.getMaterializedPipelinePlugins()).find(
                (p) => !isStepOrchestratablePipeline(p),
            );
            if (fullPlugin) {
                return this.fullExecutor.execute(
                    fullPlugin,
                    work,
                    request,
                    existing,
                    options,
                    onProgress,
                );
            }
            this.logger.warn(
                'Full mode requested but no self-managed pipeline available, falling back to step mode',
            );
        }

        // Step mode (or fallback from full mode)
        const plugin = await this.resolvePipelinePlugin(undefined, work.id, work.user?.id);
        return this.stepExecutor.execute(plugin, work, request, existing, options, onProgress);
    }

    async getRecommendedMode(
        workId?: string,
        userId?: string,
    ): Promise<{
        mode: PipelineExecutionMode;
        reason: string;
        plugin?: string;
    }> {
        // Check if any self-managed (non-step-orchestratable) pipeline is available
        const fullPlugin = (await this.getMaterializedPipelinePlugins()).find(
            (p) => !isStepOrchestratablePipeline(p),
        );
        if (fullPlugin) {
            return {
                mode: 'full',
                reason: `Self-managed pipeline plugin "${fullPlugin.name}" is available`,
                plugin: fullPlugin.id,
            };
        }

        return {
            mode: 'step',
            reason: 'No self-managed pipeline plugin available',
        };
    }

    async hasFullPipelinePlugin(): Promise<boolean> {
        return (await this.getMaterializedPipelinePlugins()).some(
            (p) => !isStepOrchestratablePipeline(p),
        );
    }

    /**
     * Same as {@link getAvailablePipelinePlugins} but with every lazy stub
     * materialised, so capability probes (`isStepOrchestratablePipeline`) see
     * the real plugin surface — less any that cannot load (import or onLoad
     * failing on this first use), as the eager boot would have left it out.
     */
    private async getMaterializedPipelinePlugins(): Promise<IPipelinePlugin[]> {
        const materialized = await Promise.all(
            this.getAvailablePipelineEntries().map((entry) => this.materialize(entry)),
        );
        return materialized.filter((p): p is IPipelinePlugin => p !== null);
    }

    /**
     * Lazy-mode registries (`PLUGIN_LAZY_LOAD`, the default) hand out proxies
     * that answer EVERY property with an async forwarding function until the
     * real module has been imported. On such a stub capability probes like
     * `isStepOrchestratablePipeline()` are meaningless (every method "exists")
     * and the pipeline contract's synchronous calls — `createContext()`,
     * `getStepDefinitions()`, `getState()` — come back as Promises. The
     * orchestrator always *executes* the pipeline it resolves (never just
     * inspects it), so materialising here costs nothing extra and restores the
     * real plugin surface for routing + execution. No-op for eager/real plugins.
     *
     * `null` when the plugin cannot be used: its import fails, or its first
     * load leaves the registry entry in `error` (a failing onLoad does not
     * reject the materialise). The eager boot found that at boot and skipped
     * the pipeline; the caller skips it here, never executing it.
     */
    private async materialize(
        registered: Pick<RegisteredPlugin, 'plugin' | 'state' | 'error'>,
    ): Promise<IPipelinePlugin | null> {
        const pluginId = registered.plugin.id;
        return materializeUsablePlugin<IPipelinePlugin>(registered, pluginId, (reason) =>
            this.logger.warn(`Pipeline plugin "${pluginId}" is not usable: ${reason}`),
        );
    }

    getAvailablePipelinePlugins(): IPipelinePlugin[] {
        return this.getAvailablePipelineEntries().map((p) => p.plugin as IPipelinePlugin);
    }

    /** The registry entries behind {@link getAvailablePipelinePlugins}. */
    private getAvailablePipelineEntries(): RegisteredPlugin[] {
        return this.registry
            .getByCapability(PLUGIN_CAPABILITIES.PIPELINE)
            .filter((p) => p.state === 'loaded' && isPipelinePlugin(p.plugin));
    }

    async resumeFromCheckpoint(
        workId: string,
        pipelineId: string,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult | null> {
        // Resume is only supported in step mode — resolve the pipeline plugin that owns the checkpoint
        const plugin = await this.resolvePipelinePlugin(pipelineId, workId);
        return this.stepExecutor.resumeFromCheckpoint(
            plugin,
            workId,
            pipelineId,
            options,
            onProgress,
        );
    }

    async clearCheckpoint(workId: string, pipelineId: string): Promise<void> {
        await this.stepExecutor.clearCheckpoint(workId, pipelineId);
    }

    /**
     * Try to resume from a checkpoint; if none exists, run a fresh execution.
     * Only step-orchestratable pipelines support checkpoint resume.
     */
    async resumeOrExecute(
        work: WorkReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        const plugin = await this.resolvePipelinePlugin(
            request.providers?.pipeline,
            work.id,
            work.user?.id,
        );

        // Only step-orchestratable pipelines support checkpoint resume
        if (isStepOrchestratablePipeline(plugin)) {
            const resumed = await this.stepExecutor.resumeFromCheckpoint(
                plugin,
                work.id,
                plugin.id,
                options,
                onProgress,
            );
            if (resumed) {
                this.logger.log(
                    `Resumed from checkpoint for "${work.id}", success=${resumed.success}`,
                );
                return resumed;
            }
        }

        // No checkpoint or not resumable — fresh execution
        return this.execute(work, request, existing, options, onProgress);
    }

    /**
     * Resolve the pipeline plugin to use.
     *
     * Priority:
     * 1. Explicit pipelineId from request
     * 2. First enabled pipeline with defaultForCapabilities: ['pipeline']
     * 3. First loaded+enabled pipeline plugin
     */
    private async resolvePipelinePlugin(
        pipelineId?: string | null,
        workId?: string,
        userId?: string,
    ): Promise<IPipelinePlugin> {
        if (typeof pipelineId === 'string') {
            const registered = this.registry.get(pipelineId);
            if (registered?.state === 'loaded' && isPipelinePlugin(registered.plugin)) {
                const isEnabled = await this.registry.isPluginEnabledForScope(
                    registered.plugin.id,
                    workId,
                    userId,
                );
                const usable = isEnabled ? await this.materialize(registered) : null;
                if (usable) return usable;
            }
            this.logger.warn(
                `Pipeline plugin "${pipelineId}" not available, falling back to auto-detect`,
            );
            // Fall through to auto-detect
        }

        // Auto-detect: find first pipeline with defaultForCapabilities
        const pipelines = this.registry.getByCapability(PLUGIN_CAPABILITIES.PIPELINE);

        // First: find one with defaultForCapabilities: ['pipeline'] that is loaded and enabled for scope
        for (const registered of pipelines) {
            if (registered.state !== 'loaded') continue;
            if (!isPipelinePlugin(registered.plugin)) continue;
            if (!registered.manifest.defaultForCapabilities?.includes('pipeline')) continue;
            const isEnabled = await this.registry.isPluginEnabledForScope(
                registered.plugin.id,
                workId,
                userId,
            );
            const usable = isEnabled ? await this.materialize(registered) : null;
            if (usable) return usable;
        }

        // Fallback: first loaded and enabled pipeline (a default that failed to
        // load above is in `error` now, so it is skipped here)
        for (const registered of pipelines) {
            if (registered.state !== 'loaded') continue;
            if (!isPipelinePlugin(registered.plugin)) continue;
            const isEnabled = await this.registry.isPluginEnabledForScope(
                registered.plugin.id,
                workId,
                userId,
            );
            const usable = isEnabled ? await this.materialize(registered) : null;
            if (usable) return usable;
        }

        throw new Error(
            'No pipeline plugin available. Ensure at least one pipeline plugin is loaded.',
        );
    }
}
