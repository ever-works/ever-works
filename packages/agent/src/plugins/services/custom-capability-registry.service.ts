import { Injectable, Logger } from '@nestjs/common';
import type { CustomCapabilityDefinition } from '@ever-works/plugin';

/**
 * Registered custom capability with provider info
 */
export interface RegisteredCapability {
    /**
     * Capability definition
     */
    definition: CustomCapabilityDefinition;

    /**
     * The implementation provided by the plugin
     */
    implementation: unknown;

    /**
     * ID of the plugin providing this capability
     */
    providerPluginId: string;

    /**
     * When the capability was registered
     */
    registeredAt: number;
}

/**
 * Service for managing custom capabilities registered by plugins.
 * Enables plugin-to-plugin capability sharing and discovery.
 */
@Injectable()
export class CustomCapabilityRegistryService {
    private readonly logger = new Logger(CustomCapabilityRegistryService.name);

    /**
     * Map of capability name to registered capability
     */
    private readonly capabilities = new Map<string, RegisteredCapability>();

    /**
     * Map of plugin ID to set of capability names it provides
     */
    private readonly byProvider = new Map<string, Set<string>>();

    /**
     * Register a custom capability
     */
    register(
        definition: CustomCapabilityDefinition,
        implementation: unknown,
        providerPluginId: string,
    ): void {
        const name = definition.name;

        if (this.capabilities.has(name)) {
            const existing = this.capabilities.get(name)!;
            throw new Error(
                `Capability "${name}" is already registered by plugin "${existing.providerPluginId}"`,
            );
        }

        const registered: RegisteredCapability = {
            definition,
            implementation,
            providerPluginId,
            registeredAt: Date.now(),
        };

        // Add to main registry
        this.capabilities.set(name, registered);

        // Index by provider
        if (!this.byProvider.has(providerPluginId)) {
            this.byProvider.set(providerPluginId, new Set());
        }
        this.byProvider.get(providerPluginId)!.add(name);

        this.logger.debug(
            `Registered custom capability "${name}" from plugin "${providerPluginId}"`,
        );
    }

    /**
     * Unregister a custom capability
     */
    unregister(name: string): boolean {
        const registered = this.capabilities.get(name);
        if (!registered) {
            return false;
        }

        // Remove from provider index
        const providerSet = this.byProvider.get(registered.providerPluginId);
        if (providerSet) {
            providerSet.delete(name);
            if (providerSet.size === 0) {
                this.byProvider.delete(registered.providerPluginId);
            }
        }

        // Remove from main registry
        this.capabilities.delete(name);

        this.logger.debug(`Unregistered custom capability "${name}"`);

        return true;
    }

    /**
     * Unregister all capabilities provided by a plugin
     */
    unregisterByProvider(pluginId: string): string[] {
        const capabilityNames = this.byProvider.get(pluginId);
        if (!capabilityNames) {
            return [];
        }

        const unregistered: string[] = [];
        for (const name of capabilityNames) {
            this.capabilities.delete(name);
            unregistered.push(name);
        }

        this.byProvider.delete(pluginId);

        this.logger.debug(
            `Unregistered ${unregistered.length} capabilities from plugin "${pluginId}"`,
        );

        return unregistered;
    }

    /**
     * Get a registered capability by name
     */
    get(name: string): RegisteredCapability | undefined {
        return this.capabilities.get(name);
    }

    /**
     * Get the implementation of a capability
     */
    getImplementation<T = unknown>(name: string): T | undefined {
        const registered = this.capabilities.get(name);
        return registered?.implementation as T | undefined;
    }

    /**
     * Check if a capability is registered
     */
    has(name: string): boolean {
        return this.capabilities.has(name);
    }

    /**
     * List all registered capabilities
     */
    list(): CustomCapabilityDefinition[] {
        return Array.from(this.capabilities.values()).map((r) => r.definition);
    }

    /**
     * List all registered capabilities with full info
     */
    listWithInfo(): RegisteredCapability[] {
        return Array.from(this.capabilities.values());
    }

    /**
     * Get all capability names
     */
    getNames(): string[] {
        return Array.from(this.capabilities.keys());
    }

    /**
     * Get capabilities provided by a specific plugin
     */
    getByProvider(pluginId: string): RegisteredCapability[] {
        const names = this.byProvider.get(pluginId);
        if (!names) {
            return [];
        }

        return Array.from(names)
            .map((name) => this.capabilities.get(name))
            .filter((c): c is RegisteredCapability => c !== undefined);
    }

    /**
     * Get the provider plugin ID for a capability
     */
    getProvider(name: string): string | undefined {
        return this.capabilities.get(name)?.providerPluginId;
    }

    /**
     * Get count of registered capabilities
     */
    count(): number {
        return this.capabilities.size;
    }

    /**
     * Clear all capabilities (mainly for testing)
     */
    clear(): void {
        this.capabilities.clear();
        this.byProvider.clear();
        this.logger.warn('Custom capability registry cleared');
    }

    /**
     * Find capabilities matching a filter
     */
    find(filter: { providerPluginId?: string }): RegisteredCapability[] {
        let results = Array.from(this.capabilities.values());

        if (filter.providerPluginId) {
            results = results.filter((r) => r.providerPluginId === filter.providerPluginId);
        }

        return results;
    }
}
