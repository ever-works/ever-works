import { Injectable, Logger } from '@nestjs/common';
import {
    PluginRegistryService,
    RegisteredPlugin,
} from '@src/plugins/services/plugin-registry.service';
import type {
    GeneratorFormSchema,
    ProviderOption,
    FormFieldDefinition,
    FormFieldGroup,
    ValidationResult,
} from '@ever-works/plugin';
import { isFormSchemaProvider } from '@ever-works/plugin';

/**
 * Service for resolving dynamic generator form schema based on selected plugins.
 *
 * This service queries the plugin registry to:
 * 1. Get available providers for each capability category
 * 2. Resolve form fields from the selected pipeline plugin
 * 3. Return a complete GeneratorFormSchema for the frontend
 */
@Injectable()
export class GeneratorFormSchemaService {
    private readonly logger = new Logger(GeneratorFormSchemaService.name);

    constructor(private readonly pluginRegistry: PluginRegistryService) {}

    /**
     * Get the generator form schema based on the selected pipeline.
     *
     * @param pipelineId - Selected pipeline plugin ID (null for default)
     * @returns Complete form schema for rendering the generator form
     */
    async getFormSchema(pipelineId?: string): Promise<GeneratorFormSchema> {
        // Get available providers for each capability category
        const providers = this.getAvailableProviders();

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
     */
    private getAvailableProviders(): GeneratorFormSchema['providers'] {
        return {
            search: this.getProvidersForCapability('search'),
            screenshot: this.getProvidersForCapability('screenshot'),
            ai: this.getProvidersForCapability('ai-provider'),
            fullPipeline: this.getProvidersForCapability('full-pipeline'),
        };
    }

    /**
     * Get enabled provider options for a specific capability.
     */
    private getProvidersForCapability(capability: string): ProviderOption[] {
        const plugins = this.pluginRegistry.getByCapability(capability);

        return plugins.filter((p) => p.state === 'enabled').map((p) => this.toProviderOption(p));
    }

    /**
     * Convert a registered plugin to a provider option.
     */
    private toProviderOption(registered: RegisteredPlugin): ProviderOption {
        const { plugin, manifest } = registered;

        return {
            id: plugin.id,
            name: manifest.name,
            description: manifest.description,
            configured: true, // Plugin is enabled, so it's configured
            isDefault: manifest.systemPlugin || false,
            icon: manifest.icon,
        };
    }

    /**
     * Resolve the pipeline plugin to use for form fields.
     */
    private resolvePipelinePlugin(pipelineId?: string): RegisteredPlugin | undefined {
        if (pipelineId) {
            const registered = this.pluginRegistry.get(pipelineId);
            if (registered && registered.state === 'enabled') {
                return registered;
            }
            this.logger.warn(`Pipeline plugin not found or not enabled: ${pipelineId}`);
        }

        // Fall back to default-pipeline
        const defaultPipeline = this.pluginRegistry.get('default-pipeline');
        if (defaultPipeline && defaultPipeline.state === 'enabled') {
            return defaultPipeline;
        }

        this.logger.warn('No default pipeline plugin found');
        return undefined;
    }
}
