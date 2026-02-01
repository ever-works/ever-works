/**
 * NestJS Provider for DefaultPipelinePlugin
 *
 * This file provides NestJS integration for the standalone DefaultPipelinePlugin.
 * The actual plugin implementation is in @ever-works/default-pipeline-plugin package.
 *
 * @packageDocumentation
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { PluginContext, IBuiltInStepExecutor } from '@ever-works/plugin';
// Import from the standalone plugin package (single source of truth for built-in steps)
import { DefaultPipelinePlugin as StandalonePlugin } from '@ever-works/default-pipeline-plugin';
import type { BuiltInStepId } from '@ever-works/default-pipeline-plugin';

// Re-export types from plugin package
export type { IBuiltInStepExecutor } from '@ever-works/plugin';

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
 * - Step executors (registered in the standalone plugin's onLoad)
 * - Type guards (isBuiltInStep)
 *
 * This wrapper provides:
 * - NestJS @Injectable() compatibility
 * - Instance methods that delegate to the standalone plugin
 * - Plugin lifecycle integration with NestJS
 */
@Injectable()
export class DefaultPipelinePlugin implements OnModuleInit {
    private readonly logger = new Logger(DefaultPipelinePlugin.name);
    private readonly plugin: StandalonePlugin;

    constructor() {
        // Create an instance of the standalone plugin
        this.plugin = new StandalonePlugin();
        this.logger.log('DefaultPipelinePlugin wrapper initialized');
    }

    /**
     * Initialize the plugin when the NestJS module initializes.
     * This triggers the standalone plugin's onLoad which registers all step executors.
     */
    async onModuleInit(): Promise<void> {
        // Create a minimal plugin context for initialization
        // The context is primarily used for logging during plugin load
        const pluginContext = this.createMinimalPluginContext();

        // Initialize the standalone plugin - this registers all step executors
        await this.plugin.onLoad(pluginContext);
        this.logger.log('DefaultPipelinePlugin initialized with step executors');
    }

    /**
     * Create a minimal PluginContext for plugin initialization.
     * This provides the necessary interfaces for the plugin to initialize.
     */
    private createMinimalPluginContext(): PluginContext {
        const noopCache = {
            get: async () => undefined,
            set: async () => {},
            delete: async () => false,
            has: async () => false,
            clear: async () => {},
        };

        const noopHttp = {
            get: async () => ({
                status: 501,
                statusText: 'Not Implemented',
                headers: {},
                data: null,
            }),
            post: async () => ({
                status: 501,
                statusText: 'Not Implemented',
                headers: {},
                data: null,
            }),
            put: async () => ({
                status: 501,
                statusText: 'Not Implemented',
                headers: {},
                data: null,
            }),
            patch: async () => ({
                status: 501,
                statusText: 'Not Implemented',
                headers: {},
                data: null,
            }),
            delete: async () => ({
                status: 501,
                statusText: 'Not Implemented',
                headers: {},
                data: null,
            }),
        };

        return {
            pluginId: 'default-pipeline',
            logger: {
                log: (msg: string) => this.logger.log(msg),
                debug: (msg: string) => this.logger.debug(msg),
                warn: (msg: string) => this.logger.warn(msg),
                error: (msg: string) => this.logger.error(msg),
            },
            cache: noopCache,
            http: noopHttp,
            env: {
                platform: 'ever-works',
                platformVersion: '1.0.0',
                nodeVersion: process.version,
                isDevelopment: process.env.NODE_ENV === 'development',
                isProduction: process.env.NODE_ENV === 'production',
                isTest: process.env.NODE_ENV === 'test',
                tempDir: '/tmp',
                dataDir: '/tmp/plugins/default-pipeline',
                features: new Set<string>(),
            },
            envVars: {
                get: (key: string) => process.env[key],
                getOrDefault: (key: string, defaultValue: string) =>
                    process.env[key] ?? defaultValue,
                has: (key: string) => key in process.env,
                getRequired: (key: string) => {
                    const value = process.env[key];
                    if (value === undefined) throw new Error(`Required env var ${key} not set`);
                    return value;
                },
            },
            services: {},
            getSettings: async () => ({}),
            getResolvedSettings: async () => ({}) as never,
            onEvent: () => ({ unsubscribe: () => {} }),
            emitEvent: () => {},
            registerCustomCapability: () => {},
            getCustomCapability: () => undefined,
            hasCustomCapability: () => false,
            listCustomCapabilities: () => [],
        };
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
    hasExecutor(stepId: BuiltInStepId): boolean {
        return this.plugin.hasExecutor(stepId);
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
