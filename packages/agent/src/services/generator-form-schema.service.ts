import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import {
    PluginRegistryService,
    RegisteredPlugin,
} from '@src/plugins/services/plugin-registry.service';
import { WorkPluginRepository } from '@src/plugins/repositories/work-plugin.repository';
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
import { buildProviderModelSummaries } from '@src/plugins/utils/plugin-model-settings.utils';

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
    /** Work ID for enable filtering and default provider resolution */
    workId?: string;
    /** User ID for enable filtering */
    userId?: string;
}

@Injectable()
export class GeneratorFormSchemaService {
    private readonly logger = new Logger(GeneratorFormSchemaService.name);

    constructor(
        private readonly pluginRegistry: PluginRegistryService,
        @Optional() private readonly workPluginRepository?: WorkPluginRepository,
        @Optional() private readonly pluginSettingsService?: PluginSettingsService,
    ) {}

    /**
     * Get the generator form schema based on the selected pipeline.
     *
     * When workId is provided, providers are filtered by enable status
     * and default providers are marked based on active capabilities.
     *
     * @param pipelineId - Selected pipeline plugin ID (null for default)
     * @param options - Optional workId and userId for filtering
     * @returns Complete form schema for rendering the generator form
     */
    async getFormSchema(
        pipelineId?: string,
        options?: FormSchemaOptions,
    ): Promise<GeneratorFormSchema> {
        // Global default is returned as metadata — enforcement happens on the frontend
        const userGlobalDefault =
            options?.userId && this.pluginSettingsService
                ? await this.pluginSettingsService.getUserGlobalPipelineDefault(options.userId)
                : null;

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

        // Materialise the pipeline plugin once — eager mode returns
        // the cached instance instantly. We need the runtime instance
        // for `isFormSchemaProvider` + the form schema methods.
        const pipelinePluginInstance = pipelinePlugin
            ? await this.pluginRegistry.ensureLoaded(pipelinePlugin.manifest.id)
            : undefined;
        if (pipelinePluginInstance && isFormSchemaProvider(pipelinePluginInstance)) {
            const provider = pipelinePluginInstance;

            pluginFields = provider.getFormFields();
            pluginGroups = provider.getFormGroups?.();
            handledConfigFields = provider.handledConfigFields ?? [];
            defaultValues = provider.getDefaultValues?.();

            this.logger.debug(
                `Resolved ${pluginFields.length} form fields from pipeline: ${pipelinePlugin?.manifest.id}`,
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

        // Enforced pipeline ID — set only when enforce is active and the plugin is loaded
        let enforcedPipelineId: string | undefined;
        if (userGlobalDefault?.enforce) {
            const enforced = this.pluginRegistry.get(userGlobalDefault.pluginId);
            // Lazy-aware: parked-but-unloaded plugins ARE valid here
            // — the form schema just needs the id, not the instance.
            if (
                enforced &&
                (enforced.state === 'loaded' ||
                    (this.pluginRegistry.isLazy?.(userGlobalDefault.pluginId) ?? false))
            ) {
                enforcedPipelineId = userGlobalDefault.pluginId;
            }
        }

        return {
            resolvedPipelineId: pipelinePlugin?.manifest.id,
            enforcedPipelineId,
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

        if (pipelinePlugin) {
            // Materialise — eager mode returns the cached instance
            // instantly; lazy mode fires the deferred import + onLoad.
            const pipelineInstance = await this.pluginRegistry.ensureLoaded(
                pipelinePlugin.manifest.id,
            );
            if (isFormSchemaProvider(pipelineInstance)) {
                const result = await pipelineInstance.validateFormInput(values);
                if (!result.valid) return result;
            }
        }

        // Validate form-schema-provider plugin form values
        const dsPlugins = await this.getEnabledFormSchemaPlugins(options);
        for (const registered of dsPlugins) {
            const pluginId = registered.manifest.id;
            const pluginInstance = await this.pluginRegistry.ensureLoaded(pluginId);
            if (!isFormSchemaProvider(pluginInstance)) continue;
            const pluginValues = (values[pluginId] as Record<string, unknown>) ?? {};
            const result = await pluginInstance.validateFormInput(pluginValues);
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
        if (pipelinePlugin) {
            const pipelineInstance = await this.pluginRegistry.ensureLoaded(
                pipelinePlugin.manifest.id,
            );
            if (isFormSchemaProvider(pipelineInstance)) {
                const transform = pipelineInstance.transformFormValues;
                if (transform) {
                    config = transform.call(pipelineInstance, config);
                }
            }
        }

        // Let each form-schema-provider plugin transform the full config, then extract its nested key
        const dsPlugins = await this.getEnabledFormSchemaPlugins(options);
        for (const registered of dsPlugins) {
            const pluginId = registered.manifest.id;
            const pluginInstance = await this.pluginRegistry.ensureLoaded(pluginId);
            if (!isFormSchemaProvider(pluginInstance)) continue;

            // Call transformFormValues on full config — this produces the nested key
            if (pluginInstance.transformFormValues) {
                const transformed = pluginInstance.transformFormValues(config);
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
                .map((p) => p.manifest.id),
        );
        const errors: string[] = [];

        for (const registered of plugins) {
            const pluginId = registered.manifest.id;
            // Lazy-aware: parked-but-unloaded plugins ARE eligible —
            // `isPluginConfigured` below materialises on demand.
            if (
                registered.state !== 'loaded' &&
                !(this.pluginRegistry.isLazy?.(pluginId) ?? false)
            ) {
                continue;
            }
            if (pipelineIds.has(pluginId)) continue;

            const isEnabled = await this.pluginRegistry.isPluginEnabledForScope(
                pluginId,
                options.workId,
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
     * Filters by enable status and marks default providers based on active capabilities.
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
     * When workId is provided:
     * - Filters plugins by enable status (Work > User > autoEnable)
     * - Marks the default provider based on active capabilities
     */
    private async getProvidersForCapability(
        capability: string,
        options?: FormSchemaOptions,
    ): Promise<ProviderOption[]> {
        const plugins = this.pluginRegistry.getByCapability(capability);
        // Lazy-aware filter — see resolveExtractorCandidates() in
        // content-extractor.facade.ts for the same pattern.
        const enabledPlugins = plugins.filter(
            (p) =>
                p.state === 'loaded' || (this.pluginRegistry.isLazy?.(p.manifest.id) ?? false),
        );
        const result: ProviderOption[] = [];

        // Get the active (default) plugin for this capability in the work
        let activePluginId: string | null = null;
        if (options?.workId && this.workPluginRepository) {
            try {
                const activePlugin = await this.workPluginRepository.findActiveByCapability(
                    options.workId,
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
            if (options?.workId || options?.userId) {
                const isEnabled = await this.pluginRegistry.isPluginEnabledForScope(
                    registered.manifest.id,
                    options.workId,
                    options.userId,
                );
                if (!isEnabled) {
                    continue;
                }
            }

            const configured = await this.isPluginConfigured(registered, options);
            result.push(
                await this.toProviderOption(
                    registered,
                    activePluginId,
                    configured,
                    capability,
                    options,
                ),
            );
        }

        return result;
    }

    /**
     * Convert a registered plugin to a provider option.
     */
    private async toProviderOption(
        registered: RegisteredPlugin,
        activePluginId?: string | null,
        configured: boolean = true,
        capability?: string,
        options?: FormSchemaOptions,
    ): Promise<ProviderOption> {
        const { manifest } = registered;
        const pluginId = manifest.id;

        // Mark as default if:
        // 1. It's the active plugin for the work.
        // 2. OR it declares this capability in defaultForCapabilities
        // 3. OR it's a system plugin (fallback if no capability provided)
        const isDefault = activePluginId
            ? pluginId === activePluginId
            : capability
              ? manifest.defaultForCapabilities?.includes(capability) || false
              : manifest.systemPlugin || false;

        // AI provider model summaries need the instance's
        // settingsSchema (instance-only property). Materialise on
        // demand — eager mode returns the cached instance instantly.
        const models =
            capability === PLUGIN_CAPABILITIES.AI_PROVIDER && this.pluginSettingsService
                ? buildProviderModelSummaries(
                      (await this.pluginRegistry.ensureLoaded(pluginId)).settingsSchema,
                      await this.pluginSettingsService.getResolvedSettings(pluginId, {
                          userId: options?.userId,
                          workId: options?.workId,
                      }),
                  )
                : undefined;

        return {
            id: pluginId,
            name: manifest.name,
            description: manifest.description,
            configured,
            isDefault,
            icon: manifest.icon,
            models,
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

        const pluginId = registered.manifest.id;
        // `settingsSchema` is an instance-only property — materialise
        // to read it. Eager mode returns the cached instance instantly.
        const plugin = await this.pluginRegistry.ensureLoaded(pluginId);
        const schema = plugin.settingsSchema;
        if (
            !schema?.properties ||
            (!schema.required?.length && !schema['x-requiredGroups']?.length)
        ) {
            return true;
        }

        try {
            const resolved = await this.pluginSettingsService.getResolvedSettings(pluginId, {
                userId: options?.userId,
                workId: options?.workId,
                includeSecrets: true,
            });

            if (!this.checkRequiredFields(schema, resolved)) return false;
            if (!this.checkRequiredGroups(schema, resolved)) return false;

            return true;
        } catch (error) {
            this.logger.warn(
                `Failed to check configured status for plugin ${pluginId}: ${error}`,
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

    async validateRequiredProvidersForPipeline(
        pipelineId: string | undefined,
        providers: ProvidersDto | undefined,
        options: FormSchemaOptions,
    ): Promise<void> {
        const providerErrors: Record<string, string> = {};
        const pipelinePlugin = await this.resolvePipelinePlugin(pipelineId, options);
        const resolvedPipelineId = pipelinePlugin?.manifest.id ?? pipelineId;

        if (resolvedPipelineId) {
            const error = await this.validateSingleProvider(resolvedPipelineId, options);
            if (error) {
                providerErrors.pipeline = error;
            }
        }

        const requiredCategories = this.getRequiredProviderUiKeysForPipeline(resolvedPipelineId);

        for (const { uiKey, capability } of getIndividualProviderCategories()) {
            if (!requiredCategories.includes(uiKey as keyof ProvidersDto)) {
                continue;
            }

            const pluginId = providers?.[uiKey as keyof ProvidersDto];
            if (pluginId) {
                const error = await this.validateSingleProvider(pluginId, options);
                if (error) {
                    providerErrors[uiKey] = error;
                }
                continue;
            }

            const defaultProvider = await this.resolveDefaultProvider(capability, options);
            if (!defaultProvider) {
                providerErrors[uiKey] =
                    `No default provider is available for required category "${uiKey}". ` +
                    'Visit Settings → Plugins to enable and configure one.';
                continue;
            }

            if (!defaultProvider.configured) {
                providerErrors[uiKey] =
                    `Default provider "${defaultProvider.name}" is not configured. ` +
                    'Visit Settings → Plugins to set it up.';
            }
        }

        if (Object.keys(providerErrors).length > 0) {
            throw new BadRequestException({
                message:
                    'One or more required providers for the selected pipeline are not available.',
                providerErrors,
                resolvedPipelineId,
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

    private getRequiredProviderUiKeysForPipeline(pipelineId?: string): Array<keyof ProvidersDto> {
        switch (pipelineId) {
            case 'agent-pipeline':
            case 'standard-pipeline':
                return ['ai', 'search', 'contentExtractor'];
            default:
                return [];
        }
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
        // Lazy-aware: parked-but-unloaded plugins ARE valid here —
        // `isPluginConfigured` will materialise on demand.
        if (
            registered.state !== 'loaded' &&
            !(this.pluginRegistry.isLazy?.(pluginId) ?? false)
        ) {
            return `Provider "${pluginId}" is not loaded (state: ${registered.state}).`;
        }

        if (options.workId || options.userId) {
            const isEnabled = await this.pluginRegistry.isPluginEnabledForScope(
                pluginId,
                options.workId,
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
            const pluginId = registered.manifest.id;
            const provider = await this.pluginRegistry.ensureLoaded(pluginId);
            if (!isFormSchemaProvider(provider)) continue;

            fields.push(...provider.getFormFields());

            const providerGroups = provider.getFormGroups?.();
            if (providerGroups) groups.push(...providerGroups);

            const providerDefaults = provider.getDefaultValues?.();
            if (providerDefaults) {
                defaultValues = { ...defaultValues, ...providerDefaults };
            }

            this.logger.debug(`Collected form fields from plugin: ${pluginId}`);
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
                .map((p) => p.manifest.id),
        );
        const result: RegisteredPlugin[] = [];

        for (const registered of plugins) {
            const pluginId = registered.manifest.id;
            // Lazy-aware: parked-but-unloaded plugins ARE eligible
            // — the caller materialises via ensureLoaded before
            // touching the instance.
            if (
                registered.state !== 'loaded' &&
                !(this.pluginRegistry.isLazy?.(pluginId) ?? false)
            ) {
                continue;
            }
            if (pipelineIds.has(pluginId)) continue;

            if (options?.workId || options?.userId) {
                const isEnabled = await this.pluginRegistry.isPluginEnabledForScope(
                    pluginId,
                    options.workId,
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
        // 1. Explicit pipelineId — from .works/works.yml or user click in the form
        if (pipelineId) {
            const registered = this.pluginRegistry.get(pipelineId);
            // Lazy-aware: parked-but-unloaded plugins are valid here.
            // The caller materialises via ensureLoaded when needed.
            if (
                registered &&
                (registered.state === 'loaded' ||
                    (this.pluginRegistry.isLazy?.(pipelineId) ?? false)) &&
                (await this.isEnabledForScope(registered.manifest.id, options))
            ) {
                return registered;
            }
            this.logger.warn(`Pipeline plugin not found or not enabled: ${pipelineId}`);
        }

        // 2. Work's active provider for 'pipeline'
        if (options?.workId && this.workPluginRepository) {
            try {
                const activePlugin = await this.workPluginRepository.findActiveByCapability(
                    options.workId,
                    'pipeline',
                );
                if (activePlugin) {
                    const registered = this.pluginRegistry.get(activePlugin.pluginId);
                    if (
                        registered &&
                        (registered.state === 'loaded' ||
                            (this.pluginRegistry.isLazy?.(activePlugin.pluginId) ?? false)) &&
                        (await this.isEnabledForScope(registered.manifest.id, options))
                    ) {
                        return registered;
                    }
                }
            } catch {
                // No active pipeline set for this work
            }
        }

        // 3. Default pipeline via defaultForCapabilities
        const pipelines = this.pluginRegistry.getByCapability(PLUGIN_CAPABILITIES.PIPELINE);

        for (const registered of pipelines) {
            const pluginId = registered.manifest.id;
            if (
                registered.state !== 'loaded' &&
                !(this.pluginRegistry.isLazy?.(pluginId) ?? false)
            ) {
                continue;
            }
            if (registered.manifest.defaultForCapabilities?.includes('pipeline')) {
                if (await this.isEnabledForScope(pluginId, options)) {
                    return registered;
                }
            }
        }

        // 4. Fallback: first loaded pipeline
        for (const registered of pipelines) {
            const pluginId = registered.manifest.id;
            if (
                (registered.state === 'loaded' ||
                    (this.pluginRegistry.isLazy?.(pluginId) ?? false)) &&
                (await this.isEnabledForScope(pluginId, options))
            ) {
                return registered;
            }
        }

        this.logger.warn('No pipeline plugin found');
        return undefined;
    }

    private async isEnabledForScope(
        pluginId: string,
        options?: FormSchemaOptions,
    ): Promise<boolean> {
        if (!options?.workId && !options?.userId) {
            return true;
        }
        return this.pluginRegistry.isPluginEnabledForScope(
            pluginId,
            options.workId,
            options.userId,
        );
    }
}
