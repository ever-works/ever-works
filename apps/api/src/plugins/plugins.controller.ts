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
import { WorkOwnershipService } from '@ever-works/agent/services';
import { PluginOperationsService } from '@ever-works/agent/plugins';
import {
    PluginListResponseDto,
    UserPluginResponseDto,
    WorkPluginListResponseDto,
    WorkPluginResponseDto,
    UpdateUserPluginSettingsDto,
    EnableUserPluginDto,
    UpdateWorkPluginSettingsDto,
    EnableWorkPluginDto,
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
        private readonly ownershipService: WorkOwnershipService,
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
            dto.autoEnableForWorks,
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
    // Work Plugin Management
    // ============================================

    @Get('works/:workId/plugins')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List work plugins',
        description: 'Get all plugins with work-specific configuration',
    })
    @ApiParam({ name: 'workId', description: 'Work ID' })
    @ApiResponse({
        status: 200,
        description: 'List of work plugins',
        type: WorkPluginListResponseDto,
    })
    async listWorkPlugins(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
    ): Promise<WorkPluginListResponseDto> {
        await this.ownershipService.ensureCanView(workId, auth.userId);
        return this.pluginsService.listWorkPlugins(workId, auth.userId);
    }

    @Post('works/:workId/plugins/:pluginId/enable')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Enable plugin for work',
        description: 'Enable a plugin for a specific work',
    })
    @ApiParam({ name: 'workId', description: 'Work ID' })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({
        status: 200,
        description: 'Plugin enabled for work',
        type: WorkPluginResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Plugin not installed at user level' })
    @ApiResponse({ status: 404, description: 'Plugin or work not found' })
    async enableWorkPlugin(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Param('pluginId') pluginId: string,
        @Body() dto: EnableWorkPluginDto,
    ): Promise<WorkPluginResponseDto> {
        await this.ownershipService.ensureCanEdit(workId, auth.userId);
        const result = await this.pluginsService.enablePluginForWork(
            workId,
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
                workId,
                actionType: ActivityActionType.PLUGIN_ENABLED,
                action: 'work.plugin_enabled',
                status: ActivityStatus.COMPLETED,
                summary: `Enabled plugin ${pluginId} for work`,
            })
            .catch(() => {});

        return result;
    }

    @Post('works/:workId/plugins/:pluginId/disable')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Disable plugin for work',
        description: 'Disable a plugin for a specific work',
    })
    @ApiParam({ name: 'workId', description: 'Work ID' })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({
        status: 200,
        description: 'Plugin disabled for work',
        type: WorkPluginResponseDto,
    })
    async disableWorkPlugin(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Param('pluginId') pluginId: string,
    ): Promise<WorkPluginResponseDto> {
        await this.ownershipService.ensureCanEdit(workId, auth.userId);
        const result = await this.pluginsService.disablePluginForWork(
            workId,
            pluginId,
            auth.userId,
        );

        this.activityLogService
            .log({
                userId: auth.userId,
                workId,
                actionType: ActivityActionType.PLUGIN_DISABLED,
                action: 'work.plugin_disabled',
                status: ActivityStatus.COMPLETED,
                summary: `Disabled plugin ${pluginId} for work`,
            })
            .catch(() => {});

        return result;
    }

    @Patch('works/:workId/plugins/:pluginId/settings')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update work plugin settings',
        description: 'Update work-specific settings for a plugin',
    })
    @ApiParam({ name: 'workId', description: 'Work ID' })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({
        status: 200,
        description: 'Settings updated',
        type: WorkPluginResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Plugin not enabled for work' })
    async updateWorkPluginSettings(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Param('pluginId') pluginId: string,
        @Body() dto: UpdateWorkPluginSettingsDto,
    ) {
        await this.ownershipService.ensureCanEdit(workId, auth.userId);
        const result = await this.pluginsService.updateWorkPluginSettings(
            workId,
            pluginId,
            auth.userId,
            dto.settings,
            dto.secretSettings,
            dto.metadata,
        );

        const validation = await this.pluginValidationService.tryValidateConnection(
            pluginId,
            auth.userId,
            workId,
        );

        this.activityLogService
            .log({
                userId: auth.userId,
                workId,
                actionType: ActivityActionType.PLUGIN_CONFIGURED,
                action: 'work.plugin_configured',
                status: ActivityStatus.COMPLETED,
                summary: `Updated plugin settings for ${pluginId}`,
            })
            .catch(() => {});

        return { ...result, validation };
    }

    @Post('works/:workId/plugins/:pluginId/capability')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Set active capability',
        description: 'Set this plugin as the active provider for a capability in this work',
    })
    @ApiParam({ name: 'workId', description: 'Work ID' })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({
        status: 200,
        description: 'Capability set',
        type: WorkPluginResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Plugin does not have this capability' })
    async setActiveCapability(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Param('pluginId') pluginId: string,
        @Body() dto: SetActiveCapabilityDto,
    ): Promise<WorkPluginResponseDto> {
        await this.ownershipService.ensureCanEdit(workId, auth.userId);
        return this.pluginsService.setActiveCapability(
            workId,
            pluginId,
            auth.userId,
            dto.capability,
        );
    }
}
