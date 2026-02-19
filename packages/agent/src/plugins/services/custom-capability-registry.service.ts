import { Injectable, Logger } from '@nestjs/common';
import type { CustomCapabilityDefinition } from '@ever-works/plugin';

/**
 * Registered custom capability with provider info
 */
export interface RegisteredCapability {
    definition: CustomCapabilityDefinition;
    implementation: unknown;
    providerPluginId: string;
    registeredAt: number;
}

/**
 * Runtime registry for plugin-to-plugin capability sharing via context.registerCustomCapability().
 * Not to be confused with the CUSTOM_CAPABILITY plugin capability string (removed).
 */
@Injectable()
export class CustomCapabilityRegistryService {
    private readonly logger = new Logger(CustomCapabilityRegistryService.name);
    private readonly capabilities = new Map<string, RegisteredCapability>();
    private readonly byProvider = new Map<string, Set<string>>();

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

        this.capabilities.set(name, registered);

        if (!this.byProvider.has(providerPluginId)) {
            this.byProvider.set(providerPluginId, new Set());
        }
        this.byProvider.get(providerPluginId)!.add(name);

        this.logger.debug(
            `Registered custom capability "${name}" from plugin "${providerPluginId}"`,
        );
    }

    unregister(name: string): boolean {
        const registered = this.capabilities.get(name);
        if (!registered) return false;

        const providerSet = this.byProvider.get(registered.providerPluginId);
        if (providerSet) {
            providerSet.delete(name);
            if (providerSet.size === 0) {
                this.byProvider.delete(registered.providerPluginId);
            }
        }

        this.capabilities.delete(name);
        this.logger.debug(`Unregistered custom capability "${name}"`);
        return true;
    }

    unregisterByProvider(pluginId: string): string[] {
        const capabilityNames = this.byProvider.get(pluginId);
        if (!capabilityNames) return [];

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

    get(name: string): RegisteredCapability | undefined {
        return this.capabilities.get(name);
    }

    getImplementation<T = unknown>(name: string): T | undefined {
        return this.capabilities.get(name)?.implementation as T | undefined;
    }

    has(name: string): boolean {
        return this.capabilities.has(name);
    }

    list(): CustomCapabilityDefinition[] {
        return Array.from(this.capabilities.values()).map((r) => r.definition);
    }

    listWithInfo(): RegisteredCapability[] {
        return Array.from(this.capabilities.values());
    }

    getByProvider(pluginId: string): RegisteredCapability[] {
        const names = this.byProvider.get(pluginId);
        if (!names) return [];

        return Array.from(names)
            .map((name) => this.capabilities.get(name))
            .filter((c): c is RegisteredCapability => c !== undefined);
    }

    getProvider(name: string): string | undefined {
        return this.capabilities.get(name)?.providerPluginId;
    }

    clear(): void {
        this.capabilities.clear();
        this.byProvider.clear();
        this.logger.warn('Custom capability registry cleared');
    }
}
