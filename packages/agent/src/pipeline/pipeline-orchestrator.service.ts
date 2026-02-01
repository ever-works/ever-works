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

/**
 * Type guard for full pipeline plugins (inlined to avoid ESM import issues)
 */
function isFullPipelinePlugin(plugin: IPlugin): plugin is IFullPipelinePlugin {
    return plugin.capabilities.includes('full-pipeline');
}

/**
 * Pipeline execution mode
 */
export type PipelineExecutionMode = 'step' | 'full';

/**
 * Pipeline orchestrator that decides between step-based and full pipeline execution.
 *
 * This service is the main entry point for pipeline execution. It checks if a full
 * pipeline plugin is available and enabled, and delegates to the appropriate executor.
 *
 * Uses three-level enable resolution: Directory > User > autoEnable.
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

    /**
     * Execute the pipeline for a directory.
     *
     * This method checks for available full pipeline plugins and decides the execution mode:
     * - If a full pipeline plugin is enabled for this directory, uses full pipeline execution
     * - Otherwise, uses step-based execution
     *
     * @param directory - Directory reference
     * @param request - Generation request parameters
     * @param existing - Existing items in directory
     * @param options - Execution options
     * @param onProgress - Progress callback
     * @returns Pipeline execution result
     */
    async execute(
        directory: DirectoryReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        // Determine execution mode with directory-scoped plugin resolution
        const fullPipelinePlugin = await this.findFullPipelinePlugin(
            directory.id,
            directory.user?.id,
        );
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

    /**
     * Execute with explicit mode selection.
     *
     * Allows forcing a specific execution mode regardless of available plugins.
     *
     * @param mode - Execution mode ('step' or 'full')
     * @param directory - Directory reference
     * @param request - Generation request parameters
     * @param existing - Existing items in directory
     * @param options - Execution options
     * @param onProgress - Progress callback
     * @returns Pipeline execution result
     */
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

    /**
     * Get the recommended execution mode for a directory.
     *
     * @param directoryId - Directory ID
     * @param userId - Optional user ID for user-level plugin resolution
     * @returns Recommended execution mode and reason
     */
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

    /**
     * Check if a full pipeline plugin is available for a directory.
     *
     * @param directoryId - Directory ID (optional, for directory-specific plugins)
     * @param userId - Optional user ID for user-level plugin resolution
     */
    async hasFullPipelinePlugin(directoryId?: string, userId?: string): Promise<boolean> {
        return (await this.findFullPipelinePlugin(directoryId, userId)) !== null;
    }

    /**
     * Get all available full pipeline plugins.
     */
    getAvailableFullPipelinePlugins(): IFullPipelinePlugin[] {
        return this.registry
            .getByCapability('full-pipeline')
            .filter((p) => p.state === 'enabled')
            .map((p) => p.plugin)
            .filter(isFullPipelinePlugin);
    }

    /**
     * Resume pipeline from checkpoint.
     *
     * @param directoryId - Directory ID
     * @param options - Execution options
     * @param onProgress - Progress callback
     */
    async resumeFromCheckpoint(
        directoryId: string,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult | null> {
        // Resume is only supported in step mode
        return this.stepExecutor.resumeFromCheckpoint(directoryId, options, onProgress);
    }

    /**
     * Clear checkpoint for a directory.
     *
     * @param directoryId - Directory ID
     */
    async clearCheckpoint(directoryId: string): Promise<void> {
        await this.stepExecutor.clearCheckpoint(directoryId);
    }

    /**
     * Find an enabled full pipeline plugin for the given directory/user context.
     *
     * @param directoryId - Optional directory ID for directory-specific plugin resolution
     * @param userId - Optional user ID for user-level plugin resolution
     * @returns The full pipeline plugin if found and enabled, null otherwise
     */
    private async findFullPipelinePlugin(
        directoryId?: string,
        userId?: string,
    ): Promise<IFullPipelinePlugin | null> {
        const plugins = this.registry.getByCapability('full-pipeline');

        for (const registered of plugins) {
            // Only consider enabled plugins at the registry level
            if (registered.state !== 'enabled') {
                continue;
            }

            // Check directory-specific enabled state
            const isEnabled = await this.isPluginEnabledForDirectory(
                registered.plugin.id,
                directoryId,
                userId,
            );
            if (!isEnabled) {
                continue;
            }

            // Verify it implements IFullPipelinePlugin
            if (isFullPipelinePlugin(registered.plugin)) {
                this.logger.debug(`Found full pipeline plugin: ${registered.plugin.id}`);
                return registered.plugin;
            }
        }

        return null;
    }

    /**
     * Check if a plugin is enabled for the given directory/user context.
     *
     * Enable resolution: Directory (L2) > User (L1) > autoEnable
     */
    private async isPluginEnabledForDirectory(
        pluginId: string,
        directoryId?: string,
        userId?: string,
    ): Promise<boolean> {
        // Level 2: Directory-level enable state
        if (directoryId && this.directoryPluginRepository) {
            try {
                const dp = await this.directoryPluginRepository.findByDirectoryAndPlugin(
                    directoryId,
                    pluginId,
                );
                if (dp !== null) return dp.enabled;
            } catch {
                // Continue to next level
            }
        }

        // Level 1: User-level enable state
        if (userId && this.userPluginRepository) {
            try {
                const up = await this.userPluginRepository.findByUserAndPlugin(userId, pluginId);
                if (up !== null) return up.enabled;
            } catch {
                // Continue to fallback
            }
        }

        // Fallback: autoEnable from manifest
        const registered = this.registry.get(pluginId);
        return registered?.manifest?.autoEnable ?? true;
    }
}
