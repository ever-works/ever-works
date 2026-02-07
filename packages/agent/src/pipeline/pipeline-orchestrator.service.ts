import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    DirectoryReference,
    GenerationRequest,
    ExistingItems,
    PipelineExecutionOptions,
    PipelineProgressCallback,
    PipelineResult,
    IFullPipelinePlugin,
    IPlugin,
} from '@ever-works/plugin';

import { StepPipelineExecutorService } from './step-pipeline-executor.service';
import { FullPipelineExecutorService } from './full-pipeline-executor.service';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';

function isFullPipelinePlugin(plugin: IPlugin): plugin is IFullPipelinePlugin {
    return plugin.capabilities.includes('full-pipeline');
}

export type PipelineExecutionMode = 'step' | 'full';

/**
 * Main entry point for pipeline execution.
 * Decides between step-based and full pipeline execution based on available plugins.
 */
@Injectable()
export class PipelineOrchestratorService {
    private readonly logger = new Logger(PipelineOrchestratorService.name);

    constructor(
        private readonly stepExecutor: StepPipelineExecutorService,
        private readonly fullExecutor: FullPipelineExecutorService,
        private readonly registry: PluginRegistryService,
        @Optional() private readonly directoryPluginRepository?: DirectoryPluginRepository,
        @Optional() private readonly userPluginRepository?: UserPluginRepository,
    ) {}

    async execute(
        directory: DirectoryReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        const pipelineOverride = request.providers?.pipeline;

        let fullPipelinePlugin: IFullPipelinePlugin | null = null;

        if (typeof pipelineOverride === 'string') {
            // User explicitly selected a full-pipeline plugin by ID
            fullPipelinePlugin = this.resolveExplicitPipeline(pipelineOverride);
        } else if (pipelineOverride === null) {
            // User explicitly chose "standard pipeline" — skip full pipeline
            fullPipelinePlugin = null;
        } else {
            // No explicit selection (undefined) — auto-detect from directory settings
            fullPipelinePlugin = await this.findFullPipelinePlugin(
                directory.id,
                directory.user?.id,
            );
        }

        const mode: PipelineExecutionMode = fullPipelinePlugin ? 'full' : 'step';

        this.logger.log(
            `Executing pipeline for directory "${directory.id}" in ${mode} mode` +
                (fullPipelinePlugin ? ` (via plugin: ${fullPipelinePlugin.id})` : ''),
        );

        if (fullPipelinePlugin) {
            return this.fullExecutor.execute(
                fullPipelinePlugin,
                directory,
                request,
                existing,
                options,
                onProgress,
            );
        }

        return this.stepExecutor.execute(directory, request, existing, options, onProgress);
    }

    /** Execute with explicit mode selection, regardless of available plugins */
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
            const fullPipelinePlugin = await this.findFullPipelinePlugin(
                directory.id,
                directory.user?.id,
            );
            if (!fullPipelinePlugin) {
                this.logger.warn(
                    'Full mode requested but no full pipeline plugin available, falling back to step mode',
                );
                return this.stepExecutor.execute(directory, request, existing, options, onProgress);
            }

            return this.fullExecutor.execute(
                fullPipelinePlugin,
                directory,
                request,
                existing,
                options,
                onProgress,
            );
        }

        return this.stepExecutor.execute(directory, request, existing, options, onProgress);
    }

    async getRecommendedMode(
        directoryId?: string,
        userId?: string,
    ): Promise<{
        mode: PipelineExecutionMode;
        reason: string;
        plugin?: string;
    }> {
        const fullPipelinePlugin = await this.findFullPipelinePlugin(directoryId, userId);

        if (fullPipelinePlugin) {
            return {
                mode: 'full',
                reason: `Full pipeline plugin "${fullPipelinePlugin.name}" is enabled`,
                plugin: fullPipelinePlugin.id,
            };
        }

        return {
            mode: 'step',
            reason: 'No full pipeline plugin available, using step-based execution',
        };
    }

    async hasFullPipelinePlugin(directoryId?: string, userId?: string): Promise<boolean> {
        return (await this.findFullPipelinePlugin(directoryId, userId)) !== null;
    }

    getAvailableFullPipelinePlugins(): IFullPipelinePlugin[] {
        return this.registry
            .getByCapability('full-pipeline')
            .filter((p) => p.state === 'enabled')
            .map((p) => p.plugin)
            .filter(isFullPipelinePlugin);
    }

    async resumeFromCheckpoint(
        directoryId: string,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult | null> {
        // Resume is only supported in step mode
        return this.stepExecutor.resumeFromCheckpoint(directoryId, options, onProgress);
    }

    async clearCheckpoint(directoryId: string): Promise<void> {
        await this.stepExecutor.clearCheckpoint(directoryId);
    }

    private resolveExplicitPipeline(pluginId: string): IFullPipelinePlugin | null {
        const registered = this.registry.get(pluginId);
        if (!registered || registered.state !== 'enabled') {
            this.logger.warn(
                `Requested pipeline plugin "${pluginId}" not found or not enabled, falling back to step mode`,
            );
            return null;
        }
        if (!isFullPipelinePlugin(registered.plugin)) {
            this.logger.warn(
                `Plugin "${pluginId}" does not have full-pipeline capability, falling back to step mode`,
            );
            return null;
        }
        return registered.plugin;
    }

    private async findFullPipelinePlugin(
        directoryId?: string,
        userId?: string,
    ): Promise<IFullPipelinePlugin | null> {
        const plugins = this.registry.getByCapability('full-pipeline');

        for (const registered of plugins) {
            if (registered.state !== 'enabled') {
                continue;
            }

            const isEnabled = await this.isPluginEnabledForDirectory(
                registered.plugin.id,
                directoryId,
                userId,
            );
            if (!isEnabled) {
                continue;
            }

            if (isFullPipelinePlugin(registered.plugin)) {
                this.logger.debug(`Found full pipeline plugin: ${registered.plugin.id}`);
                return registered.plugin;
            }
        }

        return null;
    }

    private async isPluginEnabledForDirectory(
        pluginId: string,
        directoryId?: string,
        userId?: string,
    ): Promise<boolean> {
        if (directoryId && this.directoryPluginRepository) {
            try {
                const dp = await this.directoryPluginRepository.findByDirectoryAndPlugin(
                    directoryId,
                    pluginId,
                );
                if (dp !== null) return dp.enabled;
            } catch {
                // Continue
            }
        }

        if (userId && this.userPluginRepository) {
            try {
                const up = await this.userPluginRepository.findByUserAndPlugin(userId, pluginId);
                if (up !== null) return up.enabled;
            } catch {
                // Continue
            }
        }

        const registered = this.registry.get(pluginId);
        return registered?.manifest?.autoEnable ?? true;
    }
}
