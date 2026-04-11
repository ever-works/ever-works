import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Param,
    Body,
    Query,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { DirectoryOwnershipService } from '@ever-works/agent/services';
import { PluginOperationsService } from '@ever-works/agent/plugins';
import {
    PluginListResponseDto,
    UserPluginResponseDto,
    DirectoryPluginListResponseDto,
    DirectoryPluginResponseDto,
    UpdateUserPluginSettingsDto,
    EnableUserPluginDto,
    UpdateDirectoryPluginSettingsDto,
    EnableDirectoryPluginDto,
    SetActiveCapabilityDto,
    SettingsMenuResponseDto,
    SetGlobalPipelineDefaultDto,
} from './dto';
import { PluginValidationService } from './plugin-validation.service';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';

@ApiTags('Plugins')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(AuthSessionGuard)
export class PluginsController {
    constructor(
        private readonly pluginsService: PluginOperationsService,
        private readonly ownershipService: DirectoryOwnershipService,
        private readonly pluginValidationService: PluginValidationService,
        private readonly activityLogService: ActivityLogService,
    ) {}

    // ============================================
    // Plugin Listing
    // ============================================

    @Get('plugins')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List available plugins',
        description: 'Get all available plugins with user-specific installation status',
    })
    @ApiResponse({ status: 200, description: 'List of plugins', type: PluginListResponseDto })
    async listPlugins(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('category') category?: string,
    ): Promise<PluginListResponseDto> {
        return this.pluginsService.listPlugins(auth.userId, category);
    }

    @Get('plugins/settings-menu')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get plugins for settings menu',
        description:
            'Get user-installed plugins grouped by category for settings navigation. Only returns plugins with user-configurable settings.',
    })
    @ApiResponse({
        status: 200,
        description: 'Settings menu categories',
        type: SettingsMenuResponseDto,
    })
    async getPluginsForSettingsMenu(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<SettingsMenuResponseDto> {
        return this.pluginsService.getPluginsForSettingsMenu(auth.userId);
    }

    @Get('plugins/:pluginId/models')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List available models for an AI provider plugin',
        description:
            'Fetch models from the AI provider. Requires plugin to be enabled with valid credentials.',
    })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({ status: 200, description: 'List of available models' })
    @ApiResponse({ status: 404, description: 'Plugin not found' })
    async listPluginModels(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('pluginId') pluginId: string,
    ): Promise<readonly any[]> {
        return this.pluginsService.listPluginModels(pluginId, auth.userId);
    }

    @Get('plugins/:pluginId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get plugin details',
        description: 'Get detailed information about a specific plugin',
    })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({ status: 200, description: 'Plugin details', type: UserPluginResponseDto })
    @ApiResponse({ status: 404, description: 'Plugin not found' })
    async getPlugin(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('pluginId') pluginId: string,
    ): Promise<UserPluginResponseDto> {
        return this.pluginsService.getPlugin(pluginId, auth.userId);
    }

    // ============================================
    // User Plugin Management
    // ============================================

    @Post('plugins/:pluginId/enable')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Enable plugin for user',
        description: 'Enable/install a plugin for the current user',
    })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({ status: 200, description: 'Plugin enabled', type: UserPluginResponseDto })
    @ApiResponse({ status: 404, description: 'Plugin not found' })
    async enablePlugin(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('pluginId') pluginId: string,
        @Body() dto: EnableUserPluginDto,
    ): Promise<UserPluginResponseDto> {
        const result = await this.pluginsService.enablePluginForUser(
            pluginId,
            auth.userId,
            dto.settings,
            dto.secretSettings,
            dto.autoEnableForDirectories,
        );
        this.activityLogService
            .log({
                userId: auth.userId,
                actionType: ActivityActionType.PLUGIN_ENABLED,
                action: 'plugin.enabled',
                status: ActivityStatus.COMPLETED,
                summary: `Enabled plugin: ${pluginId}`,
            })
            .catch(() => {});
        return result;
    }

    @Post('plugins/:pluginId/disable')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Disable plugin for user',
        description: 'Disable a plugin for the current user',
    })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({ status: 200, description: 'Plugin disabled', type: UserPluginResponseDto })
    @ApiResponse({ status: 404, description: 'Plugin not found' })
    async disablePlugin(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('pluginId') pluginId: string,
    ): Promise<UserPluginResponseDto> {
        const result = await this.pluginsService.disablePluginForUser(pluginId, auth.userId);
        this.activityLogService
            .log({
                userId: auth.userId,
                actionType: ActivityActionType.PLUGIN_DISABLED,
                action: 'plugin.disabled',
                status: ActivityStatus.COMPLETED,
                summary: `Disabled plugin: ${pluginId}`,
            })
            .catch(() => {});
        return result;
    }

    @Patch('plugins/:pluginId/settings')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update plugin settings',
        description: 'Update user-specific settings for a plugin',
    })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({ status: 200, description: 'Settings updated', type: UserPluginResponseDto })
    @ApiResponse({ status: 400, description: 'Plugin not installed' })
    @ApiResponse({ status: 404, description: 'Plugin not found' })
    async updatePluginSettings(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('pluginId') pluginId: string,
        @Body() dto: UpdateUserPluginSettingsDto,
    ) {
        const result = await this.pluginsService.updateUserPluginSettings(
            pluginId,
            auth.userId,
            dto.settings,
            dto.secretSettings,
            dto.metadata,
        );

        const validation = await this.pluginValidationService.tryValidateConnection(
            pluginId,
            auth.userId,
        );

        this.activityLogService
            .log({
                userId: auth.userId,
                actionType: ActivityActionType.PLUGIN_CONFIGURED,
                action: 'plugin.configured',
                status: ActivityStatus.COMPLETED,
                summary: `Updated plugin settings: ${pluginId}`,
            })
            .catch(() => {});

        return { ...result, validation };
    }

    @Post('plugins/pipeline-default')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Set global pipeline default',
        description:
            'Set or clear the global default pipeline for the current user. Optionally enforce it so the generator form cannot override it.',
    })
    @ApiResponse({ status: 200, description: 'Global pipeline default updated' })
    async setGlobalPipelineDefault(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: SetGlobalPipelineDefaultDto,
    ): Promise<void> {
        await this.pluginsService.setGlobalPipelineDefault(
            auth.userId,
            dto.pluginId ?? null,
            dto.enforce,
        );
    }

    @Post('plugins/:pluginId/validate-connection')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Validate plugin connection',
        description: 'Verifies that the current user plugin credentials can connect successfully.',
    })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({ status: 200, description: 'Connection validation result' })
    async validatePluginConnection(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('pluginId') pluginId: string,
    ) {
        return this.pluginValidationService.validateUserPluginConnection(pluginId, auth.userId);
    }

    // ============================================
    // Directory Plugin Management
    // ============================================

    @Get('directories/:directoryId/plugins')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List directory plugins',
        description: 'Get all plugins with directory-specific configuration',
    })
    @ApiParam({ name: 'directoryId', description: 'Directory ID' })
    @ApiResponse({
        status: 200,
        description: 'List of directory plugins',
        type: DirectoryPluginListResponseDto,
    })
    async listDirectoryPlugins(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('directoryId') directoryId: string,
    ): Promise<DirectoryPluginListResponseDto> {
        await this.ownershipService.ensureCanView(directoryId, auth.userId);
        return this.pluginsService.listDirectoryPlugins(directoryId, auth.userId);
    }

    @Post('directories/:directoryId/plugins/:pluginId/enable')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Enable plugin for directory',
        description: 'Enable a plugin for a specific directory',
    })
    @ApiParam({ name: 'directoryId', description: 'Directory ID' })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({
        status: 200,
        description: 'Plugin enabled for directory',
        type: DirectoryPluginResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Plugin not installed at user level' })
    @ApiResponse({ status: 404, description: 'Plugin or directory not found' })
    async enableDirectoryPlugin(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('directoryId') directoryId: string,
        @Param('pluginId') pluginId: string,
        @Body() dto: EnableDirectoryPluginDto,
    ): Promise<DirectoryPluginResponseDto> {
        await this.ownershipService.ensureCanEdit(directoryId, auth.userId);
        const result = await this.pluginsService.enablePluginForDirectory(
            directoryId,
            pluginId,
            auth.userId,
            {
                settings: dto.settings,
                activeCapability: dto.activeCapability,
                priority: dto.priority,
            },
        );

        this.activityLogService
            .log({
                userId: auth.userId,
                directoryId,
                actionType: ActivityActionType.PLUGIN_ENABLED,
                action: 'directory.plugin_enabled',
                status: ActivityStatus.COMPLETED,
                summary: `Enabled plugin ${pluginId} for directory`,
            })
            .catch(() => {});

        return result;
    }

    @Post('directories/:directoryId/plugins/:pluginId/disable')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Disable plugin for directory',
        description: 'Disable a plugin for a specific directory',
    })
    @ApiParam({ name: 'directoryId', description: 'Directory ID' })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({
        status: 200,
        description: 'Plugin disabled for directory',
        type: DirectoryPluginResponseDto,
    })
    async disableDirectoryPlugin(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('directoryId') directoryId: string,
        @Param('pluginId') pluginId: string,
    ): Promise<DirectoryPluginResponseDto> {
        await this.ownershipService.ensureCanEdit(directoryId, auth.userId);
        const result = await this.pluginsService.disablePluginForDirectory(
            directoryId,
            pluginId,
            auth.userId,
        );

        this.activityLogService
            .log({
                userId: auth.userId,
                directoryId,
                actionType: ActivityActionType.PLUGIN_DISABLED,
                action: 'directory.plugin_disabled',
                status: ActivityStatus.COMPLETED,
                summary: `Disabled plugin ${pluginId} for directory`,
            })
            .catch(() => {});

        return result;
    }

    @Patch('directories/:directoryId/plugins/:pluginId/settings')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update directory plugin settings',
        description: 'Update directory-specific settings for a plugin',
    })
    @ApiParam({ name: 'directoryId', description: 'Directory ID' })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({
        status: 200,
        description: 'Settings updated',
        type: DirectoryPluginResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Plugin not enabled for directory' })
    async updateDirectoryPluginSettings(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('directoryId') directoryId: string,
        @Param('pluginId') pluginId: string,
        @Body() dto: UpdateDirectoryPluginSettingsDto,
    ) {
        await this.ownershipService.ensureCanEdit(directoryId, auth.userId);
        const result = await this.pluginsService.updateDirectoryPluginSettings(
            directoryId,
            pluginId,
            auth.userId,
            dto.settings,
            dto.secretSettings,
            dto.metadata,
        );

        const validation = await this.pluginValidationService.tryValidateConnection(
            pluginId,
            auth.userId,
            directoryId,
        );

        this.activityLogService
            .log({
                userId: auth.userId,
                directoryId,
                actionType: ActivityActionType.PLUGIN_CONFIGURED,
                action: 'directory.plugin_configured',
                status: ActivityStatus.COMPLETED,
                summary: `Updated plugin settings for ${pluginId}`,
            })
            .catch(() => {});

        return { ...result, validation };
    }

    @Post('directories/:directoryId/plugins/:pluginId/capability')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Set active capability',
        description: 'Set this plugin as the active provider for a capability in this directory',
    })
    @ApiParam({ name: 'directoryId', description: 'Directory ID' })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({
        status: 200,
        description: 'Capability set',
        type: DirectoryPluginResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Plugin does not have this capability' })
    async setActiveCapability(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('directoryId') directoryId: string,
        @Param('pluginId') pluginId: string,
        @Body() dto: SetActiveCapabilityDto,
    ): Promise<DirectoryPluginResponseDto> {
        await this.ownershipService.ensureCanEdit(directoryId, auth.userId);
        return this.pluginsService.setActiveCapability(
            directoryId,
            pluginId,
            auth.userId,
            dto.capability,
        );
    }
}
