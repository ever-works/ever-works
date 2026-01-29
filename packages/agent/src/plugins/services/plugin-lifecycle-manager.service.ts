import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { IPlugin, PluginState, PluginContext } from '@ever-works/plugin';
import { PluginRegistryService, RegisteredPlugin } from './plugin-registry.service';
import { PluginRepository } from '../repositories/plugin.repository';
import { PluginEvents, VALID_STATE_TRANSITIONS, PluginStates } from '../plugins.constants';

/**
 * Result of a lifecycle operation
 */
export interface LifecycleResult {
    success: boolean;
    pluginId: string;
    previousState: PluginState;
    newState: PluginState;
    error?: string;
}

/**
 * Service for managing plugin lifecycle state transitions.
 * Handles the state machine: discovered → loaded → enabled ↔ disabled → unloaded
 */
@Injectable()
export class PluginLifecycleManagerService {
    private readonly logger = new Logger(PluginLifecycleManagerService.name);

    /**
     * Context factory is injected lazily to avoid circular dependency
     */
    private contextFactory: { createContext(pluginId: string): PluginContext } | null = null;

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly pluginRepository: PluginRepository,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    /**
     * Set the context factory (called by PluginsModule after initialization)
     */
    setContextFactory(factory: { createContext(pluginId: string): PluginContext }): void {
        this.contextFactory = factory;
    }

    /**
     * Check if a state transition is valid
     */
    isValidTransition(from: PluginState, to: PluginState): boolean {
        const validTargets = VALID_STATE_TRANSITIONS[from];
        return validTargets?.includes(to) ?? false;
    }

    /**
     * Get valid target states for a given state
     */
    getValidTransitions(from: PluginState): PluginState[] {
        return (VALID_STATE_TRANSITIONS[from] as PluginState[]) ?? [];
    }

    /**
     * Enable a plugin
     */
    async enable(pluginId: string): Promise<LifecycleResult> {
        const registered = this.registry.get(pluginId);
        if (!registered) {
            return {
                success: false,
                pluginId,
                previousState: 'unloaded',
                newState: 'unloaded',
                error: `Plugin "${pluginId}" not found`,
            };
        }

        const previousState = registered.state;

        // Check valid transition
        if (!this.isValidTransition(previousState, 'enabling')) {
            return {
                success: false,
                pluginId,
                previousState,
                newState: previousState,
                error: `Cannot enable plugin from state "${previousState}"`,
            };
        }

        try {
            // Transition to enabling state
            this.registry.updateState(pluginId, 'enabling');
            await this.pluginRepository.updateState(pluginId, 'enabling');

            // Get context for the plugin
            const context = this.getContext(pluginId);

            // Call plugin's onEnable
            await registered.plugin.onEnable(context);

            // Transition to enabled state
            this.registry.updateState(pluginId, 'enabled');
            await this.pluginRepository.updateState(pluginId, 'enabled');

            // Emit event
            this.eventEmitter.emit(PluginEvents.ENABLED, {
                pluginId,
                version: registered.manifest.version,
                timestamp: Date.now(),
            });

            this.logger.log(`Plugin enabled: ${pluginId}`);

            return {
                success: true,
                pluginId,
                previousState,
                newState: 'enabled',
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to enable plugin ${pluginId}:`, error);

            // Transition to error state
            this.registry.updateState(pluginId, 'error', error as Error);
            await this.pluginRepository.updateState(pluginId, 'error', message);

            // Emit error event
            this.eventEmitter.emit(PluginEvents.ERROR, {
                pluginId,
                version: registered.manifest.version,
                error: message,
                context: 'enable',
                timestamp: Date.now(),
            });

            return {
                success: false,
                pluginId,
                previousState,
                newState: 'error',
                error: message,
            };
        }
    }

    /**
     * Disable a plugin
     */
    async disable(pluginId: string): Promise<LifecycleResult> {
        const registered = this.registry.get(pluginId);
        if (!registered) {
            return {
                success: false,
                pluginId,
                previousState: 'unloaded',
                newState: 'unloaded',
                error: `Plugin "${pluginId}" not found`,
            };
        }

        const previousState = registered.state;

        // Check valid transition
        if (!this.isValidTransition(previousState, 'disabling')) {
            return {
                success: false,
                pluginId,
                previousState,
                newState: previousState,
                error: `Cannot disable plugin from state "${previousState}"`,
            };
        }

        try {
            // Transition to disabling state
            this.registry.updateState(pluginId, 'disabling');
            await this.pluginRepository.updateState(pluginId, 'disabling');

            // Get context for the plugin
            const context = this.getContext(pluginId);

            // Call plugin's onDisable
            await registered.plugin.onDisable(context);

            // Transition to disabled state
            this.registry.updateState(pluginId, 'disabled');
            await this.pluginRepository.updateState(pluginId, 'disabled');

            // Emit event
            this.eventEmitter.emit(PluginEvents.DISABLED, {
                pluginId,
                version: registered.manifest.version,
                timestamp: Date.now(),
            });

            this.logger.log(`Plugin disabled: ${pluginId}`);

            return {
                success: true,
                pluginId,
                previousState,
                newState: 'disabled',
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to disable plugin ${pluginId}:`, error);

            // Transition to error state
            this.registry.updateState(pluginId, 'error', error as Error);
            await this.pluginRepository.updateState(pluginId, 'error', message);

            // Emit error event
            this.eventEmitter.emit(PluginEvents.ERROR, {
                pluginId,
                version: registered.manifest.version,
                error: message,
                context: 'disable',
                timestamp: Date.now(),
            });

            return {
                success: false,
                pluginId,
                previousState,
                newState: 'error',
                error: message,
            };
        }
    }

