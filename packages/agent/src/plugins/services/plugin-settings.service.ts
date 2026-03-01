import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
    PluginSettings,
    ResolvedSettings,
    ResolvedSetting,
    SettingScope,
    SettingSource,
    SettingDefinition,
    JsonSchema,
} from '@ever-works/plugin';
import pickBy from 'lodash/pickBy';
import { PluginRepository } from '../repositories/plugin.repository';
import { UserPluginRepository } from '../repositories/user-plugin.repository';
import { DirectoryPluginRepository } from '../repositories/directory-plugin.repository';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginEvents, SETTING_SOURCE_PRIORITY } from '../plugins.constants';

/** Placeholder for masked secrets in API responses */
const MASKED_SECRET_PLACEHOLDER = '********';

/**
 * Options for resolving settings
 */
export interface SettingsResolutionOptions {
    /**
     * Scope for resolution
     */
    scope?: SettingScope;

    /**
     * Directory ID for directory-scoped settings
     */
    directoryId?: string;

    /**
     * User ID for user-scoped settings
     */
    userId?: string;

    /**
     * Whether to include secret values
     */
    includeSecrets?: boolean;
}

/**
 * Service for managing and resolving plugin settings.
 * Implements 4-level settings resolution hierarchy.
 */
@Injectable()
export class PluginSettingsService {
    private readonly logger = new Logger(PluginSettingsService.name);

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly pluginRepository: PluginRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly directoryPluginRepository: DirectoryPluginRepository,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    /**
     * Get resolved settings for a plugin
     * Resolution priority (highest to lowest):
     * 1. Directory settings
     * 2. User settings
     * 3. Admin settings
     * 4. Environment variables
     * 5. Plugin defaults
     */
    async getResolvedSettings(
        pluginId: string,
        options?: SettingsResolutionOptions,
    ): Promise<ResolvedSettings> {
        const registered = this.registry.get(pluginId);
        if (!registered) {
            throw new Error(`Plugin "${pluginId}" not found`);
        }

        const plugin = registered.plugin;
        const settingsSchema = plugin.settingsSchema;
        const configMode = this.getConfigurationMode(plugin);

        // Enforce configurationMode: admin-only plugins ignore user/directory settings
        const effectiveOptions = this.applyConfigurationMode(options, configMode);

        // Get settings from each level
        const adminEntity = await this.pluginRepository.findByPluginId(pluginId);
        const adminSettings = adminEntity?.settings || {};
        const adminSecrets = effectiveOptions?.includeSecrets
            ? adminEntity?.secretSettings || {}
            : {};

        let userSettings: Record<string, unknown> = {};
        let userSecrets: Record<string, unknown> = {};
        if (effectiveOptions?.userId && configMode !== 'admin-only') {
            const userEntity = await this.userPluginRepository.findByUserAndPlugin(
                effectiveOptions.userId,
                pluginId,
            );
            userSettings = userEntity?.settings || {};
            userSecrets = effectiveOptions?.includeSecrets ? userEntity?.secretSettings || {} : {};
        }

        let directorySettings: Record<string, unknown> = {};
        let directorySecrets: Record<string, unknown> = {};
        if (effectiveOptions?.directoryId && configMode !== 'admin-only') {
            const dirEntity = await this.directoryPluginRepository.findByDirectoryAndPlugin(
                effectiveOptions.directoryId,
                pluginId,
            );
            directorySettings = dirEntity?.settings || {};
            directorySecrets = effectiveOptions?.includeSecrets
                ? dirEntity?.secretSettings || {}
                : {};
        }

        // Resolve each setting
        const resolved: ResolvedSettings = {};
        const definitions = this.extractSettingDefinitions(settingsSchema);

        for (const def of definitions) {
            resolved[def.key] = this.resolveSetting(
                def,
                {
                    directory: { ...directorySettings, ...directorySecrets },
                    user: { ...userSettings, ...userSecrets },
                    admin: { ...adminSettings, ...adminSecrets },
                },
                effectiveOptions,
            );
        }

        return resolved;
    }

