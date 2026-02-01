import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { IPlugin, PluginState, PluginContext } from '@ever-works/plugin';
import { PluginRegistryService, RegisteredPlugin } from './plugin-registry.service';
import { PluginRepository } from '../repositories/plugin.repository';
import { PluginEvents, VALID_STATE_TRANSITIONS, PluginStates } from '../plugins.constants';

export interface LifecycleResult {
    success: boolean;
    pluginId: string;
    previousState: PluginState;
    newState: PluginState;
    error?: string;
}

/**
 * Manages plugin lifecycle state transitions.
 * State machine: discovered → loaded → enabled ↔ disabled → unloaded
 */
@Injectable()
export class PluginLifecycleManagerService {
    private readonly logger = new Logger(PluginLifecycleManagerService.name);
    private contextFactory: { createContext(pluginId: string): PluginContext } | null = null;

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly pluginRepository: PluginRepository,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    setContextFactory(factory: { createContext(pluginId: string): PluginContext }): void {
        this.contextFactory = factory;
    }

    isValidTransition(from: PluginState, to: PluginState): boolean {
        const validTargets = VALID_STATE_TRANSITIONS[from];
        return validTargets?.includes(to) ?? false;
    }

    getValidTransitions(from: PluginState): PluginState[] {
        return (VALID_STATE_TRANSITIONS[from] as PluginState[]) ?? [];
    }

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
            this.registry.updateState(pluginId, 'enabling');
            await this.pluginRepository.updateState(pluginId, 'enabling');

            const context = this.getContext(pluginId);
            await registered.plugin.onEnable(context);

            this.registry.updateState(pluginId, 'enabled');
            await this.pluginRepository.updateState(pluginId, 'enabled');

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

            this.registry.updateState(pluginId, 'error', error as Error);
            await this.pluginRepository.updateState(pluginId, 'error', message);

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
            this.registry.updateState(pluginId, 'disabling');
            await this.pluginRepository.updateState(pluginId, 'disabling');

            const context = this.getContext(pluginId);
            await registered.plugin.onDisable(context);

            this.registry.updateState(pluginId, 'disabled');
            await this.pluginRepository.updateState(pluginId, 'disabled');

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

            this.registry.updateState(pluginId, 'error', error as Error);
            await this.pluginRepository.updateState(pluginId, 'error', message);

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
            const context = this.getContext(pluginId);
            await registered.plugin.onLoad(context);

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
            this.registry.updateState(pluginId, 'unloading');
            await registered.plugin.onUnload();
            this.registry.unregister(pluginId);
            await this.pluginRepository.updateState(pluginId, 'unloaded');

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

    /** Enable plugins marked with systemPlugin: true in manifest */
    async enableSystemPlugins(): Promise<LifecycleResult[]> {
        const results: LifecycleResult[] = [];
        const loaded = this.registry.getByState('loaded');

        for (const registered of loaded) {
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

    async disableAll(): Promise<LifecycleResult[]> {
        const results: LifecycleResult[] = [];
        const enabled = this.registry.getEnabled();

        for (const registered of enabled) {
            const result = await this.disable(registered.plugin.id);
            results.push(result);
        }

        return results;
    }

    async shutdownAll(): Promise<void> {
        await this.disableAll();

        for (const registered of this.registry.getAll()) {
            if (registered.state !== 'unloaded') {
                await this.unload(registered.plugin.id);
            }
        }

        this.logger.log('All plugins shut down');
    }

    getState(pluginId: string): PluginState | undefined {
        return this.registry.get(pluginId)?.state;
    }

    isInState(pluginId: string, state: PluginState): boolean {
        return this.registry.get(pluginId)?.state === state;
    }

    private getContext(pluginId: string): PluginContext {
        if (!this.contextFactory) {
            throw new Error('Context factory not initialized');
        }
        return this.contextFactory.createContext(pluginId);
    }
}