    /**
     * Call onLoad for a plugin (called after loading from disk)
     */
    async callOnLoad(pluginId: string): Promise<LifecycleResult> {
        const registered = this.registry.get(pluginId);
        if (!registered) {
            return {
                success: false,
                pluginId,
                previousState: 'unloaded',
                newState: 'unloaded',
                error: `Plugin "${pluginId}" not found`,
            };
        }

        const previousState = registered.state;

        // Should only be called on loading state
        if (previousState !== 'loading' && previousState !== 'loaded') {
            return {
                success: false,
                pluginId,
                previousState,
                newState: previousState,
                error: `onLoad should only be called in loading/loaded state, current: "${previousState}"`,
            };
        }

        try {
            // Get context for the plugin
            const context = this.getContext(pluginId);

            // Call plugin's onLoad
            await registered.plugin.onLoad(context);

            // Emit event
            this.eventEmitter.emit(PluginEvents.LOADED, {
                pluginId,
                version: registered.manifest.version,
                timestamp: Date.now(),
            });

            this.logger.debug(`Plugin onLoad called: ${pluginId}`);

            return {
                success: true,
                pluginId,
                previousState,
                newState: 'loaded',
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to call onLoad for plugin ${pluginId}:`, error);

            // Transition to error state
            this.registry.updateState(pluginId, 'error', error as Error);
            await this.pluginRepository.updateState(pluginId, 'error', message);

            return {
                success: false,
                pluginId,
                previousState,
                newState: 'error',
                error: message,
            };
        }
    }

    /**
     * Unload a plugin (call onUnload and remove from registry)
     */
    async unload(pluginId: string): Promise<LifecycleResult> {
        const registered = this.registry.get(pluginId);
        if (!registered) {
            return {
                success: false,
                pluginId,
                previousState: 'unloaded',
                newState: 'unloaded',
                error: `Plugin "${pluginId}" not found`,
            };
        }

        const previousState = registered.state;

        // Check valid transition
        if (!this.isValidTransition(previousState, 'unloading')) {
            return {
                success: false,
                pluginId,
                previousState,
                newState: previousState,
                error: `Cannot unload plugin from state "${previousState}"`,
            };
        }

        try {
            // Transition to unloading state
            this.registry.updateState(pluginId, 'unloading');

            // Call plugin's onUnload
            await registered.plugin.onUnload();

            // Remove from registry
            this.registry.unregister(pluginId);

            // Update database
            await this.pluginRepository.updateState(pluginId, 'unloaded');

            // Emit event
            this.eventEmitter.emit(PluginEvents.UNLOADED, {
                pluginId,
                version: registered.manifest.version,
                timestamp: Date.now(),
            });

            this.logger.log(`Plugin unloaded: ${pluginId}`);

            return {
                success: true,
                pluginId,
                previousState,
                newState: 'unloaded',
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to unload plugin ${pluginId}:`, error);

            // Still remove from registry
            this.registry.unregister(pluginId);
            await this.pluginRepository.updateState(pluginId, 'error', message);

            return {
                success: false,
                pluginId,
                previousState,
                newState: 'error',
                error: message,
            };
        }
    }

    /**
     * Enable all loaded plugins
     */
    async enableAll(): Promise<LifecycleResult[]> {
        const results: LifecycleResult[] = [];
        const loaded = this.registry.getByState('loaded');
        const disabled = this.registry.getByState('disabled');

        for (const registered of [...loaded, ...disabled]) {
            const result = await this.enable(registered.plugin.id);
            results.push(result);
        }

        return results;
    }

    /**
     * Enable all system plugins.
     * System plugins are plugins marked with systemPlugin: true in their manifest
     * that should always be enabled and cannot be disabled by users.
     */
    async enableSystemPlugins(): Promise<LifecycleResult[]> {
        const results: LifecycleResult[] = [];

        // Get all loaded plugins
        const loaded = this.registry.getByState('loaded');

        for (const registered of loaded) {
            // Check if it's a system plugin
            const isSystemPlugin =
                registered.manifest.systemPlugin ||
                (registered.plugin as { systemPlugin?: boolean }).systemPlugin;

            if (isSystemPlugin) {
                const result = await this.enable(registered.plugin.id);
                results.push(result);

                if (result.success) {
                    this.logger.log(`Auto-enabled system plugin: ${registered.plugin.id}`);
                } else {
                    this.logger.error(
                        `Failed to auto-enable system plugin ${registered.plugin.id}: ${result.error}`,
                    );
                }
            }
        }

        return results;
    }

    /**
     * Disable all enabled plugins
     */
    async disableAll(): Promise<LifecycleResult[]> {
        const results: LifecycleResult[] = [];
        const enabled = this.registry.getEnabled();

        for (const registered of enabled) {
            const result = await this.disable(registered.plugin.id);
            results.push(result);
        }

        return results;
    }

    /**
     * Shutdown all plugins (disable and unload)
     */
    async shutdownAll(): Promise<void> {
        // Disable all enabled plugins first
        await this.disableAll();

        // Unload all remaining plugins
        for (const registered of this.registry.getAll()) {
            if (registered.state !== 'unloaded') {
                await this.unload(registered.plugin.id);
            }
        }

        this.logger.log('All plugins shut down');
    }

    /**
     * Get the current state of a plugin
     */
    getState(pluginId: string): PluginState | undefined {
        return this.registry.get(pluginId)?.state;
    }

    /**
     * Check if a plugin is in a specific state
     */
    isInState(pluginId: string, state: PluginState): boolean {
        return this.registry.get(pluginId)?.state === state;
    }

    /**
     * Get context for a plugin
     */
    private getContext(pluginId: string): PluginContext {
        if (!this.contextFactory) {
            throw new Error('Context factory not initialized');
        }
        return this.contextFactory.createContext(pluginId);
    }
}