    /**
     * Get configuration mode from plugin
     */
    private getConfigurationMode(plugin: { configurationMode?: string }): string {
        return plugin.configurationMode || 'hybrid';
    }

    /**
     * Apply configurationMode restrictions to settings options
     */
    private applyConfigurationMode(
        options: SettingsResolutionOptions | undefined,
        configMode: string,
    ): SettingsResolutionOptions | undefined {
        if (configMode === 'admin-only') {
            // Admin-only: ignore user/directory settings
            return {
                ...options,
                userId: undefined,
                directoryId: undefined,
                includeSecrets: false, // Never include secrets for non-admin reads
            };
        }
        return options;
    }

    /**
     * Get plain settings object (values only, no source info)
     */
    async getSettings(
        pluginId: string,
        options?: SettingsResolutionOptions,
    ): Promise<PluginSettings> {
        const resolved = await this.getResolvedSettings(pluginId, options);
        const settings: PluginSettings = {};

        for (const [key, value] of Object.entries(resolved)) {
            settings[key] = value.value;
        }

        return settings;
    }

    /**
     * Update admin-level settings
     */
    async updateAdminSettings(
        pluginId: string,
        settings: Record<string, unknown>,
        options?: { secretKeys?: string[] },
    ): Promise<void> {
        const { regularSettings, secretSettings, filteredSettings } =
            await this.validateAndSeparateSettings(pluginId, settings, 'global', options);

        const entity = await this.pluginRepository.findByPluginId(pluginId);
        if (entity) {
            await this.pluginRepository.updateSettings(
                pluginId,
                { ...entity.settings, ...regularSettings },
                { ...entity.secretSettings, ...secretSettings },
            );
        }

        this.eventEmitter.emit(PluginEvents.SETTINGS_CHANGED, {
            pluginId,
            changedKeys: Object.keys(filteredSettings),
            scope: 'global',
            timestamp: Date.now(),
        });

        this.logger.debug(`Updated admin settings for plugin ${pluginId}`);
    }

    /**
     * Update user-level settings
     */
    async updateUserSettings(
        pluginId: string,
        userId: string,
        settings: Record<string, unknown>,
        options?: { secretKeys?: string[] },
    ): Promise<void> {
        const { regularSettings, secretSettings, filteredSettings } =
            await this.validateAndSeparateSettings(pluginId, settings, 'user', options);

        const pluginEntity = await this.pluginRepository.findByPluginId(pluginId);
        if (!pluginEntity) {
            throw new Error(`Plugin entity not found for ${pluginId}`);
        }

        const existing = await this.userPluginRepository.findByUserAndPlugin(userId, pluginId);
        if (existing) {
            await this.userPluginRepository.updateSettings(
                userId,
                pluginId,
                { ...existing.settings, ...regularSettings },
                { ...existing.secretSettings, ...secretSettings },
            );
        } else {
            await this.userPluginRepository.create({
                userId,
                pluginId,
                pluginEntityId: pluginEntity.id,
                settings: regularSettings,
                secretSettings,
            });
        }

        this.eventEmitter.emit(PluginEvents.SETTINGS_CHANGED, {
            pluginId,
            changedKeys: Object.keys(filteredSettings),
            scope: 'user',
            userId,
            timestamp: Date.now(),
        });

        this.logger.debug(`Updated user settings for plugin ${pluginId}, user ${userId}`);
    }

    /**
     * Update directory-level settings
     */
    async updateDirectorySettings(
        pluginId: string,
        directoryId: string,
        settings: Record<string, unknown>,
        options?: { secretKeys?: string[] },
    ): Promise<void> {
        const { regularSettings, secretSettings, filteredSettings } =
            await this.validateAndSeparateSettings(pluginId, settings, 'directory', options);

        const pluginEntity = await this.pluginRepository.findByPluginId(pluginId);
        if (!pluginEntity) {
            throw new Error(`Plugin entity not found for ${pluginId}`);
        }

        const existing = await this.directoryPluginRepository.findByDirectoryAndPlugin(
            directoryId,
            pluginId,
        );
        if (existing) {
            await this.directoryPluginRepository.updateSettings(
                directoryId,
                pluginId,
                { ...existing.settings, ...regularSettings },
                { ...existing.secretSettings, ...secretSettings },
            );
        } else {
            await this.directoryPluginRepository.create({
                directoryId,
                pluginId,
                pluginEntityId: pluginEntity.id,
                settings: regularSettings,
                secretSettings,
            });
        }

        this.eventEmitter.emit(PluginEvents.SETTINGS_CHANGED, {
            pluginId,
            changedKeys: Object.keys(filteredSettings),
            scope: 'directory',
            directoryId,
            timestamp: Date.now(),
        });

        this.logger.debug(
            `Updated directory settings for plugin ${pluginId}, directory ${directoryId}`,
        );
    }

