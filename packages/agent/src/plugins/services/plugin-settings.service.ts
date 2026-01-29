import { Injectable, Logger } from '@nestjs/common';
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
import { PluginRepository } from '../repositories/plugin.repository';
import { UserPluginRepository } from '../repositories/user-plugin.repository';
import { DirectoryPluginRepository } from '../repositories/directory-plugin.repository';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginEvents, SETTING_SOURCE_PRIORITY } from '../plugins.constants';

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

        // Get settings from each level
        const adminEntity = await this.pluginRepository.findByPluginId(pluginId);
        const adminSettings = adminEntity?.settings || {};
        const adminSecrets = options?.includeSecrets ? adminEntity?.secretSettings || {} : {};

        let userSettings: Record<string, unknown> = {};
        let userSecrets: Record<string, unknown> = {};
        if (options?.userId) {
            const userEntity = await this.userPluginRepository.findByUserAndPlugin(
                options.userId,
                pluginId,
            );
            userSettings = userEntity?.settings || {};
            userSecrets = options?.includeSecrets ? userEntity?.secretSettings || {} : {};
        }

        let directorySettings: Record<string, unknown> = {};
        let directorySecrets: Record<string, unknown> = {};
        if (options?.directoryId) {
            const dirEntity = await this.directoryPluginRepository.findByDirectoryAndPlugin(
                options.directoryId,
                pluginId,
            );
            directorySettings = dirEntity?.settings || {};
            directorySecrets = options?.includeSecrets ? dirEntity?.secretSettings || {} : {};
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
                options,
            );
        }

        return resolved;
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
        const registered = this.registry.get(pluginId);
        if (!registered) {
            throw new Error(`Plugin "${pluginId}" not found`);
        }

        // Validate settings
        const validation = await registered.plugin.validateSettings(settings);
        if (!validation.valid) {
            throw new Error(
                `Invalid settings: ${validation.errors?.map((e) => e.message).join(', ')}`,
            );
        }

        // Separate regular and secret settings
        const regularSettings: Record<string, unknown> = {};
        const secretSettings: Record<string, unknown> = {};
        const secretKeys = new Set(options?.secretKeys || []);

        // Also check schema for secret definitions
        const definitions = this.extractSettingDefinitions(registered.plugin.settingsSchema);
        for (const def of definitions) {
            if (def.secret) {
                secretKeys.add(def.key);
            }
        }

        for (const [key, value] of Object.entries(settings)) {
            if (secretKeys.has(key)) {
                secretSettings[key] = value;
            } else {
                regularSettings[key] = value;
            }
        }

        // Update in database
        const entity = await this.pluginRepository.findByPluginId(pluginId);
        if (entity) {
            await this.pluginRepository.updateSettings(
                pluginId,
                { ...entity.settings, ...regularSettings },
                { ...entity.secretSettings, ...secretSettings },
            );
        }

        // Emit settings changed event
        this.eventEmitter.emit(PluginEvents.SETTINGS_CHANGED, {
            pluginId,
            changedKeys: Object.keys(settings),
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
        const registered = this.registry.get(pluginId);
        if (!registered) {
            throw new Error(`Plugin "${pluginId}" not found`);
        }

        // Validate settings
        const validation = await registered.plugin.validateSettings(settings);
        if (!validation.valid) {
            throw new Error(
                `Invalid settings: ${validation.errors?.map((e) => e.message).join(', ')}`,
            );
        }

        // Separate regular and secret settings
        const regularSettings: Record<string, unknown> = {};
        const secretSettings: Record<string, unknown> = {};
        const secretKeys = new Set(options?.secretKeys || []);

        const definitions = this.extractSettingDefinitions(registered.plugin.settingsSchema);
        for (const def of definitions) {
            if (def.secret) {
                secretKeys.add(def.key);
            }
        }

        for (const [key, value] of Object.entries(settings)) {
            if (secretKeys.has(key)) {
                secretSettings[key] = value;
            } else {
                regularSettings[key] = value;
            }
        }

        // Get plugin entity ID
        const pluginEntity = await this.pluginRepository.findByPluginId(pluginId);
        if (!pluginEntity) {
            throw new Error(`Plugin entity not found for ${pluginId}`);
        }

        // Upsert user plugin record
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

        // Emit settings changed event
        this.eventEmitter.emit(PluginEvents.SETTINGS_CHANGED, {
            pluginId,
            changedKeys: Object.keys(settings),
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
        const registered = this.registry.get(pluginId);
        if (!registered) {
            throw new Error(`Plugin "${pluginId}" not found`);
        }

        // Validate settings
        const validation = await registered.plugin.validateSettings(settings);
        if (!validation.valid) {
            throw new Error(
                `Invalid settings: ${validation.errors?.map((e) => e.message).join(', ')}`,
            );
        }

        // Separate regular and secret settings
        const regularSettings: Record<string, unknown> = {};
        const secretSettings: Record<string, unknown> = {};
        const secretKeys = new Set(options?.secretKeys || []);

        const definitions = this.extractSettingDefinitions(registered.plugin.settingsSchema);
        for (const def of definitions) {
            if (def.secret) {
                secretKeys.add(def.key);
            }
        }

        for (const [key, value] of Object.entries(settings)) {
            if (secretKeys.has(key)) {
                secretSettings[key] = value;
            } else {
                regularSettings[key] = value;
            }
        }

        // Get plugin entity ID
        const pluginEntity = await this.pluginRepository.findByPluginId(pluginId);
        if (!pluginEntity) {
            throw new Error(`Plugin entity not found for ${pluginId}`);
        }

        // Upsert directory plugin record
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

        // Emit settings changed event
        this.eventEmitter.emit(PluginEvents.SETTINGS_CHANGED, {
            pluginId,
            changedKeys: Object.keys(settings),
            scope: 'directory',
            directoryId,
            timestamp: Date.now(),
        });

        this.logger.debug(
            `Updated directory settings for plugin ${pluginId}, directory ${directoryId}`,
        );
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
     * Validate settings against a plugin's schema
     */
    async validateSettings(
        pluginId: string,
        settings: Record<string, unknown>,
    ): Promise<{ valid: boolean; errors?: string[] }> {
        const registered = this.registry.get(pluginId);
        if (!registered) {
            return { valid: false, errors: [`Plugin "${pluginId}" not found`] };
        }

        const result = await registered.plugin.validateSettings(settings);
        return {
            valid: result.valid,
            errors: result.errors?.map((e) => e.message),
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

        // Resolution order based on priority
        // 1. Directory settings (if directoryId provided)
        if (options?.directoryId && sources.directory[key] !== undefined) {
            return {
                key,
                value: sources.directory[key],
                source: 'directory',
                isFallback: false,
            };
        }

        // 2. User settings (if userId provided)
        if (options?.userId && sources.user[key] !== undefined) {
            return {
                key,
                value: sources.user[key],
                source: 'user',
                isFallback: settingScope === 'directory',
            };
        }

        // 3. Admin settings
        if (sources.admin[key] !== undefined) {
            return {
                key,
                value: sources.admin[key],
                source: 'admin',
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
                'x-category'?: string;
                'x-requiresRestart'?: boolean;
            };

            definitions.push({
                key,
                schema: prop,
                scope: prop['x-scope'] || 'global',
                envVar: prop['x-envVar'],
                secret: prop['x-secret'] || false,
                category: prop['x-category'],
                requiresRestart: prop['x-requiresRestart'] || false,
                defaultValue: prop.default,
            });
        }

        return definitions;
    }
}
