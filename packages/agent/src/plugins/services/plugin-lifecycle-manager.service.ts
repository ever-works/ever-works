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
 * State machine: unloaded → loading → loaded → unloading → unloaded
 *
 * Per-user/per-directory enable/disable is handled by the DB scope system
 * (UserPluginEntity.enabled, DirectoryPluginEntity.enabled, manifest.autoEnable).
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

    async shutdownAll(): Promise<void> {
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
