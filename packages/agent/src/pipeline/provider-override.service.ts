import { Injectable, Logger } from '@nestjs/common';
import type { ISubProviderPlugin, IPlugin } from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';

/**
 * Type guard for sub-provider plugins (inlined to avoid ESM import issues)
 */
function isSubProviderPlugin(plugin: IPlugin): plugin is ISubProviderPlugin {
    return plugin.capabilities.includes(PLUGIN_CAPABILITIES.SUB_PROVIDER);
}

/**
 * Provider override context for determining which sub-provider to use
 */
export interface ProviderOverrideContext {
    /** Directory ID */
    directoryId?: string;
    /** User ID */
    userId?: string;
    /** Operation or step being performed */
    operation: string;
    /** Additional context data */
    data?: Record<string, unknown>;
}

/**
 * Result of provider override resolution
 */
export interface ProviderOverrideResult {
    /** The resolved sub-provider plugin (if any) */
    provider: ISubProviderPlugin | null;
    /** Why this provider was selected */
    reason: string;
    /** Priority of the selected provider */
    priority?: number;
}

/**
 * Service for resolving provider overrides for pipeline steps.
 *
 * This service handles sub-provider selection for specific pipeline steps,
 * such as selecting which AI model to use for categorization or which
 * search provider to use for web search.
 *
 * Sub-providers extend a parent capability (e.g., multiple AI models under ai-provider)
 * and can be selected based on context (directory, user, operation).
 */
@Injectable()
export class ProviderOverrideService {
    private readonly logger = new Logger(ProviderOverrideService.name);

    constructor(private readonly registry: PluginRegistryService) {}

    /**
     * Get the provider for a specific step/operation.
     *
     * @param context - Context for provider resolution
     * @returns The selected sub-provider or null if none available
     */
    async getProviderForStep(context: ProviderOverrideContext): Promise<ProviderOverrideResult> {
        const { operation, directoryId, userId } = context;

        this.logger.debug(
            `Resolving provider for operation "${operation}"` +
                (directoryId ? ` (directory: ${directoryId})` : '') +
                (userId ? ` (user: ${userId})` : ''),
        );

        // Get all enabled sub-provider plugins
        const subProviders = this.getEnabledSubProviders();

        if (subProviders.length === 0) {
            return {
                provider: null,
                reason: 'No sub-provider plugins enabled',
            };
        }

        // Find providers that can handle this context
        const candidates: Array<{ plugin: ISubProviderPlugin; priority: number }> = [];

        for (const plugin of subProviders) {
            try {
                const canHandle = await plugin.canHandle({
                    directoryId,
                    userId,
                    operation,
                    data: context.data,
                });

                if (canHandle) {
                    const priority = plugin.getPriority({
                        directoryId,
                        userId,
                        operation,
                        data: context.data,
                    });
                    candidates.push({ plugin, priority });
                }
            } catch (error) {
                this.logger.warn(
                    `Sub-provider "${plugin.id}" failed to check canHandle: ${(error as Error).message}`,
                );
            }
        }

        if (candidates.length === 0) {
            return {
                provider: null,
                reason: `No sub-providers can handle operation "${operation}"`,
            };
        }

        // Sort by priority (lower is better) and select the first
        candidates.sort((a, b) => a.priority - b.priority);
        const selected = candidates[0];

        this.logger.debug(
            `Selected sub-provider "${selected.plugin.id}" for operation "${operation}" (priority: ${selected.priority})`,
        );

        return {
            provider: selected.plugin,
            reason: `Selected based on priority (${selected.priority})`,
            priority: selected.priority,
        };
    }

    /**
     * Get enabled sub-provider plugins.
     */
    private getEnabledSubProviders(): ISubProviderPlugin[] {
        const registered = this.registry.getByCapability(PLUGIN_CAPABILITIES.SUB_PROVIDER);

        return registered
            .filter((r) => r.state === 'loaded')
            .map((r) => r.plugin)
            .filter(isSubProviderPlugin);
    }
}
