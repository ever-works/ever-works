/**
 * NestJS Provider for DefaultPipelinePlugin
 *
 * This file provides NestJS integration for the standalone DefaultPipelinePlugin.
 * The actual plugin implementation is in @ever-works/default-pipeline-plugin package.
 *
 * @packageDocumentation
 */

import { Injectable, Logger } from '@nestjs/common';
import type { PluginContext, BuiltInStepId } from '@ever-works/plugin';
// Import from the standalone plugin package (single source of truth for built-in steps)
import {
    DefaultPipelinePlugin as StandalonePlugin,
    type IBuiltInStepExecutor,
} from '@ever-works/default-pipeline-plugin';

// Re-export types and static methods from the standalone plugin
export type { IBuiltInStepExecutor } from '@ever-works/default-pipeline-plugin';

/**
 * NestJS-injectable wrapper for DefaultPipelinePlugin.
 *
 * This class wraps the standalone DefaultPipelinePlugin to make it compatible
 * with NestJS dependency injection while keeping the actual implementation
 * in a standalone package.
 *
 * The standalone plugin is the single source of truth for:
 * - Built-in step definitions
 * - Step service mappings
 * - Type guards (isBuiltInStep)
 *
 * This wrapper provides:
 * - NestJS @Injectable() compatibility
 * - Instance methods that delegate to the standalone plugin
 */
@Injectable()
export class DefaultPipelinePlugin {
    private readonly logger = new Logger(DefaultPipelinePlugin.name);
    private readonly plugin: StandalonePlugin;

    constructor() {
        // Create an instance of the standalone plugin
        this.plugin = new StandalonePlugin();
        this.logger.log('DefaultPipelinePlugin wrapper initialized');
    }

    // ============================================================================
    // Static Methods (delegate to standalone plugin)
    // ============================================================================

    /**
     * Check if a step ID is a built-in step (type guard)
     */
    static isBuiltInStep(stepId: string): stepId is BuiltInStepId {
        return StandalonePlugin.isBuiltInStep(stepId);
    }

    /**
     * Get a built-in step definition by ID
     */
    static getBuiltInStep(stepId: BuiltInStepId) {
        return StandalonePlugin.getBuiltInStep(stepId);
    }

    /**
     * Get all built-in step IDs
     */
    static getBuiltInStepIds() {
        return StandalonePlugin.getBuiltInStepIds();
    }

    /**
     * Get all built-in step definitions (returns a copy)
     */
    static getBuiltInSteps() {
        return StandalonePlugin.getBuiltInSteps();
    }

    /**
     * Get the service name mapping for built-in steps
     */
    static getServiceMap() {
        return StandalonePlugin.getServiceMap();
    }

    /**
     * Get the service name for a specific step
     */
    static getServiceNameForStep(stepId: BuiltInStepId) {
        return StandalonePlugin.getServiceNameForStep(stepId);
    }

    // ============================================================================
    // Instance Methods (delegate to plugin instance)
    // ============================================================================

    /**
     * Initialize the plugin with context
     */
    async initialize(context: PluginContext): Promise<void> {
        await this.plugin.onLoad(context);
    }

    /**
     * Register a built-in step executor service
     */
    registerStepExecutor(stepId: BuiltInStepId, executor: IBuiltInStepExecutor): void {
        this.plugin.registerStepExecutor(stepId, executor);
    }

    /**
     * Register multiple step executors at once
     */
    registerStepExecutors(executors: Map<BuiltInStepId, IBuiltInStepExecutor>): void {
        this.plugin.registerStepExecutors(executors);
    }

    /**
     * Check if an executor is registered for a step
     */
    hasExecutor(stepId: string): boolean {
        return this.plugin.hasExecutor(stepId);
    }

    /**
     * Get the service name for a built-in step
     */
    getServiceName(stepId: BuiltInStepId): string | undefined {
        return this.plugin.getServiceName(stepId);
    }

    /**
     * Get all step definitions provided by this plugin
     */
    getStepDefinitions() {
        return this.plugin.getStepDefinitions();
    }

    /**
     * Execute a specific step by ID
     */
    async executeStep(...args: Parameters<StandalonePlugin['executeStep']>) {
        return this.plugin.executeStep(...args);
    }

    /**
     * Check if a step can be skipped
     */
    async canSkip(...args: Parameters<StandalonePlugin['canSkip']>) {
        return this.plugin.canSkip(...args);
    }

    /**
     * Validate that a step can run
     */
    async validate(...args: Parameters<StandalonePlugin['validate']>) {
        return this.plugin.validate(...args);
    }

    /**
     * Get the underlying standalone plugin instance
     */
    getPlugin(): StandalonePlugin {
        return this.plugin;
    }

    /**
     * Get plugin health check
     */
    async healthCheck() {
        return this.plugin.healthCheck();
    }

    // ============================================================================
    // Plugin Properties (expose from standalone plugin)
    // ============================================================================

    get id() {
        return this.plugin.id;
    }

    get name() {
        return this.plugin.name;
    }

    get version() {
        return this.plugin.version;
    }

    get category() {
        return this.plugin.category;
    }

    get capabilities() {
        return this.plugin.capabilities;
    }

    get systemPlugin() {
        return this.plugin.systemPlugin;
    }
}
