import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import {
    PluginRegistryService,
    RegisteredPlugin,
} from '@src/plugins/services/plugin-registry.service';
import { DirectoryPluginRepository } from '@src/plugins/repositories/directory-plugin.repository';
import { PluginSettingsService } from '@src/plugins/services/plugin-settings.service';
import type {
    GeneratorFormSchema,
    ProviderOption,
    FormFieldDefinition,
    FormFieldGroup,
    ValidationResult,
    JsonSchema,
} from '@ever-works/plugin';
import {
    isFormSchemaProvider,
    PLUGIN_CAPABILITIES,
    getIndividualProviderCategories,
    getSelectableCategories,
} from '@ever-works/plugin';
import type { ProvidersDto } from '@src/items-generator/dto/create-items-generator.dto';

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
        @Optional() private readonly pluginSettingsService?: PluginSettingsService,
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
        // Resolve the selected pipeline plugin
        const pipelinePlugin = await this.resolvePipelinePlugin(pipelineId, options);

        // Get available providers for each capability category (filtered by enable status)
        const providers = await this.getAvailableProviders(options);

        // Filter provider categories by pipeline's selectableProviderCategories
        const selectable = pipelinePlugin?.manifest.selectableProviderCategories;
        if (selectable) {
            for (const cat of getSelectableCategories()) {
                if (cat.uiKey === 'pipeline') continue;
                if (!selectable.includes(cat.capability)) {
                    providers[cat.uiKey as keyof typeof providers] = [];
                }
            }
        }

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
                `Resolved ${pluginFields.length} form fields from pipeline: ${pipelinePlugin.plugin.id}`,
            );
        }

        // Collect form fields from enabled form-schema-provider plugins (excluding pipelines)
        // Pipeline fields take precedence — skip duplicates by field name
        const dsFields = await this.getAdditionalFormFields(options);
        const existingFieldNames = new Set(pluginFields.map((f) => f.name));
        const newFields = dsFields.fields.filter((f) => !existingFieldNames.has(f.name));
        pluginFields = [...pluginFields, ...newFields];
        if (dsFields.groups.length > 0) {
            const existingGroupNames = new Set(pluginGroups?.map((g) => g.name) ?? []);
            const newGroups = dsFields.groups.filter((g) => !existingGroupNames.has(g.name));
            pluginGroups = [...(pluginGroups ?? []), ...newGroups];
        }
        if (dsFields.defaultValues && Object.keys(dsFields.defaultValues).length > 0) {
            defaultValues = { ...defaultValues, ...dsFields.defaultValues };
        }

        // Determine if the pipeline is enforced by the user's global default
        let isPipelineEnforced = false;
        if (options?.userId && this.pluginSettingsService) {
            const globalDefault =
                await this.pluginSettingsService.getUserGlobalPipelineDefault(options.userId);
            if (globalDefault?.enforce) {
                isPipelineEnforced = true;
            }
        }

        return {
            resolvedPipelineId: pipelinePlugin?.plugin.id,
            isPipelineEnforced,
            providers,
            pluginFields,
            pluginGroups,
            handledConfigFields,
            defaultValues,
        };
    }

    /**
     * Validate form values against the pipeline and enabled data source plugins.
     */
    async validateFormValues(
        pipelineId: string | undefined,
        values: Record<string, unknown>,
        options?: FormSchemaOptions,
    ): Promise<ValidationResult> {
        const pipelinePlugin = await this.resolvePipelinePlugin(pipelineId, options);

        if (pipelinePlugin && isFormSchemaProvider(pipelinePlugin.plugin)) {
            const result = await pipelinePlugin.plugin.validateFormInput(values);
            if (!result.valid) return result;
        }

        // Validate form-schema-provider plugin form values
        const dsPlugins = await this.getEnabledFormSchemaPlugins(options);
        for (const registered of dsPlugins) {
            if (!isFormSchemaProvider(registered.plugin)) continue;
            const pluginValues = (values[registered.plugin.id] as Record<string, unknown>) ?? {};
            const result = await registered.plugin.validateFormInput(pluginValues);
            if (!result.valid) return result;
        }

        return { valid: true };
    }

    /**
     * Process raw form config: call transformFormValues() on pipeline + data source plugins,
     * and separate flat pipeline config from nested per-plugin config.
     */
    async processFormConfig(
        pipelineId: string | undefined,
        rawConfig: Record<string, unknown> | undefined,
        options: FormSchemaOptions,
    ): Promise<{
        config: Record<string, unknown>;
        pluginConfig: Record<string, Record<string, unknown>>;
    }> {
        let config = { ...(rawConfig ?? {}) };
        const pluginConfig: Record<string, Record<string, unknown>> = {};

        // Let the pipeline plugin transform first
        const pipelinePlugin = await this.resolvePipelinePlugin(pipelineId, options);
        if (pipelinePlugin && isFormSchemaProvider(pipelinePlugin.plugin)) {
            const transform = pipelinePlugin.plugin.transformFormValues;
            if (transform) {
                config = transform.call(pipelinePlugin.plugin, config);
            }
        }

        // Let each form-schema-provider plugin transform the full config, then extract its nested key
        const dsPlugins = await this.getEnabledFormSchemaPlugins(options);
        for (const registered of dsPlugins) {
            if (!isFormSchemaProvider(registered.plugin)) continue;

            const pluginId = registered.plugin.id;

            // Call transformFormValues on full config — this produces the nested key
            if (registered.plugin.transformFormValues) {
                const transformed = registered.plugin.transformFormValues(config);
                const nested = transformed[pluginId];

                if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
                    pluginConfig[pluginId] = nested as Record<string, unknown>;
                }
            } else {
                // No transform — check if config already has a nested key for this plugin
                const nested = config[pluginId];
                if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
                    pluginConfig[pluginId] = nested as Record<string, unknown>;
                }
            }

            // Remove the extracted nested key from flat config
            delete config[pluginId];
        }

        return { config, pluginConfig };
    }

    /**
     * Validate that all enabled form-schema-provider plugins are properly configured.
     * Throws BadRequestException if any are missing required settings.
     */
    async validateFormSchemaPlugins(options: FormSchemaOptions): Promise<void> {
        const plugins = this.pluginRegistry.getByCapability(
            PLUGIN_CAPABILITIES.FORM_SCHEMA_PROVIDER,
        );
        const pipelineIds = new Set(
            this.pluginRegistry
                .getByCapability(PLUGIN_CAPABILITIES.PIPELINE)
                .map((p) => p.plugin.id),
        );
        const errors: string[] = [];

        for (const registered of plugins) {
            if (registered.state !== 'loaded') continue;
            if (pipelineIds.has(registered.plugin.id)) continue;

            const isEnabled = await this.pluginRegistry.isPluginEnabledForScope(
                registered.plugin.id,
                options.directoryId,
                options.userId,
            );
            if (!isEnabled) continue;

            const configured = await this.isPluginConfigured(registered, options);
            if (!configured) {
                errors.push(
                    `Plugin "${registered.manifest.name}" is not configured. Visit Settings → Plugins to set it up.`,
                );
            }
        }

        if (errors.length > 0) {
            throw new BadRequestException({
                message: 'One or more form-schema-provider plugins are not configured.',
                formSchemaErrors: errors,
            });
        }
    }

    /**
     * Get available providers for all capability categories.
     * Filters by enable status and marks default providers based on activeCapability.
     */
    private async getAvailableProviders(
        options?: FormSchemaOptions,
    ): Promise<GeneratorFormSchema['providers']> {
        const categories = getSelectableCategories();
        const results = await Promise.all(
            categories.map((cat) => this.getProvidersForCapability(cat.capability, options)),
        );

        const providers: Record<string, ProviderOption[]> = {};
        categories.forEach((cat, i) => {
            providers[cat.uiKey] = results[i];
        });
        return providers as GeneratorFormSchema['providers'];
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
            // Supplementary plugins (e.g., notion-extractor, pdf-extractor) auto-activate via
            // canExtract() URL matching in the facade — they are not user-selectable providers.
            if (registered.manifest.supplementary) continue;

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

            const configured = await this.isPluginConfigured(registered, options);
            result.push(this.toProviderOption(registered, activePluginId, configured, capability));
        }

        return result;
    }

    /**
     * Convert a registered plugin to a provider option.
     */
    private toProviderOption(
        registered: RegisteredPlugin,
        activePluginId?: string | null,
        configured: boolean = true,
        capability?: string,
    ): ProviderOption {
        const { plugin, manifest } = registered;

        // Mark as default if:
        // 1. It's the active plugin for the directory (via activeCapability)
        // 2. OR it declares this capability in defaultForCapabilities
        // 3. OR it's a system plugin (fallback if no capability provided)
        const isDefault = activePluginId
            ? plugin.id === activePluginId
            : capability
              ? manifest.defaultForCapabilities?.includes(capability) || false
              : manifest.systemPlugin || false;

        return {
            id: plugin.id,
            name: manifest.name,
            description: manifest.description,
            configured,
            isDefault,
            icon: manifest.icon,
        };
    }

    /**
     * Check if a plugin has all required settings configured.
     * Returns true if no settings service is available (graceful fallback).
     */
    private async isPluginConfigured(
        registered: RegisteredPlugin,
        options?: FormSchemaOptions,
    ): Promise<boolean> {
        if (!this.pluginSettingsService) {
            return true;
        }

        const schema = registered.plugin.settingsSchema;
        if (
            !schema?.properties ||
            (!schema.required?.length && !schema['x-requiredGroups']?.length)
        ) {
            return true;
        }

        try {
            const resolved = await this.pluginSettingsService.getResolvedSettings(
                registered.plugin.id,
                {
                    userId: options?.userId,
                    directoryId: options?.directoryId,
                    includeSecrets: true,
                },
            );

            if (!this.checkRequiredFields(schema, resolved)) return false;
            if (!this.checkRequiredGroups(schema, resolved)) return false;

            return true;
        } catch (error) {
            this.logger.warn(
                `Failed to check configured status for plugin ${registered.plugin.id}: ${error}`,
            );
            return true;
        }
    }

    private checkRequiredFields(
        schema: JsonSchema,
        resolved: Record<string, { value?: unknown }>,
    ): boolean {
        for (const key of schema.required ?? []) {
            const propSchema = schema.properties?.[key] as JsonSchema | undefined;
            if (propSchema?.['x-envVar'] && !propSchema?.['x-secret']) continue;

            const setting = resolved[key];
            if (
                !setting ||
                setting.value === undefined ||
                setting.value === null ||
                setting.value === ''
            ) {
                return false;
            }
        }
        return true;
    }

    private checkRequiredGroups(
        schema: JsonSchema,
        resolved: Record<string, { value?: unknown }>,
    ): boolean {
        for (const group of schema['x-requiredGroups'] ?? []) {
            const hasAny = group.fields.some((fieldName) => {
                const propSchema = schema.properties?.[fieldName] as JsonSchema | undefined;
                if (propSchema?.['x-envVar'] && !propSchema?.['x-secret']) return true;

                const setting = resolved[fieldName];
                return (
                    setting &&
                    setting.value !== undefined &&
                    setting.value !== null &&
                    setting.value !== ''
                );
            });
            if (!hasAny) return false;
        }
        return true;
    }

    async validateSelectedProviders(
        providers: ProvidersDto | undefined,
        options: FormSchemaOptions,
    ): Promise<void> {
        if (providers?.pipeline) {
            const error = await this.validateSingleProvider(providers.pipeline, options);
            if (error) {
                throw new BadRequestException({
                    message: 'One or more selected providers are not available.',
                    providerErrors: { pipeline: error },
                });
            }
            return;
        }

        const providerErrors: Record<string, string> = {};

        for (const { uiKey, capability } of getIndividualProviderCategories()) {
            const pluginId = providers?.[uiKey as keyof ProvidersDto];
            if (pluginId) {
                const error = await this.validateSingleProvider(pluginId, options);
                if (error) {
                    providerErrors[uiKey] = error;
                }
            } else {
                const defaultProvider = await this.resolveDefaultProvider(capability, options);
                if (defaultProvider && !defaultProvider.configured) {
                    providerErrors[uiKey] =
                        `Default provider "${defaultProvider.name}" is not configured. ` +
                        `Visit Settings → Plugins to set it up.`;
                }
            }
        }

        if (Object.keys(providerErrors).length > 0) {
            throw new BadRequestException({
                message: 'One or more selected providers are not available.',
                providerErrors,
            });
        }
    }

    private async resolveDefaultProvider(
        capability: string,
        options: FormSchemaOptions,
    ): Promise<ProviderOption | null> {
        const providerOptions = await this.getProvidersForCapability(capability, options);
        return providerOptions.find((p) => p.isDefault) ?? null;
    }

    /**
     * Validate a single provider: exists → loaded → enabled → configured.
     * Returns an error message string, or null if valid.
     */
    private async validateSingleProvider(
        pluginId: string,
        options: FormSchemaOptions,
    ): Promise<string | null> {
        const registered = this.pluginRegistry.get(pluginId);
        if (!registered) {
            return `Provider "${pluginId}" is not registered.`;
        }
        if (registered.state !== 'loaded') {
            return `Provider "${pluginId}" is not loaded (state: ${registered.state}).`;
        }

        if (options.directoryId || options.userId) {
            const isEnabled = await this.pluginRegistry.isPluginEnabledForScope(
                pluginId,
                options.directoryId,
                options.userId,
            );
            if (!isEnabled) {
                return `Provider "${pluginId}" is not enabled for this scope.`;
            }
        }

        const configured = await this.isPluginConfigured(registered, options);
        if (!configured) {
            return `Provider "${pluginId}" is not configured. Visit Settings → Plugins to set it up.`;
        }

        return null;
    }

    private async getAdditionalFormFields(options?: FormSchemaOptions): Promise<{
        fields: FormFieldDefinition[];
        groups: FormFieldGroup[];
        defaultValues: Record<string, unknown>;
    }> {
        const fields: FormFieldDefinition[] = [];
        const groups: FormFieldGroup[] = [];
        let defaultValues: Record<string, unknown> = {};

        const plugins = await this.getEnabledFormSchemaPlugins(options);

        for (const registered of plugins) {
            if (!isFormSchemaProvider(registered.plugin)) continue;
            const provider = registered.plugin;

            fields.push(...provider.getFormFields());

            const providerGroups = provider.getFormGroups?.();
            if (providerGroups) groups.push(...providerGroups);

            const providerDefaults = provider.getDefaultValues?.();
            if (providerDefaults) {
                defaultValues = { ...defaultValues, ...providerDefaults };
            }

            this.logger.debug(`Collected form fields from plugin: ${provider.id}`);
        }

        return { fields, groups, defaultValues };
    }

    private async getEnabledFormSchemaPlugins(
        options?: FormSchemaOptions,
    ): Promise<RegisteredPlugin[]> {
        const plugins = this.pluginRegistry.getByCapability(
            PLUGIN_CAPABILITIES.FORM_SCHEMA_PROVIDER,
        );
        // Exclude ALL pipeline plugins — their fields are handled via resolvePipelinePlugin()
        const pipelineIds = new Set(
            this.pluginRegistry
                .getByCapability(PLUGIN_CAPABILITIES.PIPELINE)
                .map((p) => p.plugin.id),
        );
        const result: RegisteredPlugin[] = [];

        for (const registered of plugins) {
            if (registered.state !== 'loaded') continue;
            if (pipelineIds.has(registered.plugin.id)) continue;

            if (options?.directoryId || options?.userId) {
                const isEnabled = await this.pluginRegistry.isPluginEnabledForScope(
                    registered.plugin.id,
                    options.directoryId,
                    options.userId,
                );
                if (!isEnabled) continue;
            }

            result.push(registered);
        }

        return result;
    }

    private async resolvePipelinePlugin(
        pipelineId?: string,
        options?: FormSchemaOptions,
    ): Promise<RegisteredPlugin | undefined> {
        // Resolve user's global pipeline default (if any)
        let userGlobalDefault: { pluginId: string; enforce: boolean } | null = null;
        if (options?.userId && this.pluginSettingsService) {
            userGlobalDefault =
                await this.pluginSettingsService.getUserGlobalPipelineDefault(options.userId);
        }

        // 0. Enforced user global default — overrides everything including explicit form selection
        if (userGlobalDefault?.enforce) {
            const registered = this.pluginRegistry.get(userGlobalDefault.pluginId);
            if (registered && registered.state === 'loaded') {
                return registered;
            }
        }

        // 1. Explicit pipelineId — use it directly
        if (pipelineId) {
            const registered = this.pluginRegistry.get(pipelineId);
            if (registered && registered.state === 'loaded') {
                return registered;
            }
            this.logger.warn(`Pipeline plugin not found or not enabled: ${pipelineId}`);
        }

        // 1.5. Non-enforced user global default — preferred over directory/manifest defaults
        if (userGlobalDefault && !userGlobalDefault.enforce) {
            const registered = this.pluginRegistry.get(userGlobalDefault.pluginId);
            if (registered && registered.state === 'loaded') {
                return registered;
            }
        }

        // 2. Directory's activeCapability for 'pipeline'
        if (options?.directoryId && this.directoryPluginRepository) {
            try {
                const activePlugin = await this.directoryPluginRepository.findActiveByCapability(
                    options.directoryId,
                    'pipeline',
                );
                if (activePlugin) {
                    const registered = this.pluginRegistry.get(activePlugin.pluginId);
                    if (registered && registered.state === 'loaded') {
                        return registered;
                    }
                }
            } catch {
                // No active pipeline set for this directory
            }
        }

        // 3. Default pipeline via defaultForCapabilities
        const pipelines = this.pluginRegistry.getByCapability(PLUGIN_CAPABILITIES.PIPELINE);

        for (const registered of pipelines) {
            if (registered.state !== 'loaded') continue;
            if (registered.manifest.defaultForCapabilities?.includes('pipeline')) {
                return registered;
            }
        }

        // 4. Fallback: first loaded pipeline
        for (const registered of pipelines) {
            if (registered.state === 'loaded') {
                return registered;
            }
        }

        this.logger.warn('No pipeline plugin found');
        return undefined;
    }
}
