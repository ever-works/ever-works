import { Injectable, Logger } from '@nestjs/common';
import type {
    DirectoryReference,
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
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';

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
        directory: DirectoryReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        const pipelineId = request.providers?.pipeline;

        const plugin = await this.resolvePipelinePlugin(
            pipelineId,
            directory.id,
            directory.user?.id,
        );

        const mode: PipelineExecutionMode = isStepOrchestratablePipeline(plugin) ? 'step' : 'full';

        this.logger.log(
            `Executing pipeline for directory "${directory.id}" in ${mode} mode (via plugin: ${plugin.id})`,
        );

        if (mode === 'step') {
            return this.stepExecutor.execute(
                plugin,
                directory,
                request,
                existing,
                options,
                onProgress,
            );
        }

        return this.fullExecutor.execute(plugin, directory, request, existing, options, onProgress);
    }

    /** Execute with explicit mode selection */
    async executeWithMode(
        mode: PipelineExecutionMode,
        directory: DirectoryReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        this.logger.log(
            `Executing pipeline for directory "${directory.id}" in forced ${mode} mode`,
        );

        if (mode === 'full') {
            // Find a self-managed (non-step-orchestratable) pipeline plugin
            const fullPlugin = this.getAvailablePipelinePlugins().find(
                (p) => !isStepOrchestratablePipeline(p),
            );
            if (fullPlugin) {
                return this.fullExecutor.execute(
                    fullPlugin,
                    directory,
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
        const plugin = await this.resolvePipelinePlugin(
            undefined,
            directory.id,
            directory.user?.id,
        );
        return this.stepExecutor.execute(plugin, directory, request, existing, options, onProgress);
    }

    async getRecommendedMode(
        directoryId?: string,
        userId?: string,
    ): Promise<{
        mode: PipelineExecutionMode;
        reason: string;
        plugin?: string;
    }> {
        // Check if any self-managed (non-step-orchestratable) pipeline is available
        const fullPlugin = this.getAvailablePipelinePlugins().find(
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
        return this.getAvailablePipelinePlugins().some((p) => !isStepOrchestratablePipeline(p));
    }

    getAvailablePipelinePlugins(): IPipelinePlugin[] {
        return this.registry
            .getByCapability(PLUGIN_CAPABILITIES.PIPELINE)
            .filter((p) => p.state === 'loaded')
            .map((p) => p.plugin)
            .filter(isPipelinePlugin);
    }

    async resumeFromCheckpoint(
        directoryId: string,
        pipelineId: string,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult | null> {
        // Resume is only supported in step mode — resolve the pipeline plugin that owns the checkpoint
        const plugin = await this.resolvePipelinePlugin(pipelineId, directoryId);
        return this.stepExecutor.resumeFromCheckpoint(
            plugin,
            directoryId,
            pipelineId,
            options,
            onProgress,
        );
    }

    async clearCheckpoint(directoryId: string, pipelineId: string): Promise<void> {
        await this.stepExecutor.clearCheckpoint(directoryId, pipelineId);
    }

    /**
     * Try to resume from a checkpoint; if none exists, run a fresh execution.
     * Only step-orchestratable pipelines support checkpoint resume.
     */
    async resumeOrExecute(
        directory: DirectoryReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        const plugin = await this.resolvePipelinePlugin(
            request.providers?.pipeline,
            directory.id,
            directory.user?.id,
        );

        // Only step-orchestratable pipelines support checkpoint resume
        if (isStepOrchestratablePipeline(plugin)) {
            const resumed = await this.stepExecutor.resumeFromCheckpoint(
                plugin,
                directory.id,
                plugin.id,
                options,
                onProgress,
            );
            if (resumed) {
                this.logger.log(
                    `Resumed from checkpoint for "${directory.id}", success=${resumed.success}`,
                );
                return resumed;
            }
        }

        // No checkpoint or not resumable — fresh execution
        return this.execute(directory, request, existing, options, onProgress);
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
        directoryId?: string,
        userId?: string,
    ): Promise<IPipelinePlugin> {
        if (typeof pipelineId === 'string') {
            const registered = this.registry.get(pipelineId);
            if (registered?.state === 'loaded' && isPipelinePlugin(registered.plugin)) {
                const isEnabled = await this.registry.isPluginEnabledForScope(
                    registered.plugin.id,
                    directoryId,
                    userId,
                );
                if (isEnabled) {
                    return registered.plugin;
                }
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
                directoryId,
                userId,
            );
            if (isEnabled) return registered.plugin;
        }

        // Fallback: first loaded and enabled pipeline
        for (const registered of pipelines) {
            if (registered.state !== 'loaded') continue;
            if (!isPipelinePlugin(registered.plugin)) continue;
            const isEnabled = await this.registry.isPluginEnabledForScope(
                registered.plugin.id,
                directoryId,
                userId,
            );
            if (isEnabled) return registered.plugin;
        }

        throw new Error(
            'No pipeline plugin available. Ensure at least one pipeline plugin is loaded.',
        );
    }
}
