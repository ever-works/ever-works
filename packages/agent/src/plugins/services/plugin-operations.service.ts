import {
    Injectable,
    NotFoundException,
    BadRequestException,
    ForbiddenException,
    Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import pickBy from 'lodash/pickBy';
import {
    type JsonSchema,
    type PluginManifest,
    toPluginSettingsSchemaProperty,
} from '@ever-works/plugin';
import type {
    PluginResponse,
    UserPluginResponse,
    DirectoryPluginResponse,
    PluginListResponse,
    DirectoryPluginListResponse,
    PluginIcon,
    PluginSettingsSchema,
    PluginSettingsSchemaProperty,
    SettingsMenuResponse,
    SettingsMenuCategory,
    SettingsMenuPlugin,
} from '@ever-works/plugin/api';
import { PluginEntity } from '../entities/plugin.entity';
import { UserPluginEntity } from '../entities/user-plugin.entity';
import { DirectoryPluginEntity } from '../entities/directory-plugin.entity';
import { PluginRegistryService, type RegisteredPlugin } from './plugin-registry.service';
import {
    SettingsSchemaValidatorService,
    type SettingsScope,
} from './settings-schema-validator.service';
import { AiFacadeService } from '../../facades';

@Injectable()
export class PluginOperationsService {
    private readonly logger = new Logger(PluginOperationsService.name);

    constructor(
        @InjectRepository(PluginEntity)
        private readonly pluginRepository: Repository<PluginEntity>,
        @InjectRepository(UserPluginEntity)
        private readonly userPluginRepository: Repository<UserPluginEntity>,
        @InjectRepository(DirectoryPluginEntity)
        private readonly directoryPluginRepository: Repository<DirectoryPluginEntity>,
        private readonly pluginRegistryService: PluginRegistryService,
        private readonly settingsValidator: SettingsSchemaValidatorService,
        private readonly aiFacade: AiFacadeService,
    ) {}

    // ============================================
    // Plugin List Operations
    // ============================================

    /**
     * List all available plugins with user-specific status
     */
    async listPlugins(userId: string, category?: string): Promise<PluginListResponse> {
        const allPlugins = this.pluginRegistryService.getAll();
        const visiblePlugins = allPlugins.filter(
            (p) => (p.manifest?.visibility ?? 'public') !== 'hidden',
        );

        // Filter by category if provided
        let filteredPlugins = category
            ? visiblePlugins.filter((p) => p.manifest.category === category)
            : visiblePlugins;

        // Get user's plugin installations
        const userPlugins = await this.userPluginRepository.find({
            where: { userId },
        });

        const userPluginMap = new Map(userPlugins.map((up) => [up.pluginId, up]));

        // When filtering by category (settings page), only show enabled plugins
        if (category) {
            filteredPlugins = filteredPlugins.filter((registered) => {
                const userPlugin = userPluginMap.get(registered.plugin.id);
                const autoEnabled = registered.manifest?.autoEnable ?? false;
                return userPlugin?.enabled ?? autoEnabled;
            });
        }

        // Map to response
        const plugins: UserPluginResponse[] = filteredPlugins.map((registered) => {
            const userPlugin = userPluginMap.get(registered.plugin.id);
            return this.toUserPluginResponse(registered, userPlugin);
        });

        return {
            plugins,
            total: plugins.length,
            categories: this.pluginRegistryService.getAvailableCategories(),
            capabilities: this.pluginRegistryService.getAvailableCapabilities(),
        };
    }

    /**
     * Get plugins for settings menu, grouped by category
     * Returns only plugins that have user-configurable settings
     */
    async getPluginsForSettingsMenu(userId: string): Promise<SettingsMenuResponse> {
        const allPlugins = this.pluginRegistryService.getAll();

        // Get user's plugin installations
        const userPlugins = await this.userPluginRepository.find({
            where: { userId },
        });
        const userPluginMap = new Map(userPlugins.map((up) => [up.pluginId, up]));

        // Filter to plugins that:
        // 1. Are visible (not hidden)
        // 2. Are installed and enabled by the user
        // 3. Have user-configurable settings (configurationMode !== 'admin-only')
        // 4. Have settings schema with properties
        const configurablePlugins = allPlugins.filter((registered) => {
            const visibility = registered.manifest?.visibility ?? 'public';
            if (visibility === 'hidden') return false;

            const hasOAuth = registered.plugin.capabilities?.includes('oauth') ?? false;

            const configMode = registered.plugin.configurationMode || 'hybrid';
            if (configMode === 'admin-only' && !hasOAuth) return false;

            const userPlugin = userPluginMap.get(registered.plugin.id);
            const autoEnabled = registered.manifest?.autoEnable ?? false;
            const isEnabled = userPlugin?.enabled ?? autoEnabled;
            if (!isEnabled) return false;

            // Check if plugin has user-configurable settings
            const schema = registered.plugin.settingsSchema;
            if (!schema?.properties && !hasOAuth) return false;

            // Check if there are any non-admin-only settings visible to users
            const hasUserSettings = Object.values(schema?.properties || {}).some((prop) => {
                if (prop['x-adminOnly']) return false;
                if (prop['x-hidden']) return false;
                const scope = prop['x-scope'] || 'global';
                return scope === 'global' || scope === 'user';
            });

            return hasUserSettings || hasOAuth;
        });

        // Group by category
        const categoryMap = new Map<string, SettingsMenuPlugin[]>();

        for (const registered of configurablePlugins) {
            const category = registered.manifest.category;
            const userPlugin = userPluginMap.get(registered.plugin.id);

            // Check if plugin has required settings that are not configured
            const hasRequiredSettings = this.checkHasUnconfiguredRequiredSettings(
                registered.plugin.settingsSchema,
                userPlugin?.settings || {},
            );

            const pluginItem: SettingsMenuPlugin = {
                pluginId: registered.plugin.id,
                name: registered.manifest.name,
                icon: this.extractIcon(registered.manifest),
                enabled: userPlugin?.enabled ?? registered.manifest?.autoEnable ?? false,
                hasRequiredSettings,
            };

            const existing = categoryMap.get(category) || [];
            existing.push(pluginItem);
            categoryMap.set(category, existing);
        }

        // Convert to array of categories (only non-empty)
        const categories: SettingsMenuCategory[] = [];
        for (const [category, plugins] of categoryMap.entries()) {
            if (plugins.length > 0) {
                categories.push({
                    category: category as any,
                    label: this.getCategoryLabel(category),
                    plugins,
                });
            }
        }

        // Sort categories by label
        categories.sort((a, b) => a.label.localeCompare(b.label));

        return { categories };
    }

    /**
     * Check if plugin has required settings that are not configured
     */
    private checkHasUnconfiguredRequiredSettings(
        schema: JsonSchema | undefined,
        settings: Record<string, unknown>,
    ): boolean {
        if (!schema?.required || !schema.properties) return false;

        for (const field of schema.required) {
            const propSchema = schema.properties[field];
            if (!propSchema) continue;

            // Skip env-only and admin-only fields
            if (propSchema['x-envVar']) continue;
            if (propSchema['x-adminOnly']) continue;

            const scope = propSchema['x-scope'] || 'global';
            if (scope !== 'global' && scope !== 'user') continue;

            const value = settings[field];
            if (value === undefined || value === null || value === '') {
                return true;
            }
        }

        return false;
    }

    /**
     * Get human-readable category label
     */
    private getCategoryLabel(category: string): string {
        const labels: Record<string, string> = {
            'ai-provider': 'AI Providers',
            deployment: 'Deployment',
            search: 'Search',
            screenshot: 'Screenshots',
            'content-extractor': 'Content Extractors',
            'data-source': 'Data Sources',
            'git-provider': 'Git Providers',
            pipeline: 'Pipeline',
        };
        return labels[category] || this.formatCategoryLabel(category);
    }

    /**
     * Format unknown category to human-readable label
     */
    private formatCategoryLabel(category: string): string {
        return category
            .split('-')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    /**
     * Get a single plugin by ID with user-specific status
     */
    async getPlugin(pluginId: string, userId: string): Promise<UserPluginResponse> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        const userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        return this.toUserPluginResponse(registered, userPlugin);
    }

    // ============================================
    // User Plugin Operations
    // ============================================

    /**
     * Install/enable a plugin for user
     */
    async enablePluginForUser(
        pluginId: string,
        userId: string,
        settings?: Record<string, unknown>,
        secretSettings?: Record<string, unknown>,
        autoEnableForDirectories?: boolean,
    ): Promise<UserPluginResponse> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        // Enforce configurationMode — admin-only plugins cannot have user settings
        if (settings || secretSettings) {
            this.enforceConfigurationMode(registered, 'user');
        }

        const schema = registered.plugin.settingsSchema;

        // Validate combined settings+secretSettings together against schema
        if (settings || secretSettings) {
            const allSettings = {
                ...(settings || {}),
                ...(secretSettings || {}),
            };
            this.validateSettingsOrThrow(allSettings, schema, 'user');
        }

        // Get the plugin entity from database
        const pluginEntity = await this.pluginRepository.findOne({
            where: { pluginId },
        });
        if (!pluginEntity) {
            throw new NotFoundException(`Plugin entity "${pluginId}" not found in database`);
        }

        // Check if user already has this plugin
        let userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        if (userPlugin) {
            // Update existing record
            userPlugin.enabled = true;
            if (autoEnableForDirectories !== undefined) {
                userPlugin.autoEnableForDirectories = autoEnableForDirectories;
            }
            if (settings) {
                userPlugin.settings = { ...userPlugin.settings, ...settings };
            }
            if (secretSettings) {
                userPlugin.secretSettings = {
                    ...userPlugin.secretSettings,
                    ...secretSettings,
                };
            }
        } else {
            // Create new user plugin record
            userPlugin = this.userPluginRepository.create({
                userId,
                pluginId,
                pluginEntityId: pluginEntity.id,
                enabled: true,
                autoEnableForDirectories: autoEnableForDirectories ?? false,
                settings: settings || {},
                secretSettings: secretSettings || {},
                metadata: {},
            });
        }

        await this.userPluginRepository.save(userPlugin);
        this.logger.log(`Plugin "${pluginId}" enabled for user "${userId}"`);

        return this.toUserPluginResponse(registered, userPlugin);
    }

    /**
     * Disable a plugin for user
     */
    async disablePluginForUser(pluginId: string, userId: string): Promise<UserPluginResponse> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        if (registered.manifest.systemPlugin) {
            throw new BadRequestException(
                `Plugin "${pluginId}" is a system plugin and cannot be disabled`,
            );
        }

        const userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        if (userPlugin) {
            userPlugin.enabled = false;
            await this.userPluginRepository.save(userPlugin);
        }

        this.logger.log(`Plugin "${pluginId}" disabled for user "${userId}"`);

        return this.toUserPluginResponse(registered, userPlugin);
    }

    /**
     * Update user plugin settings
     */
    async updateUserPluginSettings(
        pluginId: string,
        userId: string,
        settings?: Record<string, unknown>,
        secretSettings?: Record<string, unknown>,
        metadata?: Record<string, unknown>,
    ): Promise<UserPluginResponse> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        // Enforce configurationMode — admin-only plugins cannot have user settings
        if (settings || secretSettings) {
            this.enforceConfigurationMode(registered, 'user');
        }

        let userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        if (!userPlugin) {
            const autoEnabled = registered.manifest?.autoEnable ?? false;
            if (!autoEnabled) {
                throw new BadRequestException(
                    `Plugin "${pluginId}" is not installed for this user. Enable it first.`,
                );
            }
            // Auto-create user plugin record for autoEnabled plugins
            const pluginEntity = await this.pluginRepository.findOne({
                where: { pluginId },
            });
            if (!pluginEntity) {
                throw new NotFoundException(`Plugin entity "${pluginId}" not found in database`);
            }
            userPlugin = this.userPluginRepository.create({
                userId,
                pluginId,
                pluginEntityId: pluginEntity.id,
                enabled: true,
                settings: {},
                secretSettings: {},
                metadata: {},
            });
        }

        const schema = registered.plugin.settingsSchema;

        // Validate combined settings+secretSettings together against schema
        if (settings || secretSettings) {
            const allSettings = {
                ...userPlugin.settings,
                ...userPlugin.secretSettings,
                ...(settings || {}),
                ...(secretSettings || {}),
            };
            // Strip null values before validation — null means "cleared"
            const cleanedSettings = this.stripNullValues(allSettings);
            this.validateSettingsOrThrow(cleanedSettings, schema, 'user');
        }

        // Merge settings and strip null keys to clear them
        if (settings) {
            userPlugin.settings = this.stripNullValues({ ...userPlugin.settings, ...settings });
        }
        if (secretSettings) {
            userPlugin.secretSettings = this.stripNullValues({
                ...userPlugin.secretSettings,
                ...secretSettings,
            });
        }
        if (metadata) {
            userPlugin.metadata = { ...userPlugin.metadata, ...metadata };
        }

        await this.userPluginRepository.save(userPlugin);
        this.logger.log(`Plugin "${pluginId}" settings updated for user "${userId}"`);

        return this.toUserPluginResponse(registered, userPlugin);
    }

    // ============================================
    // Directory Plugin Operations
    // ============================================

    /**
     * List plugins for a directory with directory-specific status
     */
    async listDirectoryPlugins(
        directoryId: string,
        userId: string,
    ): Promise<DirectoryPluginListResponse> {
        const allPlugins = this.pluginRegistryService.getAll();

        // Filter: visible + applicable to directory scope
        // 'hidden' and 'user-only' plugins are not shown in directory plugins list
        const visiblePlugins = allPlugins.filter((p) => {
            const visibility = p.manifest?.visibility ?? 'public';
            return visibility !== 'hidden' && visibility !== 'user-only';
        });

        const userPlugins = await this.userPluginRepository.find({
            where: { userId },
        });
        const userPluginMap = new Map(userPlugins.map((up) => [up.pluginId, up]));

        // Get directory plugin configurations
        const directoryPlugins = await this.directoryPluginRepository.find({
            where: { directoryId },
        });
        const directoryPluginMap = new Map(directoryPlugins.map((dp) => [dp.pluginId, dp]));

        // Build capability providers mapping
        const capabilityProviders: Record<string, string> = {};
        for (const dp of directoryPlugins) {
            if (dp.enabled && dp.activeCapability) {
                capabilityProviders[dp.activeCapability] = dp.pluginId;
            }
        }

        // Map to response
        const plugins: DirectoryPluginResponse[] = visiblePlugins.map((registered) => {
            const userPlugin = userPluginMap.get(registered.plugin.id);
            const directoryPlugin = directoryPluginMap.get(registered.plugin.id);
            return this.toDirectoryPluginResponse(registered, userPlugin, directoryPlugin);
        });

        return {
            plugins,
            total: plugins.length,
            capabilityProviders,
        };
    }

    /**
     * Enable a plugin for a directory
     */
    async enablePluginForDirectory(
        directoryId: string,
        pluginId: string,
        userId: string,
        options?: {
            settings?: Record<string, unknown>;
            activeCapability?: string;
            priority?: number;
        },
    ): Promise<DirectoryPluginResponse> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        // Enforce configurationMode — admin-only plugins cannot have directory settings
        if (options?.settings) {
            this.enforceConfigurationMode(registered, 'directory');
        }

        const schema = registered.plugin.settingsSchema;

        // Validate settings against schema if provided
        if (options?.settings) {
            this.validateSettingsOrThrow(options.settings, schema, 'directory');
        }

        // Check if user has the plugin enabled (or plugin is autoEnabled)
        const userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        const autoEnabled = registered.manifest?.autoEnable ?? false;
        if (!autoEnabled && (!userPlugin || !userPlugin.enabled)) {
            throw new BadRequestException(
                `Plugin "${pluginId}" must be enabled at user level first`,
            );
        }

        // Get the plugin entity
        const pluginEntity = await this.pluginRepository.findOne({
            where: { pluginId },
        });
        if (!pluginEntity) {
            throw new NotFoundException(`Plugin entity "${pluginId}" not found`);
        }

        // Check if directory already has this plugin configured
        let directoryPlugin = await this.directoryPluginRepository.findOne({
            where: { directoryId, pluginId },
        });

        if (directoryPlugin) {
            // Update existing record
            directoryPlugin.enabled = true;
            if (options?.settings) {
                directoryPlugin.settings = { ...directoryPlugin.settings, ...options.settings };
            }
            if (options?.activeCapability) {
                directoryPlugin.activeCapability = options.activeCapability;
            }
            if (options?.priority !== undefined) {
                directoryPlugin.priority = options.priority;
            }
        } else {
            // Create new directory plugin record
            directoryPlugin = this.directoryPluginRepository.create({
                directoryId,
                pluginId,
                pluginEntityId: pluginEntity.id,
                enabled: true,
                settings: options?.settings || {},
                secretSettings: {},
                metadata: {},
                activeCapability: options?.activeCapability,
                priority: options?.priority || 0,
            });
        }

        await this.directoryPluginRepository.save(directoryPlugin);
        this.logger.log(`Plugin "${pluginId}" enabled for directory "${directoryId}"`);

        return this.toDirectoryPluginResponse(registered, userPlugin, directoryPlugin);
    }

    /**
     * Disable a plugin for a directory
     */
    async disablePluginForDirectory(
        directoryId: string,
        pluginId: string,
        userId: string,
    ): Promise<DirectoryPluginResponse> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        if (registered.manifest.systemPlugin) {
            throw new BadRequestException(
                `Plugin "${pluginId}" is a system plugin and cannot be disabled`,
            );
        }

        const userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        let directoryPlugin = await this.directoryPluginRepository.findOne({
            where: { directoryId, pluginId },
        });

        if (directoryPlugin) {
            directoryPlugin.enabled = false;
            await this.directoryPluginRepository.save(directoryPlugin);
        } else {
            // For autoEnabled or user-auto-enabled plugins, create a record with enabled=false to opt out
            const autoEnabled = registered.manifest?.autoEnable ?? false;
            const userAutoEnabled = userPlugin?.autoEnableForDirectories ?? false;
            if (autoEnabled || userAutoEnabled) {
                const pluginEntity = await this.pluginRepository.findOne({
                    where: { pluginId },
                });
                if (pluginEntity) {
                    directoryPlugin = this.directoryPluginRepository.create({
                        directoryId,
                        pluginId,
                        pluginEntityId: pluginEntity.id,
                        enabled: false,
                        settings: {},
                        secretSettings: {},
                        metadata: {},
                        priority: 0,
                    });
                    await this.directoryPluginRepository.save(directoryPlugin);
                }
            }
        }

        this.logger.log(`Plugin "${pluginId}" disabled for directory "${directoryId}"`);

        return this.toDirectoryPluginResponse(registered, userPlugin, directoryPlugin);
    }

    /**
     * Update directory plugin settings
     */
    async updateDirectoryPluginSettings(
        directoryId: string,
        pluginId: string,
        userId: string,
        settings?: Record<string, unknown>,
        secretSettings?: Record<string, unknown>,
        metadata?: Record<string, unknown>,
    ): Promise<DirectoryPluginResponse> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        // Enforce configurationMode — admin-only plugins cannot have directory settings
        if (settings || secretSettings) {
            this.enforceConfigurationMode(registered, 'directory');
        }

        const userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        const directoryPlugin = await this.ensureDirectoryPlugin(
            directoryId,
            pluginId,
            userPlugin,
            registered.manifest,
        );

        const schema = registered.plugin.settingsSchema;

        // Validate combined settings+secretSettings together against schema
        if (settings || secretSettings) {
            const allSettings = {
                ...directoryPlugin.settings,
                ...directoryPlugin.secretSettings,
                ...(settings || {}),
                ...(secretSettings || {}),
            };
            // Strip null values before validation — null means "cleared"
            const cleanedSettings = this.stripNullValues(allSettings);
            this.validateSettingsOrThrow(cleanedSettings, schema, 'directory');
        }

        // Merge settings and strip null keys to clear them
        if (settings) {
            directoryPlugin.settings = this.stripNullValues({
                ...directoryPlugin.settings,
                ...settings,
            });
        }
        if (secretSettings) {
            directoryPlugin.secretSettings = this.stripNullValues({
                ...directoryPlugin.secretSettings,
                ...secretSettings,
            });
        }
        if (metadata) {
            directoryPlugin.metadata = { ...directoryPlugin.metadata, ...metadata };
        }

        await this.directoryPluginRepository.save(directoryPlugin);
        this.logger.log(`Plugin "${pluginId}" settings updated for directory "${directoryId}"`);

        return this.toDirectoryPluginResponse(registered, userPlugin, directoryPlugin);
    }

    /**
     * Set active capability for a directory plugin
     */
    async setActiveCapability(
        directoryId: string,
        pluginId: string,
        userId: string,
        capability: string,
    ): Promise<DirectoryPluginResponse> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        // Verify the plugin has this capability
        if (!registered.manifest.capabilities.includes(capability)) {
            throw new BadRequestException(
                `Plugin "${pluginId}" does not provide capability "${capability}"`,
            );
        }

        const userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        const directoryPlugin = await this.ensureDirectoryPlugin(
            directoryId,
            pluginId,
            userPlugin,
            registered.manifest,
        );

        // Clear this capability from other plugins in this directory
        await this.directoryPluginRepository
            .createQueryBuilder()
            .update()
            .set({ activeCapability: undefined })
            .where('directoryId = :directoryId', { directoryId })
            .andWhere('activeCapability = :capability', { capability })
            .andWhere('pluginId != :pluginId', { pluginId })
            .execute();

        // Set this capability as active for this plugin
        directoryPlugin.activeCapability = capability;
        await this.directoryPluginRepository.save(directoryPlugin);

        this.logger.log(
            `Capability "${capability}" set to plugin "${pluginId}" for directory "${directoryId}"`,
        );

        return this.toDirectoryPluginResponse(registered, userPlugin, directoryPlugin);
    }

    // ============================================
    // Plugin Model Operations
    // ============================================

    /**
     * List available models for an AI provider plugin.
     * Uses the AI facade to resolve user-scoped credentials before listing models.
     * Returns an empty array if the plugin does not support listing models.
     */
    async listPluginModels(pluginId: string, userId: string): Promise<readonly any[]> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        const plugin = registered.plugin as any;
        if (typeof plugin.listModels !== 'function') {
            return [];
        }

        try {
            return await this.aiFacade.getAvailableModels({
                providerOverride: pluginId,
                userId,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to list models for plugin ${pluginId}: ${(error as Error).message}`,
            );
            return [];
        }
    }

    // ============================================
    // Helper Methods
    // ============================================

    /**
     * Convert registered plugin to response
     */
    private toPluginResponse(registered: RegisteredPlugin): PluginResponse {
        const manifest = registered.manifest;
        return {
            ...manifest,
            id: registered.plugin.id,
            pluginId: registered.plugin.id,
            capabilities: [...manifest.capabilities],
            configurationMode: registered.plugin.configurationMode || 'hybrid',
            builtIn: registered.builtIn,
            systemPlugin: manifest.systemPlugin ?? false,
            visibility: manifest.visibility ?? 'public',
            state: registered.state,
            icon: this.extractIcon(manifest),
            settingsSchema: this.extractSettingsSchema(registered.plugin.settingsSchema),
            autoEnable: manifest.autoEnable ?? false,
        };
    }

    /**
     * Convert to user plugin response
     *
     * For plugins with autoEnable=true, they are considered installed and enabled
     * even without a UserPluginEntity record (unless explicitly disabled).
     */
    private toUserPluginResponse(
        registered: RegisteredPlugin,
        userPlugin?: UserPluginEntity | null,
    ): UserPluginResponse {
        const baseResponse = this.toPluginResponse(registered);
        const autoEnabled = registered.manifest?.autoEnable ?? false;

        return {
            ...baseResponse,
            installed: !!userPlugin || autoEnabled,
            enabled: userPlugin?.enabled ?? autoEnabled,
            settings: userPlugin
                ? { ...userPlugin.settings, ...userPlugin.secretSettings }
                : undefined,
            userPluginId: userPlugin?.id,
            autoEnableForDirectories: userPlugin?.autoEnableForDirectories ?? false,
        };
    }

    /**
     * Convert to directory plugin response
     *
     * For plugins with autoEnable=true, directoryEnabled defaults to true
     * even without a DirectoryPluginEntity record (unless explicitly disabled).
     */
    private toDirectoryPluginResponse(
        registered: RegisteredPlugin,
        userPlugin?: UserPluginEntity | null,
        directoryPlugin?: DirectoryPluginEntity | null,
    ): DirectoryPluginResponse {
        const userResponse = this.toUserPluginResponse(registered, userPlugin);
        const autoEnabled = registered.manifest?.autoEnable ?? false;

        return {
            ...userResponse,
            directoryEnabled:
                directoryPlugin?.enabled ??
                (userPlugin?.autoEnableForDirectories || undefined) ??
                autoEnabled,
            activeCapability: directoryPlugin?.activeCapability,
            directorySettings: directoryPlugin
                ? { ...directoryPlugin.settings, ...directoryPlugin.secretSettings }
                : undefined,
            directoryPluginId: directoryPlugin?.id,
            priority: directoryPlugin?.priority,
        };
    }

    /**
     * Extract icon from manifest
     */
    private extractIcon(manifest: PluginManifest): PluginIcon | undefined {
        const icon = manifest.icon;
        if (!icon) return undefined;

        return { ...icon };
    }

    /**
     * Extract settings schema, filtering out env-only and hidden fields.
     */
    private extractSettingsSchema(schema?: JsonSchema): PluginSettingsSchema | undefined {
        if (!schema) return undefined;

        const properties: Record<string, PluginSettingsSchemaProperty> = {};
        if (schema.properties) {
            for (const [key, prop] of Object.entries(schema.properties)) {
                if (prop['x-hidden']) continue;
                if (prop['x-adminOnly']) continue;
                properties[key] = toPluginSettingsSchemaProperty(prop);
            }
        }

        const filteredRequired = schema.required?.filter((r) => r in properties);

        return {
            type: 'object',
            title: schema.title,
            description: schema.description,
            properties,
            required: filteredRequired?.length ? filteredRequired : undefined,
        };
    }

    /**
     * Validate settings against a plugin's JSON schema.
     * Throws BadRequestException if validation fails.
     */
    private validateSettingsOrThrow(
        settings: Record<string, unknown>,
        schema: JsonSchema | undefined,
        scope: SettingsScope,
    ): void {
        const result = this.settingsValidator.validate(settings, schema, scope);
        if (!result.valid) {
            throw new BadRequestException({
                message: 'Invalid plugin settings',
                errors: result.errors,
            });
        }
    }

    /**
     * Strip null values from a settings object.
     * Null is used as a sentinel to indicate a field was cleared by the user.
     */
    private stripNullValues(obj: Record<string, unknown>): Record<string, unknown> {
        return pickBy(obj, (v) => v !== null) as Record<string, unknown>;
    }

    /**
     * Find an existing DirectoryPluginEntity or auto-create one if the plugin
     * is considered enabled for this directory (via manifest.autoEnable or
     * user autoEnableForDirectories). Throws if the plugin is not enabled.
     */
    private async ensureDirectoryPlugin(
        directoryId: string,
        pluginId: string,
        userPlugin: UserPluginEntity | null,
        manifest: PluginManifest,
    ): Promise<DirectoryPluginEntity> {
        const existing = await this.directoryPluginRepository.findOne({
            where: { directoryId, pluginId },
        });
        if (existing) {
            return existing;
        }

        const autoEnabled = manifest?.autoEnable ?? false;
        const userAutoEnabled = userPlugin?.autoEnableForDirectories ?? false;
        if (!autoEnabled && !userAutoEnabled) {
            throw new BadRequestException(
                `Plugin "${pluginId}" is not enabled for this directory. Enable it first.`,
            );
        }

        const pluginEntity = await this.pluginRepository.findOne({
            where: { pluginId },
        });
        if (!pluginEntity) {
            throw new NotFoundException(`Plugin entity "${pluginId}" not found in database`);
        }

        return this.directoryPluginRepository.create({
            directoryId,
            pluginId,
            pluginEntityId: pluginEntity.id,
            enabled: true,
            settings: {},
            secretSettings: {},
            metadata: {},
            priority: 0,
        });
    }

    /**
     * Enforce configurationMode restrictions.
     * Throws ForbiddenException if the plugin is admin-only and the caller is trying
     * to modify settings at user or directory scope.
     */
    private enforceConfigurationMode(
        registered: RegisteredPlugin,
        scope: 'user' | 'directory',
    ): void {
        const configMode = registered.plugin.configurationMode || 'hybrid';
        if (configMode === 'admin-only') {
            throw new ForbiddenException(
                `Plugin "${registered.plugin.id}" is admin-only and cannot be configured at ${scope} level`,
            );
        }
    }
}
