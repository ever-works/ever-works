import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
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
import {
    PluginResponseDto,
    UserPluginResponseDto,
    DirectoryPluginResponseDto,
    PluginListResponseDto,
    DirectoryPluginListResponseDto,
    PluginIconDto,
    PluginSettingsSchemaDto,
    PluginSettingsSchemaPropertyDto,
} from './dto';
import { SettingsSchemaValidatorService, type SettingsScope } from './services';

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

        // Validate settings against schema if provided
        if (settings) {
            this.validateSettingsOrThrow(settings, registered.plugin.settingsSchema, 'user');
        }
        if (secretSettings) {
            this.validateSettingsOrThrow(secretSettings, registered.plugin.settingsSchema, 'user');
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
            if (settings) {
                userPlugin.settings = { ...userPlugin.settings, ...settings };
            }
            if (secretSettings) {
                userPlugin.secretSettings = { ...userPlugin.secretSettings, ...secretSettings };
            }
        } else {
            // Create new user plugin record
            userPlugin = this.userPluginRepository.create({
                userId,
                pluginId,
                pluginEntityId: pluginEntity.id,
                enabled: true,
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

        const userPlugin = await this.userPluginRepository.findOne({
            where: { userId, pluginId },
        });

        if (!userPlugin) {
            throw new BadRequestException(
                `Plugin "${pluginId}" is not installed for this user. Enable it first.`,
            );
        }

        // Validate settings against schema if provided
        if (settings) {
            // Validate merged settings to ensure all required fields are present
            const mergedSettings = { ...userPlugin.settings, ...settings };
            this.validateSettingsOrThrow(mergedSettings, registered.plugin.settingsSchema, 'user');
        }
        if (secretSettings) {
            const mergedSecretSettings = { ...userPlugin.secretSettings, ...secretSettings };
            this.validateSettingsOrThrow(
                mergedSecretSettings,
                registered.plugin.settingsSchema,
                'user',
            );
        }

        // Merge settings
        if (settings) {
            userPlugin.settings = { ...userPlugin.settings, ...settings };
        }
        if (secretSettings) {
            userPlugin.secretSettings = { ...userPlugin.secretSettings, ...secretSettings };
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

        // Validate settings against schema if provided
        if (options?.settings) {
            this.validateSettingsOrThrow(
                options.settings,
                registered.plugin.settingsSchema,
                'directory',
            );
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

        // Validate settings against schema if provided
        if (settings) {
            // Validate merged settings to ensure all required fields are present
            const mergedSettings = { ...directoryPlugin.settings, ...settings };
            this.validateSettingsOrThrow(
                mergedSettings,
                registered.plugin.settingsSchema,
                'directory',
            );
        }
        if (secretSettings) {
            const mergedSecretSettings = { ...directoryPlugin.secretSettings, ...secretSettings };
            this.validateSettingsOrThrow(
                mergedSecretSettings,
                registered.plugin.settingsSchema,
                'directory',
            );
        }

        // Merge settings
        if (settings) {
            directoryPlugin.settings = { ...directoryPlugin.settings, ...settings };
        }
        if (secretSettings) {
            directoryPlugin.secretSettings = {
                ...directoryPlugin.secretSettings,
                ...secretSettings,
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
                if (prop['x-writeOnly']) continue;
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
}
