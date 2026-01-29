import { Injectable, Logger } from '@nestjs/common';
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
 */
@Injectable()
export class PipelineOrchestratorService {
    private readonly logger = new Logger(PipelineOrchestratorService.name);

    constructor(
        private readonly stepExecutor: StepPipelineExecutorService,
        private readonly fullExecutor: FullPipelineExecutorService,
        private readonly registry: PluginRegistryService,
    ) {}

    /**
     * Execute the pipeline for a directory.
     *
     * This method checks for available full pipeline plugins and decides the execution mode:
     * - If a full pipeline plugin is enabled, uses full pipeline execution
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
        // Determine execution mode
        const fullPipelinePlugin = this.findFullPipelinePlugin(directory.id);
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
            const fullPipelinePlugin = this.findFullPipelinePlugin(directory.id);
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
     * @returns Recommended execution mode and reason
     */
    getRecommendedMode(directoryId?: string): {
        mode: PipelineExecutionMode;
        reason: string;
        plugin?: string;
    } {
        const fullPipelinePlugin = this.findFullPipelinePlugin(directoryId);

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
     */
    hasFullPipelinePlugin(directoryId?: string): boolean {
        return this.findFullPipelinePlugin(directoryId) !== null;
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
     * Find an enabled full pipeline plugin.
     *
     * @param directoryId - Optional directory ID for directory-specific plugin resolution
     * @returns The full pipeline plugin if found and enabled, null otherwise
     */
    private findFullPipelinePlugin(directoryId?: string): IFullPipelinePlugin | null {
        const plugins = this.registry.getByCapability('full-pipeline');

        for (const registered of plugins) {
            // Only consider enabled plugins
            if (registered.state !== 'enabled') {
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
}
