import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    PluginRegistryService,
    RegisteredPlugin,
} from '@src/plugins/services/plugin-registry.service';
import { DirectoryPluginRepository } from '@src/plugins/repositories/directory-plugin.repository';
import type {
    GeneratorFormSchema,
    ProviderOption,
    FormFieldDefinition,
    FormFieldGroup,
    ValidationResult,
} from '@ever-works/plugin';
import { isFormSchemaProvider, SELECTABLE_PROVIDER_CATEGORIES } from '@ever-works/plugin';

/**
 * Service for resolving dynamic generator form schema based on selected plugins.
 *
 * This service queries the plugin registry to:
 * 1. Get available providers for each capability category
 * 2. Resolve form fields from the selected pipeline plugin
 * 3. Return a complete GeneratorFormSchema for the frontend
 */
/**
 * Options for form schema generation.
 */
export interface FormSchemaOptions {
    /** Directory ID for enable filtering and default provider resolution */
    directoryId?: string;
    /** User ID for enable filtering */
    userId?: string;
}

@Injectable()
export class GeneratorFormSchemaService {
    private readonly logger = new Logger(GeneratorFormSchemaService.name);

    constructor(
        private readonly pluginRegistry: PluginRegistryService,
        @Optional() private readonly directoryPluginRepository?: DirectoryPluginRepository,
    ) {}

    /**
     * Get the generator form schema based on the selected pipeline.
     *
     * When directoryId is provided, providers are filtered by enable status
     * and default providers are marked based on activeCapability.
     *
     * @param pipelineId - Selected pipeline plugin ID (null for default)
     * @param options - Optional directoryId and userId for filtering
     * @returns Complete form schema for rendering the generator form
     */
    async getFormSchema(
        pipelineId?: string,
        options?: FormSchemaOptions,
    ): Promise<GeneratorFormSchema> {
        // Get available providers for each capability category (filtered by enable status)
        const providers = await this.getAvailableProviders(options);

        // Resolve the selected pipeline plugin
        const pipelinePlugin = this.resolvePipelinePlugin(pipelineId);

        // Get form fields and groups from the pipeline plugin
        let pluginFields: FormFieldDefinition[] = [];
        let pluginGroups: FormFieldGroup[] | undefined;
        let handledConfigFields: readonly string[] = [];
        let defaultValues: Record<string, unknown> | undefined;

        if (pipelinePlugin && isFormSchemaProvider(pipelinePlugin.plugin)) {
            const provider = pipelinePlugin.plugin;

            pluginFields = provider.getFormFields();
            pluginGroups = provider.getFormGroups?.();
            handledConfigFields = provider.handledConfigFields ?? [];
            defaultValues = provider.getDefaultValues?.();

            this.logger.debug(
                `Resolved ${pluginFields.length} form fields from plugin: ${pipelinePlugin.plugin.id}`,
            );
        }

        return {
            providers,
            pluginFields,
            pluginGroups,
            handledConfigFields,
            defaultValues,
        };
    }

    /**
     * Validate form values against the selected pipeline's schema.
     *
     * @param pipelineId - Selected pipeline plugin ID
     * @param values - Form values to validate
     * @returns Validation result
     */
    async validateFormValues(
        pipelineId: string | undefined,
        values: Record<string, unknown>,
    ): Promise<ValidationResult> {
        const pipelinePlugin = this.resolvePipelinePlugin(pipelineId);

        if (!pipelinePlugin || !isFormSchemaProvider(pipelinePlugin.plugin)) {
            return { valid: true };
        }

        return pipelinePlugin.plugin.validateFormInput(values);
    }

    /**
     * Get available providers for all capability categories.
     * Filters by enable status and marks default providers based on activeCapability.
     */
    private async getAvailableProviders(
        options?: FormSchemaOptions,
    ): Promise<GeneratorFormSchema['providers']> {
        const { search, screenshot, ai, contentExtractor, fullPipeline } =
            SELECTABLE_PROVIDER_CATEGORIES;

        const [
            searchProviders,
            screenshotProviders,
            aiProviders,
            contentExtractorProviders,
            fullPipelineProviders,
        ] = await Promise.all([
            this.getProvidersForCapability(search.capability, options),
            this.getProvidersForCapability(screenshot.capability, options),
            this.getProvidersForCapability(ai.capability, options),
            this.getProvidersForCapability(contentExtractor.capability, options),
            this.getProvidersForCapability(fullPipeline.capability, options),
        ]);

        return {
            search: searchProviders,
            screenshot: screenshotProviders,
            ai: aiProviders,
            contentExtractor: contentExtractorProviders,
            fullPipeline: fullPipelineProviders,
        };
    }

    /**
     * Get enabled provider options for a specific capability.
     *
     * When directoryId is provided:
     * - Filters plugins by enable status (Directory > User > autoEnable)
     * - Marks the default provider based on activeCapability
     */
    private async getProvidersForCapability(
        capability: string,
        options?: FormSchemaOptions,
    ): Promise<ProviderOption[]> {
        const plugins = this.pluginRegistry.getByCapability(capability);
        const enabledPlugins = plugins.filter((p) => p.state === 'loaded');
        const result: ProviderOption[] = [];

        // Get the active (default) plugin for this capability in the directory
        let activePluginId: string | null = null;
        if (options?.directoryId && this.directoryPluginRepository) {
            try {
                const activePlugin = await this.directoryPluginRepository.findActiveByCapability(
                    options.directoryId,
                    capability,
                );
                if (activePlugin) {
                    activePluginId = activePlugin.pluginId;
                }
            } catch {
                // No active plugin set
            }
        }

        for (const registered of enabledPlugins) {
            // Check if plugin is enabled for this context
            if (options?.directoryId || options?.userId) {
                const isEnabled = await this.pluginRegistry.isPluginEnabledForScope(
                    registered.plugin.id,
                    options.directoryId,
                    options.userId,
                );
                if (!isEnabled) {
                    continue;
                }
            }

            result.push(this.toProviderOption(registered, activePluginId));
        }

        return result;
    }

    /**
     * Convert a registered plugin to a provider option.
     */
    private toProviderOption(
        registered: RegisteredPlugin,
        activePluginId?: string | null,
    ): ProviderOption {
        const { plugin, manifest } = registered;

        // Mark as default if:
        // 1. It's the active plugin for the directory (via activeCapability)
        // 2. OR it's a system plugin (if no active plugin is set)
        const isDefault = activePluginId
            ? plugin.id === activePluginId
            : manifest.systemPlugin || false;

        return {
            id: plugin.id,
            name: manifest.name,
            description: manifest.description,
            configured: true, // Plugin is enabled, so it's configured
            isDefault,
            icon: manifest.icon,
        };
    }

    /**
     * Resolve the pipeline plugin to use for form fields.
     */
    private resolvePipelinePlugin(pipelineId?: string): RegisteredPlugin | undefined {
        if (pipelineId) {
            const registered = this.pluginRegistry.get(pipelineId);
            if (registered && registered.state === 'loaded') {
                return registered;
            }
            this.logger.warn(`Pipeline plugin not found or not enabled: ${pipelineId}`);
        }

        // Fall back to default-pipeline
        const defaultPipeline = this.pluginRegistry.get('default-pipeline');
        if (defaultPipeline && defaultPipeline.state === 'loaded') {
            return defaultPipeline;
        }

        this.logger.warn('No default pipeline plugin found');
        return undefined;
    }
}
