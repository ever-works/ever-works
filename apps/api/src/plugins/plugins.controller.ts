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
import { JwtAuthGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/jwt.types';
import { DirectoryOwnershipService } from '@packages/agent/services';
import { PluginOperationsService } from '@packages/agent/plugins';
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
} from './dto';

@ApiTags('Plugins')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class PluginsController {
    constructor(
        private readonly pluginsService: PluginOperationsService,
        private readonly ownershipService: DirectoryOwnershipService,
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
        return this.pluginsService.enablePluginForUser(
            pluginId,
            auth.userId,
            dto.settings,
            dto.secretSettings,
        );
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
        return this.pluginsService.disablePluginForUser(pluginId, auth.userId);
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
    ): Promise<UserPluginResponseDto> {
        return this.pluginsService.updateUserPluginSettings(
            pluginId,
            auth.userId,
            dto.settings,
            dto.secretSettings,
            dto.metadata,
        );
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
        return this.pluginsService.enablePluginForDirectory(directoryId, pluginId, auth.userId, {
            settings: dto.settings,
            activeCapability: dto.activeCapability,
            priority: dto.priority,
        });
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
        return this.pluginsService.disablePluginForDirectory(directoryId, pluginId, auth.userId);
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
    ): Promise<DirectoryPluginResponseDto> {
        await this.ownershipService.ensureCanEdit(directoryId, auth.userId);
        return this.pluginsService.updateDirectoryPluginSettings(
            directoryId,
            pluginId,
            auth.userId,
            dto.settings,
            dto.secretSettings,
            dto.metadata,
        );
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