    /**
     * Shared validation and settings separation for all update methods.
     * Handles: plugin lookup, configMode enforcement, schema filtering,
     * scope validation, settings validation, and regular/secret separation.
     */
    private async validateAndSeparateSettings(
        pluginId: string,
        settings: Record<string, unknown>,
        scope: SettingScope,
        options?: { secretKeys?: string[] },
    ): Promise<{
        regularSettings: Record<string, unknown>;
        secretSettings: Record<string, unknown>;
        filteredSettings: Record<string, unknown>;
    }> {
        const registered = this.registry.get(pluginId);
        if (!registered) {
            throw new Error(`Plugin "${pluginId}" not found`);
        }

        if (scope !== 'global') {
            const configMode = this.getConfigurationMode(registered.plugin);
            if (configMode === 'admin-only') {
                const scopeLabel = scope === 'user' ? 'by users' : 'at directory level';
                throw new Error(
                    `Plugin "${pluginId}" is admin-only and cannot be configured ${scopeLabel}`,
                );
            }
        }

        const schema = registered.plugin.settingsSchema;
        const definitions = this.extractSettingDefinitions(schema);

        let filteredSettings = this.filterEnvVarFields(settings, schema);
        filteredSettings = this.stripMaskedPlaceholders(filteredSettings, schema);

        const scopeValidation = this.validateSettingsScope(
            definitions,
            Object.keys(filteredSettings),
            scope,
        );
        if (!scopeValidation.valid) {
            throw new Error(`Scope violation: ${scopeValidation.violations.join(', ')}`);
        }

        const regularSettings: Record<string, unknown> = {};
        const secretSettings: Record<string, unknown> = {};
        const secretKeys = new Set(options?.secretKeys || []);

        for (const def of definitions) {
            if (def.secret) {
                secretKeys.add(def.key);
            }
        }

        for (const [key, value] of Object.entries(filteredSettings)) {
            if (secretKeys.has(key)) {
                secretSettings[key] = value;
            } else {
                regularSettings[key] = value;
            }
        }

        return { regularSettings, secretSettings, filteredSettings };
    }

    /**
     * Delete user settings for a plugin
     */
    async deleteUserSettings(pluginId: string, userId: string): Promise<boolean> {
        return this.userPluginRepository.deleteByUserAndPlugin(userId, pluginId);
    }

    /**
     * Delete directory settings for a plugin
     */
    async deleteDirectorySettings(pluginId: string, directoryId: string): Promise<boolean> {
        return this.directoryPluginRepository.deleteByDirectoryAndPlugin(directoryId, pluginId);
    }

    /**
     * Get the settings schema for a plugin
     */
    getSettingsSchema(pluginId: string): JsonSchema | undefined {
        const registered = this.registry.get(pluginId);
        return registered?.plugin.settingsSchema;
    }

