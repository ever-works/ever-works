import { Injectable, Logger, Optional } from '@nestjs/common';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { IAiProviderPlugin, IPlugin, JsonSchema } from '@ever-works/plugin';
import type { ModelCredentialField } from '@ever-works/contracts';
import { readPluginString } from '../plugins/services/lazy-plugin-proxy';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';

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
            if (registered.state !== 'loaded' || registered.manifest.supplementary) continue;
            const descriptor = await this.describe(
                registered.plugin,
                registered.manifest.name,
                false,
            );
            if (descriptor) descriptors.push(descriptor);
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
        return this.describe(
            registered.plugin,
            registered.manifest.name,
            registered.manifest.supplementary === true,
        );
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

    private async describe(
        candidate: IPlugin,
        manifestName: string | undefined,
        supplementary: boolean,
    ): Promise<ModelProviderDescriptor | null> {
        try {
            const plugin = (await materialize(candidate)) as IAiProviderPlugin;
            const descriptor: ModelProviderDescriptor = {
                providerPluginId: plugin.id,
                providerName: plugin.providerName || manifestName || plugin.id,
                credentialFields: secretFieldsOf(plugin.settingsSchema),
                plugin,
            };
            if (supplementary) descriptor.supplementary = true;
            return descriptor;
        } catch (error) {
            this.logger.warn(
                `Could not load AI provider ${candidate.id} for model accounts: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }
}

/**
 * Under lazy plugin loading the registry hands out a proxy whose
 * `settingsSchema` is only real after materialization — the same reason the
 * facades materialize before use.
 */
async function materialize(plugin: IPlugin): Promise<IPlugin> {
    const stub = plugin as unknown as { __materialize?: () => Promise<IPlugin> };
    return typeof stub.__materialize === 'function' ? stub.__materialize() : plugin;
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
