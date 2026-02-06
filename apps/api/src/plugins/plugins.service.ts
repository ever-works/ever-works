import {
    Injectable,
    NotFoundException,
    BadRequestException,
    ForbiddenException,
    Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    PluginEntity,
    UserPluginEntity,
    DirectoryPluginEntity,
    PluginRegistryService,
} from '@packages/agent/plugins';
import type { RegisteredPlugin } from '@packages/agent/plugins';
import {
    type JsonSchema,
    type PluginManifest,
    toPluginSettingsSchemaProperty,
} from '@ever-works/plugin';
import { AiFacadeService } from '@packages/agent/facades';
import {
    PluginResponseDto,
    UserPluginResponseDto,
    DirectoryPluginResponseDto,
    PluginListResponseDto,
    DirectoryPluginListResponseDto,
    PluginIconDto,
    PluginSettingsSchemaDto,
    PluginSettingsSchemaPropertyDto,
    SettingsMenuResponseDto,
    SettingsMenuCategoryDto,
    SettingsMenuPluginDto,
} from './dto';
import { SettingsSchemaValidatorService, type SettingsScope } from './services';

/** Placeholder for masked secrets in API responses */
const MASKED_SECRET_PLACEHOLDER = '********';

@Injectable()
export class PluginsService {
    private readonly logger = new Logger(PluginsService.name);

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
    async listPlugins(userId: string): Promise<PluginListResponseDto> {
        const allPlugins = this.pluginRegistryService.getAll();
        const visiblePlugins = allPlugins.filter(
            (p) => (p.manifest?.visibility ?? 'public') !== 'hidden',
        );

        // Get user's plugin installations
        const userPlugins = await this.userPluginRepository.find({
            where: { userId },
        });

        const userPluginMap = new Map(userPlugins.map((up) => [up.pluginId, up]));

        // Map to response DTOs
        const plugins: UserPluginResponseDto[] = visiblePlugins.map((registered) => {
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
    async getPluginsForSettingsMenu(userId: string): Promise<SettingsMenuResponseDto> {
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

            const configMode = registered.plugin.configurationMode || 'hybrid';
            if (configMode === 'admin-only') return false;

            const userPlugin = userPluginMap.get(registered.plugin.id);
            const autoEnabled = registered.manifest?.autoEnable ?? false;
            const isEnabled = userPlugin?.enabled ?? autoEnabled;
            if (!isEnabled) return false;

            // Check if plugin has user-configurable settings
            const schema = registered.plugin.settingsSchema;
            if (!schema?.properties) return false;

            // Check if there are any non-admin-only, non-env-only settings
            const hasUserSettings = Object.values(schema.properties).some((prop) => {
                if (prop['x-envVar']) return false;
                if (prop['x-adminOnly']) return false;
                if (prop['x-hidden']) return false;
                const scope = prop['x-scope'] || 'global';
                return scope === 'global' || scope === 'user';
            });

            return hasUserSettings;
        });

        // Group by category
        const categoryMap = new Map<string, SettingsMenuPluginDto[]>();

        for (const registered of configurablePlugins) {
            const category = registered.manifest.category;
            const userPlugin = userPluginMap.get(registered.plugin.id);

            // Check if plugin has required settings that are not configured
            const hasRequiredSettings = this.checkHasUnconfiguredRequiredSettings(
                registered.plugin.settingsSchema,
                userPlugin?.settings || {},
            );

            const pluginDto: SettingsMenuPluginDto = {
                pluginId: registered.plugin.id,
                name: registered.manifest.name,
                icon: this.extractIcon(registered.manifest),
                enabled: userPlugin?.enabled ?? registered.manifest?.autoEnable ?? false,
                hasRequiredSettings,
            };

            const existing = categoryMap.get(category) || [];
            existing.push(pluginDto);
            categoryMap.set(category, existing);
        }

        // Convert to array of categories (only non-empty)
        const categories: SettingsMenuCategoryDto[] = [];
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
    async getPlugin(pluginId: string, userId: string): Promise<UserPluginResponseDto> {
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
    ): Promise<UserPluginResponseDto> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        // Enforce configurationMode — admin-only plugins cannot have user settings
        if (settings || secretSettings) {
            this.enforceConfigurationMode(registered, 'user');
        }

        // Strip masked placeholders to prevent saving literal "********"
        const schema = registered.plugin.settingsSchema;
        const filteredSettings = this.stripMaskedPlaceholders(settings, schema);
        const filteredSecretSettings = this.stripMaskedPlaceholders(secretSettings, schema);

        // Validate settings against schema if provided
        if (filteredSettings) {
            this.validateSettingsOrThrow(filteredSettings, schema, 'user');
        }
        if (filteredSecretSettings) {
            this.validateSettingsOrThrow(filteredSecretSettings, schema, 'user');
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
            if (filteredSettings) {
                userPlugin.settings = { ...userPlugin.settings, ...filteredSettings };
            }
            if (filteredSecretSettings) {
                userPlugin.secretSettings = {
                    ...userPlugin.secretSettings,
                    ...filteredSecretSettings,
                };
            }
        } else {
            // Create new user plugin record
            userPlugin = this.userPluginRepository.create({
                userId,
                pluginId,
                pluginEntityId: pluginEntity.id,
                enabled: true,
                settings: filteredSettings || {},
                secretSettings: filteredSecretSettings || {},
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
    async disablePluginForUser(pluginId: string, userId: string): Promise<UserPluginResponseDto> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
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
    ): Promise<UserPluginResponseDto> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        // Enforce configurationMode — admin-only plugins cannot have user settings
        if (settings || secretSettings) {
            this.enforceConfigurationMode(registered, 'user');
        }

        const userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        if (!userPlugin) {
            throw new BadRequestException(
                `Plugin "${pluginId}" is not installed for this user. Enable it first.`,
            );
        }

        // Strip masked placeholders to prevent saving literal "********"
        const schema = registered.plugin.settingsSchema;
        const filteredSettings = this.stripMaskedPlaceholders(settings, schema);
        const filteredSecretSettings = this.stripMaskedPlaceholders(secretSettings, schema);

        // Validate settings against schema if provided
        if (filteredSettings) {
            // Validate merged settings to ensure all required fields are present
            const mergedSettings = { ...userPlugin.settings, ...filteredSettings };
            this.validateSettingsOrThrow(mergedSettings, schema, 'user');
        }
        if (filteredSecretSettings) {
            const mergedSecretSettings = {
                ...userPlugin.secretSettings,
                ...filteredSecretSettings,
            };
            this.validateSettingsOrThrow(mergedSecretSettings, schema, 'user');
        }

        // Merge settings
        if (filteredSettings) {
            userPlugin.settings = { ...userPlugin.settings, ...filteredSettings };
        }
        if (filteredSecretSettings) {
            userPlugin.secretSettings = {
                ...userPlugin.secretSettings,
                ...filteredSecretSettings,
            };
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
    ): Promise<DirectoryPluginListResponseDto> {
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

        // Map to response DTOs
        const plugins: DirectoryPluginResponseDto[] = visiblePlugins.map((registered) => {
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
    ): Promise<DirectoryPluginResponseDto> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        // Enforce configurationMode — admin-only plugins cannot have directory settings
        if (options?.settings) {
            this.enforceConfigurationMode(registered, 'directory');
        }

        // Strip masked placeholders to prevent saving literal "********"
        const schema = registered.plugin.settingsSchema;
        const filteredSettings = this.stripMaskedPlaceholders(options?.settings, schema);

        // Validate settings against schema if provided
        if (filteredSettings) {
            this.validateSettingsOrThrow(filteredSettings, schema, 'directory');
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
            if (filteredSettings) {
                directoryPlugin.settings = { ...directoryPlugin.settings, ...filteredSettings };
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
                settings: filteredSettings || {},
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
    ): Promise<DirectoryPluginResponseDto> {
        const registered = this.pluginRegistryService.get(pluginId);
        if (!registered) {
            throw new NotFoundException(`Plugin "${pluginId}" not found`);
        }

        const userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        const directoryPlugin = await this.directoryPluginRepository.findOne({
            where: { directoryId, pluginId },
        });

        if (directoryPlugin) {
            directoryPlugin.enabled = false;
            await this.directoryPluginRepository.save(directoryPlugin);
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
    ): Promise<DirectoryPluginResponseDto> {
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

        const directoryPlugin = await this.directoryPluginRepository.findOne({
            where: { directoryId, pluginId },
        });

        if (!directoryPlugin) {
            throw new BadRequestException(
                `Plugin "${pluginId}" is not enabled for this directory. Enable it first.`,
            );
        }

        // Strip masked placeholders to prevent saving literal "********"
        const schema = registered.plugin.settingsSchema;
        const filteredSettings = this.stripMaskedPlaceholders(settings, schema);
        const filteredSecretSettings = this.stripMaskedPlaceholders(secretSettings, schema);

        // Validate settings against schema if provided
        if (filteredSettings) {
            // Validate merged settings to ensure all required fields are present
            const mergedSettings = { ...directoryPlugin.settings, ...filteredSettings };
            this.validateSettingsOrThrow(mergedSettings, schema, 'directory');
        }
        if (filteredSecretSettings) {
            const mergedSecretSettings = {
                ...directoryPlugin.secretSettings,
                ...filteredSecretSettings,
            };
            this.validateSettingsOrThrow(mergedSecretSettings, schema, 'directory');
        }

        // Merge settings
        if (filteredSettings) {
            directoryPlugin.settings = { ...directoryPlugin.settings, ...filteredSettings };
        }
        if (filteredSecretSettings) {
            directoryPlugin.secretSettings = {
                ...directoryPlugin.secretSettings,
                ...filteredSecretSettings,
            };
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
    ): Promise<DirectoryPluginResponseDto> {
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

        const directoryPlugin = await this.directoryPluginRepository.findOne({
            where: { directoryId, pluginId },
        });

        if (!directoryPlugin) {
            throw new BadRequestException(
                `Plugin "${pluginId}" is not enabled for this directory. Enable it first.`,
            );
        }

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
     * Convert registered plugin to response DTO
     */
    private toPluginResponse(registered: RegisteredPlugin): PluginResponseDto {
        const manifest = registered.manifest;
        return {
            id: registered.plugin.id,
            pluginId: registered.plugin.id,
            name: registered.manifest.name,
            version: registered.manifest.version,
            description: manifest.description,
            readme: manifest.readme,
            category: manifest.category,
            capabilities: [...manifest.capabilities],
            configurationMode: registered.plugin.configurationMode || 'hybrid',
            builtIn: registered.builtIn,
            systemPlugin: manifest.systemPlugin ?? false,
            visibility: manifest.visibility ?? 'public',
            state: registered.state,
            icon: this.extractIcon(manifest),
            settingsSchema: this.extractSettingsSchema(registered.plugin.settingsSchema),
            author: manifest.author,
            homepage: manifest.homepage,
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
    ): UserPluginResponseDto {
        const baseResponse = this.toPluginResponse(registered);
        const autoEnabled = registered.manifest?.autoEnable ?? false;

        return {
            ...baseResponse,
            installed: !!userPlugin || autoEnabled,
            enabled: userPlugin?.enabled ?? autoEnabled,
            settings: userPlugin
                ? this.maskSecretSettings(userPlugin.settings, registered)
                : undefined,
            userPluginId: userPlugin?.id,
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
    ): DirectoryPluginResponseDto {
        const userResponse = this.toUserPluginResponse(registered, userPlugin);
        const autoEnabled = registered.manifest?.autoEnable ?? false;

        return {
            ...userResponse,
            directoryEnabled: directoryPlugin?.enabled ?? autoEnabled,
            activeCapability: directoryPlugin?.activeCapability,
            directorySettings: directoryPlugin
                ? this.maskSecretSettings(directoryPlugin.settings, registered)
                : undefined,
            directoryPluginId: directoryPlugin?.id,
            priority: directoryPlugin?.priority,
        };
    }

    /**
     * Extract icon from manifest
     */
    private extractIcon(manifest: PluginManifest): PluginIconDto | undefined {
        const icon = manifest.icon;
        if (!icon) return undefined;

        return {
            type: icon.type,
            value: icon.value,
            darkValue: icon.darkValue,
            backgroundColor: icon.backgroundColor,
            color: icon.color,
        };
    }

    /**
     * Extract settings schema, filtering out env-only and write-only fields.
     */
    private extractSettingsSchema(schema?: JsonSchema): PluginSettingsSchemaDto | undefined {
        if (!schema) return undefined;

        const properties: Record<string, PluginSettingsSchemaPropertyDto> = {};
        if (schema.properties) {
            for (const [key, prop] of Object.entries(schema.properties)) {
                if (prop['x-envVar']) continue;
                if (prop['x-hidden']) continue;
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
     * Mask secret settings based on schema.
     * Uses JsonSchema type for type-safe property access.
     *
     * SECURITY: This method filters out sensitive fields:
     * - x-envVar: Must come from environment only, never return to client
     * - x-writeOnly: Write-only fields excluded from responses
     * - x-masked: Values replaced with asterisks
     */
    private maskSecretSettings(
        settings: Record<string, unknown>,
        registered: RegisteredPlugin,
    ): Record<string, unknown> {
        const schema = registered.plugin.settingsSchema;
        if (!schema?.properties) return settings;

        const masked: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(settings)) {
            // propSchema is already typed as JsonSchema from the schema.properties definition
            const propSchema: JsonSchema | undefined = schema.properties[key];

            // SECURITY: x-envVar fields must NEVER be returned (must come from env only)
            if (propSchema?.['x-envVar']) {
                continue;
            }

            // Don't include write-only fields
            if (propSchema?.['x-writeOnly']) {
                continue;
            }

            // Mask the value
            if (propSchema?.['x-masked'] && value) {
                masked[key] = '********';
            } else {
                masked[key] = value;
            }
        }
        return masked;
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

    /**
     * Strip masked placeholder values from x-masked fields to prevent saving "********" literally.
     */
    private stripMaskedPlaceholders(
        settings: Record<string, unknown> | undefined,
        schema: JsonSchema | undefined,
    ): Record<string, unknown> | undefined {
        if (!settings) return undefined;

        const maskedFields = new Set<string>();
        if (schema?.properties) {
            for (const [key, propSchema] of Object.entries(schema.properties)) {
                if (propSchema['x-masked']) {
                    maskedFields.add(key);
                }
            }
        }

        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(settings)) {
            if (maskedFields.has(key) && value === MASKED_SECRET_PLACEHOLDER) {
                this.logger.debug(`Stripping masked placeholder for "${key}"`);
                continue;
            }
            filtered[key] = value;
        }

        return Object.keys(filtered).length > 0 ? filtered : undefined;
    }
}
