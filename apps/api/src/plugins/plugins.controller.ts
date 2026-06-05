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
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { PluginOperationsService, PluginInstallerService } from '@ever-works/agent/plugins';
// EW-693 — catalog + install endpoints.
import { PluginCatalogService } from './plugin-catalog.service';
import {
    PluginCatalogResponseDto,
    PluginInstallRequestBodyDto,
    PluginInstallResultDto,
    PluginInstallStateResponseDto,
} from './dto/plugin-install.dto';
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
        // EW-693 — runtime installer + catalog. Optional so bundled-mode
        // deployments without the dynamic-distribution providers wired up
        // (e.g. tests) still construct.
        @Optional()
        private readonly catalogService?: PluginCatalogService,
        @Optional()
        private readonly installer?: PluginInstallerService,
    ) {}

    // ============================================
    // EW-693 — Dynamic plugin distribution
    // ============================================

    @Get('plugins/catalog')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List distributable plugins (EW-693)',
        description:
            'Returns the listable set of distributable plugins (manifest `distribution: "registry"`) ' +
            'merged with per-replica install state. Includes plugins that are NOT yet installed on ' +
            'this node — the UI uses `install.installState` to decide between Install / Enable.',
    })
    @ApiResponse({ status: 200, type: PluginCatalogResponseDto })
    async getCatalog(): Promise<PluginCatalogResponseDto> {
        if (!this.catalogService) {
            // Bundled-mode deployment without the catalog wired up — surface an empty
            // catalog rather than 500ing, so the UI degrades gracefully.
            return { entries: [], fetchedAt: new Date().toISOString(), degraded: true };
        }
        return this.catalogService.listCatalog();
    }

    @Get('plugins/:pluginId/install-status')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Per-plugin install status (EW-693)',
        description:
            'Read-only progress endpoint. Returns the install lifecycle row distinct from the ' +
            'enable state. Poll this after `POST /api/plugins/:id/install` until ' +
            '`installState === "installed" | "error"`.',
    })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({ status: 200, type: PluginInstallStateResponseDto })
    @ApiResponse({ status: 404, description: 'Plugin not found' })
    async getInstallStatus(
        @Param('pluginId') pluginId: string,
    ): Promise<PluginInstallStateResponseDto> {
        if (!this.catalogService) {
            throw new NotFoundException(
                `Plugin "${pluginId}" install status unavailable — dynamic mode not wired.`,
            );
        }
        const state = await this.catalogService.getInstallState(pluginId);
        if (!state) throw new NotFoundException(`Plugin "${pluginId}" not found`);
        return state;
    }

    @Post('plugins/:pluginId/install')
    @HttpCode(HttpStatus.OK)
    // Rate-limit installs (registry protection). Same Throttle decorator used
    // by the rest of the API; the global ThrottlerModule + UserAwareThrottlerGuard
    // pick up the override. 5 installs/min/user is generous for UI flows and
    // tight enough to thwart accidental loops.
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Install a distributable plugin (EW-693)',
        description:
            'Allow-list + integrity-verified install (FR-10, FR-11). Refuses with: ' +
            '409 (non-allowlisted), 424 (integrity mismatch), 502/504 (registry unreachable). ' +
            'Idempotent — repeating after a successful install is a no-op.',
    })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({ status: 200, type: PluginInstallResultDto })
    @ApiResponse({ status: 409, description: 'Plugin not permitted by the allowlist' })
    @ApiResponse({ status: 424, description: 'Integrity mismatch' })
    @ApiResponse({ status: 502, description: 'Registry unreachable / failed' })
    async installPlugin(
        @Param('pluginId') pluginId: string,
        @Body() body: PluginInstallRequestBodyDto,
    ): Promise<PluginInstallResultDto> {
        if (!this.installer || !this.catalogService) {
            throw new NotFoundException(
                `Plugin install unavailable — PLUGIN_DISTRIBUTION_MODE=dynamic not configured.`,
            );
        }
        await this.installer.install({
            pluginId,
            version: body.version,
            integrity: body.integrity,
            source: body.source,
        });
        const install = await this.catalogService.getInstallState(pluginId);
        if (!install) throw new NotFoundException(`Plugin "${pluginId}" not found`);
        return { pluginId, install };
    }

    @Delete('plugins/:pluginId/install')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Uninstall a distributable plugin (EW-693)',
        description:
            'Removes the node_modules symlink + marks installState="available". ' +
            'Refuses with 409 for core / `systemPlugin` plugins. Default retention = ' +
            'keep installed package files on disk; a subsequent install re-links without re-downloading.',
    })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({ status: 200, type: PluginInstallStateResponseDto })
    @ApiResponse({ status: 409, description: 'Core/systemPlugin plugins cannot be uninstalled' })
    async uninstallPlugin(
        @Param('pluginId') pluginId: string,
    ): Promise<PluginInstallStateResponseDto> {
        if (!this.installer || !this.catalogService) {
            throw new NotFoundException(
                `Plugin uninstall unavailable — PLUGIN_DISTRIBUTION_MODE=dynamic not configured.`,
            );
        }
        await this.installer.uninstall(pluginId);
        const install = await this.catalogService.getInstallState(pluginId);
        if (!install) throw new NotFoundException(`Plugin "${pluginId}" not found`);
        return install;
    }

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

    @Get('plugins/:pluginId/connection-status')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Probe a single plugin connection status on demand',
        description:
            'Returns the same `PluginConnectionStatus` shape the list endpoint used to embed eagerly per plugin. Use this from settings drawers / "test connection" buttons so the list endpoint can stay fast (the list response no longer fans out to every external provider on every page load).',
    })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({ status: 200, description: 'Plugin connection status' })
    @ApiResponse({ status: 404, description: 'Plugin not found' })
    async getPluginConnectionStatus(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('pluginId') pluginId: string,
    ): Promise<{
        connectionStatus: Awaited<ReturnType<PluginOperationsService['getPluginConnectionStatus']>>;
    }> {
        const connectionStatus = await this.pluginsService.getPluginConnectionStatus(
            pluginId,
            auth.userId,
        );
        return { connectionStatus };
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