    /**
     * Validate settings against a plugin's schema.
     * Optionally validates scope constraints when a scope is provided.
     */
    async validateSettings(
        pluginId: string,
        settings: Record<string, unknown>,
        options?: { scope?: SettingScope },
    ): Promise<{ valid: boolean; errors?: string[] }> {
        const registered = this.registry.get(pluginId);
        if (!registered) {
            return { valid: false, errors: [`Plugin "${pluginId}" not found`] };
        }

        const errors: string[] = [];

        // Validate scope constraints if scope is provided
        if (options?.scope) {
            const definitions = this.extractSettingDefinitions(registered.plugin.settingsSchema);
            const scopeValidation = this.validateSettingsScope(
                definitions,
                Object.keys(settings),
                options.scope,
            );
            if (!scopeValidation.valid) {
                errors.push(...scopeValidation.violations);
            }
        }

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        };
    }

    /**
     * Resolve a single setting based on hierarchy
     */
    private resolveSetting(
        definition: SettingDefinition,
        sources: {
            directory: Record<string, unknown>;
            user: Record<string, unknown>;
            admin: Record<string, unknown>;
        },
        options?: SettingsResolutionOptions,
    ): ResolvedSetting {
        const { key, envVar, defaultValue, scope: settingScope } = definition;

        // Check if setting scope matches request scope
        const requestScope = options?.scope || 'global';

        // Resolution order based on priority (directory > user > admin > env > default)
        // isFallback indicates when a value comes from a scope that doesn't match the setting's intended scope

        // 1. Directory settings (if directoryId provided)
        if (options?.directoryId && sources.directory[key] !== undefined) {
            return {
                key,
                value: sources.directory[key],
                source: 'directory',
                // Only non-fallback if setting is actually directory-scoped
                isFallback: settingScope !== 'directory',
            };
        }

        // 2. User settings (if userId provided)
        if (options?.userId && sources.user[key] !== undefined) {
            return {
                key,
                value: sources.user[key],
                source: 'user',
                // Only non-fallback if setting is user-scoped (directory-scoped should use directory)
                isFallback: settingScope !== 'user',
            };
        }

        // 3. Admin/Global settings
        if (sources.admin[key] !== undefined) {
            return {
                key,
                value: sources.admin[key],
                source: 'admin',
                // Only non-fallback if setting is global-scoped
                isFallback: settingScope !== 'global',
            };
        }

        // 4. Environment variable
        if (envVar && process.env[envVar] !== undefined) {
            return {
                key,
                value: this.parseEnvValue(process.env[envVar]!, definition),
                source: 'env',
                isFallback: true,
            };
        }

        // 5. Default value
        return {
            key,
            value: defaultValue,
            source: 'default',
            isFallback: true,
        };
    }

    /**
     * Validate that the scope has the required ID parameter.
     * Throws BadRequestException if scope requires an ID that is missing.
     *
     * @param scope - The scope being requested
     * @param directoryId - Directory ID (required when scope='directory')
     * @param userId - User ID (required when scope='user')
     * @throws BadRequestException if scope/ID mismatch
     */
    validateScopeRequirements(scope: SettingScope, directoryId?: string, userId?: string): void {
        if (scope === 'directory' && !directoryId) {
            throw new BadRequestException('directoryId required for directory scope');
        }
        if (scope === 'user' && !userId) {
            throw new BadRequestException('userId required for user scope');
        }
    }

    /**
     * Parse environment variable value based on schema type
     */
    private parseEnvValue(value: string, definition: SettingDefinition): unknown {
        const schemaType = definition.schema.type;

        switch (schemaType) {
            case 'boolean':
                return value === 'true' || value === '1';
            case 'number':
            case 'integer':
                return Number(value);
            case 'array':
                try {
                    return JSON.parse(value);
                } catch {
                    return value.split(',').map((s) => s.trim());
                }
            case 'object':
                try {
                    return JSON.parse(value);
                } catch {
                    return {};
                }
            default:
                return value;
        }
    }

    /**
     * Extract setting definitions from JSON Schema
     */
    private extractSettingDefinitions(schema: JsonSchema): SettingDefinition[] {
        const definitions: SettingDefinition[] = [];

        if (schema.type !== 'object' || !schema.properties) {
            return definitions;
        }

        for (const [key, propSchema] of Object.entries(schema.properties)) {
            const prop = propSchema as JsonSchema & {
                'x-envVar'?: string;
                'x-secret'?: boolean;
                'x-scope'?: SettingScope;
            };

            definitions.push({
                key,
                schema: prop,
                scope: prop['x-scope'] || 'global',
                envVar: prop['x-envVar'],
                secret: prop['x-secret'] || false,
                defaultValue: prop.default,
            });
        }

        return definitions;
    }

    /**
     * Validate that settings can be updated at the given scope.
     * Settings with a specific x-scope can only be updated at that scope or higher.
     * Hierarchy: global < user < directory
     *
     * @param definitions - Setting definitions from the schema
     * @param settingsKeys - Keys of settings being updated
     * @param updateScope - The scope at which settings are being updated
     * @returns Object with valid flag and any scope violations
     */
    private validateSettingsScope(
        definitions: SettingDefinition[],
        settingsKeys: string[],
        updateScope: SettingScope,
    ): { valid: boolean; violations: string[] } {
        const violations: string[] = [];
        const defMap = new Map(definitions.map((d) => [d.key, d]));

        for (const key of settingsKeys) {
            const def = defMap.get(key);
            if (!def) continue; // Unknown setting, let validation handle it

            const settingScope = def.scope;

            // Check if the update scope matches or is more specific than the setting scope
            // global settings can be set at any level
            // user settings can be set at user or directory level
            // directory settings can only be set at directory level
            if (settingScope === 'directory' && updateScope !== 'directory') {
                violations.push(
                    `Setting "${key}" has scope "directory" and cannot be updated at "${updateScope}" level`,
                );
            } else if (settingScope === 'user' && updateScope === 'global') {
                violations.push(
                    `Setting "${key}" has scope "user" and cannot be updated at "global" level`,
                );
            }
        }

        return {
            valid: violations.length === 0,
            violations,
        };
    }

    /**
     * Get the settings schema filtered by scope context.
     *
     * This method filters the plugin's settings schema to only include
     * properties that are appropriate for the given context:
     * - 'user' context: shows global + user scoped settings
     * - 'directory' context: shows global + directory scoped settings
     *
     * @param pluginId - Plugin ID
     * @param context - 'user' shows global+user, 'directory' shows global+directory
     * @returns Filtered schema or undefined if plugin not found
     */
    getSettingsSchemaForContext(
        pluginId: string,
        context: 'user' | 'directory',
    ): JsonSchema | undefined {
        const schema = this.getSettingsSchema(pluginId);
        if (!schema?.properties) return schema;

        const allowedScopes: SettingScope[] =
            context === 'user' ? ['global', 'user'] : ['global', 'directory'];

        const filteredProperties = pickBy(schema.properties, (prop) => {
            const propScope =
                (prop as JsonSchema & { 'x-scope'?: SettingScope })['x-scope'] || 'global';
            return allowedScopes.includes(propScope);
        }) as Record<string, JsonSchema>;

        return {
            ...schema,
            properties: filteredProperties,
            required: (schema.required || []).filter((r) => r in filteredProperties),
        };
    }

    /**
     * SECURITY: Filter out fields with x-envVar annotation.
     * These must NEVER be stored in database - only read from environment variables.
     *
     * @param settings - The settings to filter
     * @param schema - The plugin's settings schema
     * @returns Settings with x-envVar fields removed
     */
    private filterEnvVarFields(
        settings: Record<string, unknown>,
        schema: JsonSchema,
    ): Record<string, unknown> {
        if (!schema.properties) return settings;

        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(settings)) {
            const propSchema = schema.properties[key] as JsonSchema | undefined;
            if (propSchema?.['x-envVar']) {
                this.logger.warn(
                    `Rejecting x-envVar field "${key}" - must be set via environment variable`,
                );
                continue;
            }
            filtered[key] = value;
        }
        return filtered;
    }

    /**
     * Strip masked placeholder values from settings based on schema x-secret fields.
     */
    private stripMaskedPlaceholders(
        settings: Record<string, unknown>,
        schema: JsonSchema,
    ): Record<string, unknown> {
        if (!schema.properties) return settings;

        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(settings)) {
            const propSchema = schema.properties[key] as JsonSchema | undefined;
            if (propSchema?.['x-secret'] && value === MASKED_SECRET_PLACEHOLDER) {
                this.logger.debug(`Stripping masked placeholder for field "${key}"`);
                continue;
            }
            filtered[key] = value;
        }
        return filtered;
    }
}
