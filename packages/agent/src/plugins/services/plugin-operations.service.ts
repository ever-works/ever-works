import {
    Injectable,
    NotFoundException,
    BadRequestException,
    ForbiddenException,
    Logger,
    Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import pickBy from 'lodash/pickBy';
import {
    type IPlugin,
    type JsonSchema,
    type DeviceAuthStatus,
    type PluginManifest,
    isDeviceAuthProvider,
    toPluginSettingsSchemaProperty,
    PLUGIN_CAPABILITIES,
} from '@ever-works/plugin';
import type {
    PluginResponse,
    PluginConnectionStatus,
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
import {
    PluginRegistryService,
    type RegisteredPlugin,
    resolvePluginEnabled,
} from './plugin-registry.service';
import {
    SettingsSchemaValidatorService,
    type SettingsScope,
} from './settings-schema-validator.service';
import { PluginSettingsService } from './plugin-settings.service';
import { AiFacadeService } from '../../facades';
import { WorksConfigSyncRequestedEvent, type WorksConfigSyncReason } from '@src/events';
import {
    addActiveCapability,
    getActiveCapabilities,
    hasActiveCapability,
    removeActiveCapability,
} from '../utils/active-capabilities.util';

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
        private readonly settingsService: PluginSettingsService,
        private readonly aiFacade: AiFacadeService,
        @Optional()
        private readonly eventEmitter?: EventEmitter2,
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
                const userPlugin = userPluginMap.get(registered.plugin.id) ?? null;
                return resolvePluginEnabled({
                    systemPlugin: registered.manifest?.systemPlugin,
                    autoEnable: registered.manifest?.autoEnable,
                    userPlugin,
                    directoryPlugin: null,
                    hasDirectoryContext: false,
                });
            });
        }

        // Map to response
        const plugins = await Promise.all(
            filteredPlugins.map((registered) => {
                const userPlugin = userPluginMap.get(registered.plugin.id);
                return this.toUserPluginResponseWithResolvedSettings(
                    registered,
                    userPlugin,
                    userId,
                );
            }),
        );

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
        const hasVisiblePipelineCategory = allPlugins.some((registered) => {
            const visibility = registered.manifest?.visibility ?? 'public';
            return visibility !== 'hidden' && registered.manifest.category === 'pipeline';
        });

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

            const userPlugin = userPluginMap.get(registered.plugin.id) ?? null;
            const isEnabled = resolvePluginEnabled({
                systemPlugin: registered.manifest?.systemPlugin,
                autoEnable: registered.manifest?.autoEnable,
                userPlugin,
                directoryPlugin: null,
                hasDirectoryContext: false,
            });
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

            const hasRequiredSettings = await this.hasUnconfiguredRequiredSettings(
                registered.plugin.id,
                registered.plugin.settingsSchema,
                userId,
            );

            const pluginItem: SettingsMenuPlugin = {
                pluginId: registered.plugin.id,
                name: registered.manifest.name,
                icon: this.extractIcon(registered.manifest),
                enabled: resolvePluginEnabled({
                    systemPlugin: registered.manifest?.systemPlugin,
                    autoEnable: registered.manifest?.autoEnable,
                    userPlugin: userPlugin ?? null,
                    directoryPlugin: null,
                    hasDirectoryContext: false,
                }),
                hasRequiredSettings,
            };

            const existing = categoryMap.get(category) || [];
            existing.push(pluginItem);
            categoryMap.set(category, existing);
        }

        // Pipeline settings also expose a global default selector, so the category
        // should remain visible even when the user has no enabled pipeline plugins yet.
        if (hasVisiblePipelineCategory && !categoryMap.has('pipeline')) {
            categoryMap.set('pipeline', []);
        }

        // Convert to array of categories (only non-empty)
        const categories: SettingsMenuCategory[] = [];
        for (const [category, plugins] of categoryMap.entries()) {
            if (plugins.length > 0 || category === 'pipeline') {
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
    private async hasUnconfiguredRequiredSettings(
        pluginId: string,
        schema: JsonSchema | undefined,
        userId: string,
    ): Promise<boolean> {
        if (!schema?.properties) return false;
        if (!schema.required?.length && !schema['x-requiredGroups']?.length) return false;

        const resolved = await this.settingsService.getResolvedSettings(pluginId, {
            userId,
            includeSecrets: true,
        });

        for (const field of schema.required ?? []) {
            const propSchema = schema.properties[field];
            if (!propSchema) continue;

            // Skip env-only and admin-only fields
            if (propSchema['x-envVar']) continue;
            if (propSchema['x-adminOnly']) continue;

            const scope = propSchema['x-scope'] || 'global';
            if (scope !== 'global' && scope !== 'user') continue;

            const value = resolved[field]?.value;
            if (value === undefined || value === null || value === '') {
                return true;
            }
        }

        for (const group of schema['x-requiredGroups'] ?? []) {
            const visibleFields = group.fields.filter((field) => {
                const propSchema = schema.properties?.[field];
                if (!propSchema) return false;
                if (propSchema['x-envVar']) return false;
                if (propSchema['x-adminOnly']) return false;
                const scope = propSchema['x-scope'] || 'global';
                return scope === 'global' || scope === 'user';
            });
            if (visibleFields.length === 0) continue;

            const hasAny = visibleFields.some((field) => {
                const value = resolved[field]?.value;
                return value !== undefined && value !== null && value !== '';
            });
            if (!hasAny) return true;
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

    private getDeviceAuthProvider(pluginId: string) {
        const plugin = this.pluginRegistryService.getPlugin(pluginId);
        if (!plugin) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        if (!isDeviceAuthProvider(plugin)) {
            throw new BadRequestException(`Plugin "${pluginId}" does not support device auth`);
        }

        return plugin;
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

        return this.toUserPluginResponseWithResolvedSettings(registered, userPlugin, userId);
    }

    async getPluginDeviceAuthStatus(pluginId: string, userId: string): Promise<DeviceAuthStatus> {
        const plugin = this.getDeviceAuthProvider(pluginId);
        return plugin.getDeviceAuthStatus(userId);
    }

    async startPluginDeviceAuth(pluginId: string, userId: string): Promise<DeviceAuthStatus> {
        const plugin = this.getDeviceAuthProvider(pluginId);
        return plugin.startDeviceAuth(userId);
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
            await this.validateSettingsOrThrow(allSettings, schema, 'user', registered.plugin);
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

        return this.toUserPluginResponseWithResolvedSettings(registered, userPlugin, userId);
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

        let userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        if (userPlugin) {
            userPlugin.enabled = false;
            await this.userPluginRepository.save(userPlugin);
        } else {
            // For autoEnabled plugins with no user record, create a disabled record
            const wouldBeEnabled = resolvePluginEnabled({
                systemPlugin: registered.manifest?.systemPlugin,
                autoEnable: registered.manifest?.autoEnable,
                userPlugin: null,
                directoryPlugin: null,
                hasDirectoryContext: false,
            });
            if (wouldBeEnabled) {
                const pluginEntity = await this.pluginRepository.findOne({
                    where: { pluginId },
                });
                if (pluginEntity) {
                    userPlugin = this.userPluginRepository.create({
                        userId,
                        pluginId,
                        pluginEntityId: pluginEntity.id,
                        enabled: false,
                        autoEnableForDirectories: false,
                        settings: {},
                        secretSettings: {},
                        metadata: {},
                    });
                    await this.userPluginRepository.save(userPlugin);
                }
            }
        }

        this.logger.log(`Plugin "${pluginId}" disabled for user "${userId}"`);

        return this.toUserPluginResponseWithResolvedSettings(registered, userPlugin, userId);
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
            await this.validateSettingsOrThrow(cleanedSettings, schema, 'user', registered.plugin);
        }

        // Strip masked placeholders then merge settings, clearing null keys
        if (settings) {
            const clean = this.stripMaskedValues(settings);
            userPlugin.settings = this.stripNullValues({ ...userPlugin.settings, ...clean });
        }
        if (secretSettings) {
            const clean = this.stripMaskedValues(secretSettings);
            userPlugin.secretSettings = this.stripNullValues({
                ...userPlugin.secretSettings,
                ...clean,
            });
        }
        if (metadata) {
            userPlugin.metadata = { ...userPlugin.metadata, ...metadata };
        }

        await this.userPluginRepository.save(userPlugin);
        this.logger.log(`Plugin "${pluginId}" settings updated for user "${userId}"`);

        return this.toUserPluginResponseWithResolvedSettings(registered, userPlugin, userId);
    }

    /**
     * Set or clear the user's global pipeline default preference.
     *
     * Clears `isGlobalPipelineDefault` from all pipeline plugins for this user,
     * then marks the given plugin (if any) as the global default.
     *
     * @param userId - The user to update
     * @param pluginId - Plugin to set as default, or null to clear
     * @param enforce - When true, this pipeline is forced in the generator form
     */
    async setGlobalPipelineDefault(
        userId: string,
        pluginId: string | null,
        enforce: boolean,
    ): Promise<void> {
        // Clear the flag from all user plugins in the DB that have it set.
        // Querying the DB directly (rather than the registry) ensures stale flags from
        // previously-registered-but-now-unloaded plugins are also removed.
        const flaggedPlugins = await this.userPluginRepository.find({ where: { userId } });
        for (const existing of flaggedPlugins) {
            if (existing.metadata?.isGlobalPipelineDefault) {
                let newMeta = { ...existing.metadata };
                delete newMeta.isGlobalPipelineDefault;
                delete newMeta.globalPipelineDefaultEnforce;
                await this.userPluginRepository.save({ ...existing, metadata: newMeta });
            }
        }

        if (!pluginId) return;

        // Ensure the target plugin exists
        const target = this.pluginRegistryService.get(pluginId);
        if (!target) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }
        if (!target.plugin.capabilities.includes(PLUGIN_CAPABILITIES.PIPELINE)) {
            throw new BadRequestException(`Plugin "${pluginId}" is not a pipeline plugin`);
        }

        // Find or create the user plugin record for the target
        let userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        if (!userPlugin) {
            const pluginEntity = await this.pluginRepository.findOne({ where: { pluginId } });
            if (!pluginEntity) {
                throw new NotFoundException(`Plugin entity "${pluginId}" not found`);
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

        userPlugin.metadata = {
            ...userPlugin.metadata,
            isGlobalPipelineDefault: true,
            globalPipelineDefaultEnforce: enforce,
        };
        await this.userPluginRepository.save(userPlugin);
        this.logger.log(
            `Global pipeline default set to "${pluginId}" (enforce=${enforce}) for user "${userId}"`,
        );
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

        // Build registry map for quick supplementary lookups
        const registryMap = new Map(allPlugins.map((p) => [p.plugin.id, p]));

        // Build capability providers mapping (exclude supplementary plugins)
        const capabilityProviders: Record<string, string> = {};
        for (const dp of directoryPlugins) {
            if (!dp.enabled) continue;
            const registered = registryMap.get(dp.pluginId);
            if (!registered || registered.manifest.supplementary) continue;
            const userPlugin = userPluginMap.get(dp.pluginId) ?? null;
            const isEnabled = resolvePluginEnabled({
                systemPlugin: registered.manifest?.systemPlugin,
                autoEnable: registered.manifest?.autoEnable,
                userPlugin,
                directoryPlugin: dp,
                hasDirectoryContext: true,
            });
            if (!isEnabled) continue;
            for (const capability of getActiveCapabilities(dp)) {
                capabilityProviders[capability] = dp.pluginId;
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

        this.validateUserLevelRequiredFields(userPlugin, registered.plugin.settingsSchema);

        // Validate settings against schema if provided, using merged (user + new) settings
        if (options?.settings) {
            const allSettings = {
                ...(userPlugin?.settings || {}),
                ...(userPlugin?.secretSettings || {}),
                ...options.settings,
            };
            await this.validateSettingsOrThrow(allSettings, schema, 'directory', registered.plugin);
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
                directoryPlugin.activeCapabilities = addActiveCapability(
                    directoryPlugin,
                    options.activeCapability,
                );
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
                activeCapabilities: options?.activeCapability ? [options.activeCapability] : [],
                priority: options?.priority || 0,
            });
        }

        await this.directoryPluginRepository.save(directoryPlugin);
        this.logger.log(`Plugin "${pluginId}" enabled for directory "${directoryId}"`);

        if (getActiveCapabilities(directoryPlugin).length > 0) {
            this.requestWorksConfigSync(directoryId, userId, 'provider_changed');
        }

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
            // For plugins that would be enabled in this directory, create a record with enabled=false to opt out
            const wouldBeEnabled = resolvePluginEnabled({
                systemPlugin: registered.manifest?.systemPlugin,
                autoEnable: registered.manifest?.autoEnable,
                userPlugin: userPlugin ?? null,
                directoryPlugin: null,
                hasDirectoryContext: true,
            });
            if (wouldBeEnabled) {
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

        if (getActiveCapabilities(directoryPlugin).length > 0) {
            this.requestWorksConfigSync(directoryId, userId, 'provider_changed');
        }

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

        this.validateUserLevelRequiredFields(userPlugin, schema);

        // Validate combined settings against schema.
        // User settings serve as inherited base (mirrors resolved cascade).
        if (settings || secretSettings) {
            // Apply nulls to directory settings first, then strip them
            const dirSettingsAfterUpdate = this.stripNullValues({
                ...directoryPlugin.settings,
                ...(settings || {}),
            });
            const dirSecretsAfterUpdate = this.stripNullValues({
                ...directoryPlugin.secretSettings,
                ...(secretSettings || {}),
            });

            // NOW merge with user settings for validation
            const allSettingsForValidation = {
                ...(userPlugin?.settings || {}),
                ...(userPlugin?.secretSettings || {}),
                ...dirSettingsAfterUpdate,
                ...dirSecretsAfterUpdate,
            };

            await this.validateSettingsOrThrow(
                allSettingsForValidation,
                schema,
                'directory',
                registered.plugin,
            );
        }

        // Strip masked placeholders then merge settings, clearing null keys
        if (settings) {
            const clean = this.stripMaskedValues(settings);
            directoryPlugin.settings = this.stripNullValues({
                ...directoryPlugin.settings,
                ...clean,
            });
        }

        if (secretSettings) {
            const clean = this.stripMaskedValues(secretSettings);
            // Update secretSettings
            directoryPlugin.secretSettings = this.stripNullValues({
                ...directoryPlugin.secretSettings,
                ...clean,
            });

            // Cleanup: also remove secret fields from settings if they exist there
            // (handles migration case where secret fields were stored in wrong field)
            const cleanedSettings = { ...directoryPlugin.settings };
            for (const key of Object.keys(clean)) {
                delete cleanedSettings[key];
            }
            directoryPlugin.settings = cleanedSettings;
        }

        if (metadata) {
            directoryPlugin.metadata = { ...directoryPlugin.metadata, ...metadata };
        }

        await this.directoryPluginRepository.save(directoryPlugin);
        this.logger.log(`Plugin "${pluginId}" settings updated for directory "${directoryId}"`);

        if (hasActiveCapability(directoryPlugin, 'pipeline') && settings?.model !== undefined) {
            this.requestWorksConfigSync(directoryId, userId, 'pipeline_settings_changed');
        }

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

        if (registered.manifest.supplementary) {
            throw new BadRequestException(
                `Plugin "${pluginId}" is a supplementary plugin and cannot be set as an active capability provider`,
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

        // Clear this capability from other plugins in this directory.
        // Each capability has one provider; each plugin can provide many capabilities.
        const directoryPlugins = await this.directoryPluginRepository.find({
            where: { directoryId },
        });
        for (const otherPlugin of directoryPlugins) {
            if (otherPlugin.pluginId === pluginId) continue;
            if (!hasActiveCapability(otherPlugin, capability)) continue;

            otherPlugin.activeCapabilities = removeActiveCapability(otherPlugin, capability);
            await this.directoryPluginRepository.save(otherPlugin);
        }

        // Set this capability as active for this plugin
        directoryPlugin.enabled = true;
        directoryPlugin.activeCapabilities = addActiveCapability(directoryPlugin, capability);
        await this.directoryPluginRepository.save(directoryPlugin);

        this.logger.log(
            `Capability "${capability}" set to plugin "${pluginId}" for directory "${directoryId}"`,
        );

        this.requestWorksConfigSync(directoryId, userId, 'provider_changed');

        return this.toDirectoryPluginResponse(registered, userPlugin, directoryPlugin);
    }

    private requestWorksConfigSync(
        directoryId: string,
        userId: string,
        reason: WorksConfigSyncReason,
    ): void {
        this.eventEmitter?.emit(
            WorksConfigSyncRequestedEvent.EVENT_NAME,
            new WorksConfigSyncRequestedEvent(directoryId, userId, reason),
        );
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
            if (registered.plugin.capabilities.includes('ai-provider')) {
                return await this.aiFacade.getAvailableModels({
                    providerOverride: pluginId,
                    userId,
                });
            }

            const settings = await this.settingsService.getResolvedSettings(pluginId, {
                userId,
                includeSecrets: true,
            });

            return await plugin.listModels(settings);
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
     * Validate that user-level required settings are configured before
     * allowing directory overrides.
     *
     * Individual `required` fields: always enforced at user scope.
     *
     * `x-requiredGroups`: only enforced when every field in the group is
     * user-scoped (directory can't satisfy any of them). If any field is
     * global or directory-scoped, the group is skipped — directory may
     * fill it during its own validation.
     */
    private validateUserLevelRequiredFields(
        userPlugin: UserPluginEntity | null,
        schema: JsonSchema | undefined,
    ): void {
        if (!schema?.properties) return;
        if (!schema.required?.length && !schema['x-requiredGroups']?.length) return;

        const userSettings = {
            ...(userPlugin?.settings || {}),
            ...(userPlugin?.secretSettings || {}),
        };

        const userOnlyRequired = (schema.required ?? []).filter((field) => {
            const propSchema = schema.properties?.[field];
            return (propSchema?.['x-scope'] || 'global') === 'user';
        });

        const userOnlyGroups = this.filterUserOnlyGroups(schema);

        if (userOnlyRequired.length === 0 && userOnlyGroups.length === 0) return;

        const effectiveSchema: JsonSchema = {
            ...schema,
            required: userOnlyRequired.length > 0 ? userOnlyRequired : undefined,
            'x-requiredGroups': userOnlyGroups.length > 0 ? userOnlyGroups : undefined,
        };

        const result = this.settingsValidator.validateRequiredFields(
            userSettings,
            effectiveSchema,
            'user',
        );
        if (!result.valid) {
            throw new BadRequestException({
                message: 'User-level required settings must be configured first',
                errors: result.errors,
            });
        }
    }

    /**
     * Returns only groups where every field is user-scoped,
     * meaning directory level cannot satisfy them.
     */
    private filterUserOnlyGroups(schema: JsonSchema): { fields: string[]; message?: string }[] {
        const groups = schema['x-requiredGroups'];
        if (!groups) return [];

        return groups
            .filter((group) =>
                group.fields.every((field) => {
                    const propSchema = schema.properties?.[field];
                    return (propSchema?.['x-scope'] || 'global') === 'user';
                }),
            )
            .map((g) => ({ fields: [...g.fields], message: g.message }));
    }

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
            supplementary: manifest.supplementary ?? false,
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
        const enabled = resolvePluginEnabled({
            systemPlugin: registered.manifest?.systemPlugin,
            autoEnable: registered.manifest?.autoEnable,
            userPlugin: userPlugin ?? null,
            directoryPlugin: null,
            hasDirectoryContext: false,
        });

        const mergedSettings = userPlugin
            ? { ...userPlugin.settings, ...userPlugin.secretSettings }
            : undefined;

        return {
            ...baseResponse,
            installed: !!userPlugin || enabled,
            enabled,
            settings: this.maskSecretSettings(mergedSettings, registered.plugin.settingsSchema),
            metadata: userPlugin?.metadata ?? {},
            userPluginId: userPlugin?.id,
            autoEnableForDirectories: userPlugin?.autoEnableForDirectories ?? false,
        };
    }

    private async toUserPluginResponseWithResolvedSettings(
        registered: RegisteredPlugin,
        userPlugin: UserPluginEntity | null | undefined,
        userId: string,
    ): Promise<UserPluginResponse> {
        const response = this.toUserPluginResponse(registered, userPlugin);
        const [resolvedSettings, connectionStatus] = await Promise.all([
            this.getResolvedDisplaySettings(registered, userId),
            this.getConnectionStatus(registered, userId),
        ]);

        if (!resolvedSettings && !connectionStatus) {
            return response;
        }

        return {
            ...response,
            resolvedSettings,
            connectionStatus,
        };
    }

    private async getConnectionStatus(
        registered: RegisteredPlugin,
        userId: string,
    ): Promise<PluginConnectionStatus | undefined> {
        if (!registered.manifest?.uiHints?.includeInOnboarding) {
            return undefined;
        }

        if (registered.plugin.capabilities.includes('oauth')) {
            return undefined;
        }

        const settings = await this.settingsService.getSettings(registered.plugin.id, {
            userId,
            includeSecrets: true,
        });

        if (isDeviceAuthProvider(registered.plugin)) {
            const authModeField =
                registered.manifest.uiHints?.deviceAuth?.authModeField ?? 'authMode';
            const authMode =
                typeof settings[authModeField] === 'string' ? settings[authModeField] : undefined;
            const prefersDeviceAuth = authMode === undefined || authMode === 'device-auth';

            if (prefersDeviceAuth) {
                try {
                    const deviceAuthStatus = await registered.plugin.getDeviceAuthStatus(userId);

                    if (
                        deviceAuthStatus.connected ||
                        deviceAuthStatus.pending ||
                        authMode === 'device-auth'
                    ) {
                        return {
                            connected: deviceAuthStatus.connected,
                            pending: deviceAuthStatus.pending,
                            scope: deviceAuthStatus.scope,
                            message: deviceAuthStatus.message,
                        };
                    }
                } catch (error) {
                    this.logger.warn(
                        `Failed to read device auth status for plugin "${registered.plugin.id}": ${error}`,
                    );
                }
            }
        }

        const plugin = registered.plugin as unknown as Record<string, unknown>;
        const validateConnection = plugin.validateConnection as
            | ((s: Record<string, unknown>) => Promise<{ success: boolean; message: string }>)
            | undefined;

        if (typeof validateConnection === 'function') {
            try {
                const result = await validateConnection.call(registered.plugin, settings);
                return {
                    connected: result.success,
                    scope: 'user',
                    message: result.message,
                };
            } catch (error) {
                this.logger.warn(
                    `Failed to validate onboarding connection for plugin "${registered.plugin.id}": ${error}`,
                );
                return {
                    connected: false,
                    scope: 'user',
                    message: `${registered.plugin.name} is not configured yet.`,
                };
            }
        }

        const isAvailable = plugin.isAvailable as
            | ((s?: Record<string, unknown>) => Promise<boolean>)
            | undefined;

        if (typeof isAvailable === 'function') {
            try {
                const available = await isAvailable.call(registered.plugin, settings);
                return {
                    connected: available,
                    scope: 'user',
                    message: available
                        ? `${registered.plugin.name} is configured.`
                        : `${registered.plugin.name} is not configured yet.`,
                };
            } catch (error) {
                this.logger.warn(
                    `Failed to resolve availability for plugin "${registered.plugin.id}": ${error}`,
                );
            }
        }

        return undefined;
    }

    private async getResolvedDisplaySettings(
        registered: RegisteredPlugin,
        userId: string,
    ): Promise<Record<string, unknown> | undefined> {
        const schema = registered.plugin.settingsSchema;
        if (!schema?.properties) {
            return undefined;
        }

        const resolved = await this.settingsService.getResolvedSettings(registered.plugin.id, {
            userId,
        });

        const displaySettings: Record<string, unknown> = {};

        for (const [key, propSchema] of Object.entries(schema.properties)) {
            if (propSchema['x-hidden'] || propSchema['x-adminOnly']) continue;

            const resolvedSetting = resolved[key];
            if (!resolvedSetting) continue;

            const value = resolvedSetting.value;
            if (value === undefined || value === null || value === '') continue;

            if (propSchema['x-secret']) {
                displaySettings[key] = '••••••••';
                continue;
            }

            displaySettings[key] = value;
        }

        return Object.keys(displaySettings).length > 0 ? displaySettings : undefined;
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

        return {
            ...userResponse,
            directoryEnabled: resolvePluginEnabled({
                systemPlugin: registered.manifest?.systemPlugin,
                autoEnable: registered.manifest?.autoEnable,
                userPlugin: userPlugin ?? null,
                directoryPlugin: directoryPlugin ?? null,
                hasDirectoryContext: true,
            }),
            activeCapabilities: getActiveCapabilities(directoryPlugin),
            directorySettings: this.maskSecretSettings(
                directoryPlugin
                    ? { ...directoryPlugin.settings, ...directoryPlugin.secretSettings }
                    : undefined,
                registered.plugin.settingsSchema,
            ),
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
     * Mask secret values in settings for API responses.
     * Shows first 4 + '••••' + last 4 chars (or first 2 + '••••' + last 2 for short values).
     */
    private maskSecretSettings(
        settings: Record<string, unknown> | undefined,
        schema: JsonSchema | undefined,
    ): Record<string, unknown> | undefined {
        if (!settings || !schema?.properties) return settings;

        let masked: Record<string, unknown> = { ...settings };
        for (const [key, value] of Object.entries(masked)) {
            const propSchema = schema.properties[key];
            if (propSchema?.['x-secret'] && typeof value === 'string' && value.length > 0) {
                masked[key] = this.partialReveal(value);
            }
        }
        return masked;
    }

    private partialReveal(value: string): string {
        const prefixLen = value.length <= 8 ? 2 : 4;
        const suffixLen = prefixLen;
        if (prefixLen + suffixLen >= value.length) {
            return '••••••••';
        }
        return value.slice(0, prefixLen) + '••••' + value.slice(-suffixLen);
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
            requiredGroups: schema['x-requiredGroups']
                ?.map((g) => ({
                    fields: g.fields.filter((f) => f in properties),
                    message: g.message,
                }))
                .filter((g) => g.fields.length > 0),
        };
    }

    /**
     * Validate settings against a plugin's JSON schema,
     * then run the plugin's custom validateSettings hook if defined.
     * Throws BadRequestException if validation fails.
     */
    private async validateSettingsOrThrow(
        settings: Record<string, unknown>,
        schema: JsonSchema | undefined,
        scope: SettingsScope,
        plugin?: IPlugin,
    ): Promise<void> {
        const result = this.settingsValidator.validate(settings, schema, scope);
        if (!result.valid) {
            throw new BadRequestException({
                message: 'Invalid plugin settings',
                errors: result.errors,
            });
        }

        if (plugin?.validateSettings) {
            const pluginResult = await plugin.validateSettings(settings);
            if (!pluginResult.valid) {
                throw new BadRequestException({
                    message: 'Invalid plugin settings',
                    errors: pluginResult.errors?.map((e) => e.message) ?? [
                        'Custom validation failed',
                    ],
                });
            }
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
     * Strip masked placeholder values so they are never persisted to the database.
     * The '••••' (U+2022) pattern is generated by partialReveal() for API responses
     * and must never be saved back as a real value.
     */
    private stripMaskedValues(obj: Record<string, unknown>): Record<string, unknown> {
        return pickBy(obj, (v) => !(typeof v === 'string' && v.includes('••••'))) as Record<
            string,
            unknown
        >;
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

        const wouldBeEnabled = resolvePluginEnabled({
            systemPlugin: manifest?.systemPlugin,
            autoEnable: manifest?.autoEnable,
            userPlugin,
            directoryPlugin: null,
            hasDirectoryContext: true,
        });
        if (!wouldBeEnabled) {
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
            activeCapabilities: [],
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
