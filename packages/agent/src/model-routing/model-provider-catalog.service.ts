import { Injectable, Logger, Optional } from '@nestjs/common';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { IAiProviderPlugin, JsonSchema } from '@ever-works/plugin';
import type { ModelCredentialField } from '@ever-works/contracts';
import { readPluginString } from '../plugins/services/lazy-plugin-proxy';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import { materializeUsablePlugin } from '../plugins/services/plugin-operation.util';

/** An installed AI-provider plugin, as the model-accounts surface needs it. */
export interface ModelProviderDescriptor {
    providerPluginId: string;
    providerName: string;
    /** The plugin's secret (`x-secret`) settings, in schema order. */
    credentialFields: ModelCredentialField[];
    plugin: IAiProviderPlugin;
    /**
     * The plugin's manifest marks it supplementary (auto-activated, never
     * user-selectable). Such a provider is left out of {@link
     * ModelProviderCatalogService.listProviders}, and an account cannot be
     * added for it; routing and health checks still resolve it by id.
     */
    supplementary?: boolean;
}

/**
 * Model accounts (AW-16) — the providers accounts can be held for.
 *
 * The list is exactly the loaded plugins that declare the ai-provider
 * capability; core holds no list of its own and names no provider. A
 * provider's credential fields are the settings its own schema marks
 * `x-secret` — so a provider that authenticates with several secrets, or with
 * something other than a single key, needs no change here.
 *
 * `baseUrl` and every other non-secret setting is deliberately NOT an account
 * field: an account supplies credentials for the provider the operator
 * configured, it never repoints where calls go.
 */
@Injectable()
export class ModelProviderCatalogService {
    private readonly logger = new Logger(ModelProviderCatalogService.name);

    constructor(@Optional() private readonly registry?: PluginRegistryService) {}

    async listProviders(): Promise<ModelProviderDescriptor[]> {
        if (!this.registry) return [];
        const descriptors: ModelProviderDescriptor[] = [];
        for (const registered of this.registry.getByCapability(PLUGIN_CAPABILITIES.AI_PROVIDER)) {
            // A package.json `supplementary` is final: no need to load it.
            if (registered.state !== 'loaded' || registered.manifest.supplementary) continue;
            const descriptor = await this.describe(registered);
            // `supplementary` read after the load: getManifest() may set it.
            if (descriptor && !descriptor.supplementary) descriptors.push(descriptor);
        }
        return descriptors;
    }

    /** The provider, or null when no loaded ai-provider plugin has this id. */
    async getProvider(providerPluginId: string): Promise<ModelProviderDescriptor | null> {
        const registered = this.registry?.get(providerPluginId);
        if (
            !registered ||
            registered.state !== 'loaded' ||
            !registered.manifest.capabilities.includes(PLUGIN_CAPABILITIES.AI_PROVIDER)
        ) {
            return null;
        }
        return this.describe(registered);
    }

    /** Display name for a provider id; the id itself when the plugin is gone. */
    providerName(providerPluginId: string): string {
        const registered = this.registry?.get(providerPluginId);
        if (!registered) return providerPluginId;
        // Sync, so the plugin may still be a cold lazy proxy, whose
        // `providerName` read is its forwarding wrapper: the manifest name then.
        return (
            readPluginString(registered.plugin, 'providerName') ||
            registered.manifest.name ||
            providerPluginId
        );
    }

    /**
     * The descriptor of a registered AI provider, read once it has LOADED:
     * under lazy plugin loading the registry hands out a proxy whose
     * `settingsSchema` is only real after materialization (the same reason the
     * facades materialize before use), and whose entry carries the manifest
     * fields the class's getManifest() adds — `supplementary` among them —
     * only then. `null` when the provider cannot be used: its import fails, or
     * its onLoad fails on this first use (the entry turns `error`; the eager
     * boot skipped such a plugin).
     */
    private async describe(registered: RegisteredPlugin): Promise<ModelProviderDescriptor | null> {
        const pluginId = registered.plugin.id;
        const plugin = await materializeUsablePlugin<IAiProviderPlugin>(
            registered,
            pluginId,
            (reason) =>
                this.logger.warn(
                    `Could not load AI provider ${pluginId} for model accounts: ${reason}`,
                ),
        );
        if (!plugin) return null;
        const descriptor: ModelProviderDescriptor = {
            providerPluginId: plugin.id,
            providerName: plugin.providerName || registered.manifest.name || plugin.id,
            credentialFields: secretFieldsOf(plugin.settingsSchema),
            plugin,
        };
        if (registered.manifest.supplementary === true) descriptor.supplementary = true;
        return descriptor;
    }
}

/** The `x-secret` properties of a settings schema, as credential fields. */
export function secretFieldsOf(schema: JsonSchema | undefined): ModelCredentialField[] {
    const properties = (schema?.properties ?? {}) as Record<string, JsonSchema>;
    const fields: ModelCredentialField[] = [];
    for (const [key, property] of Object.entries(properties)) {
        const extended = property as JsonSchema & { 'x-secret'?: boolean };
        if (extended['x-secret'] !== true) continue;
        fields.push({
            key,
            title: typeof extended.title === 'string' && extended.title ? extended.title : key,
            description: typeof extended.description === 'string' ? extended.description : null,
        });
    }
    return fields;
}
