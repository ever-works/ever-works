import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SearchFacadeService, NoProviderError } from '@ever-works/agent/facades';
import { PluginRegistryService, PluginSettingsService } from '@ever-works/agent/plugins';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { JsonSchema } from '@ever-works/plugin';
import { CurrentUser, AuthSessionGuard } from '../../auth';
import { AuthenticatedUser } from '../../auth/types/auth.types';
import { SearchDto } from './dto/search.dto';

@ApiTags('Search')
@ApiBearerAuth('JWT-auth')
@Controller('api/search')
@UseGuards(AuthSessionGuard)
export class SearchController {
    constructor(
        private readonly searchFacade: SearchFacadeService,
        private readonly pluginRegistry: PluginRegistryService,
        private readonly pluginSettings: PluginSettingsService,
        private readonly ownershipService: WorkOwnershipService,
    ) {}

    /**
     * Check if all required settings fields are configured for a plugin.
     * Mirrors PluginOperationsService.checkHasUnconfiguredRequiredSettings logic,
     * but uses fully resolved settings (4-level: work > user > admin > env > defaults).
     */
    private hasAllRequiredSettings(
        schema: JsonSchema | undefined,
        resolvedSettings: Record<string, unknown>,
    ): boolean {
        if (!schema?.required || !schema.properties) return true;

        for (const field of schema.required) {
            const propSchema = schema.properties[field];
            if (!propSchema) continue;

            // Skip fields that can come from env vars or admin-only config
            if (propSchema['x-envVar']) continue;
            if (propSchema['x-adminOnly']) continue;

            const value = resolvedSettings[field];
            if (value === undefined || value === null || value === '') {
                return false;
            }
        }

        return true;
    }

    /**
     * Resolve the first search plugin that is enabled AND has all required settings configured.
     * Priority: defaultForCapabilities first, then by registration order.
     */
    private async resolveConfiguredProvider(
        userId: string,
        workId?: string,
    ): Promise<{ id: string; name: string } | null> {
        const enabledPlugins = await this.pluginRegistry.getEnabledPluginsScoped(
            PLUGIN_CAPABILITIES.SEARCH,
            workId,
            userId,
        );

        if (enabledPlugins.length === 0) return null;

        // Sort: defaultForCapabilities first
        const sorted = [...enabledPlugins].sort((a, b) => {
            const aDefault = a.manifest.defaultForCapabilities?.includes(PLUGIN_CAPABILITIES.SEARCH)
                ? 0
                : 1;
            const bDefault = b.manifest.defaultForCapabilities?.includes(PLUGIN_CAPABILITIES.SEARCH)
                ? 0
                : 1;
            return aDefault - bDefault;
        });

        for (const registered of sorted) {
            const settingsScope: { userId: string; workId?: string; includeSecrets: true } = {
                userId,
                includeSecrets: true,
            };
            if (workId) settingsScope.workId = workId;

            const settings = await this.pluginSettings.getSettings(
                registered.plugin.id,
                settingsScope,
            );

            if (this.hasAllRequiredSettings(registered.plugin.settingsSchema, settings)) {
                return {
                    id: registered.plugin.id,
                    name: registered.plugin.name,
                };
            }
        }

        return null;
    }

    /**
     * Check if the authenticated user has an enabled and fully configured search provider.
     */
    @Get('/check-availability')
    @ApiOperation({
        summary: 'Check search availability',
        description:
            'Check if the current user has an enabled search provider with all required settings configured',
    })
    @ApiResponse({ status: 200, description: 'Availability status' })
    async checkAvailability(@CurrentUser() auth: AuthenticatedUser) {
        const provider = await this.resolveConfiguredProvider(auth.userId);

        if (!provider) {
            const enabledPlugins = await this.pluginRegistry.getEnabledPluginsScoped(
                PLUGIN_CAPABILITIES.SEARCH,
                undefined,
                auth.userId,
            );

            return {
                status: 'success',
                available: false,
                activeProvider: null,
                message:
                    enabledPlugins.length > 0
                        ? 'Search plugins are enabled but none have all required settings configured (e.g. API key).'
                        : 'No search provider is enabled. Enable a search plugin (e.g. Tavily, Linkup, Brave, Exa) in settings.',
            };
        }

        return {
            status: 'success',
            available: true,
            activeProvider: {
                id: provider.id,
                name: provider.name,
            },
        };
    }

    /**
     * Search the web using the user's first enabled + configured search provider.
     */
    @Post('/')
    @ApiOperation({
        summary: 'Search the web',
        description:
            "Search the web using the user's first enabled and fully configured search provider",
    })
    @ApiResponse({ status: 200, description: 'Search results' })
    @ApiResponse({ status: 400, description: 'Search failed or no provider configured' })
    async search(@CurrentUser() auth: AuthenticatedUser, @Body() dto: SearchDto) {
        if (dto.workId) {
            await this.ownershipService.ensureCanView(dto.workId, auth.userId);
        }

        const provider = await this.resolveConfiguredProvider(auth.userId, dto.workId);

        if (!provider) {
            throw new BadRequestException({
                status: 'error',
                message: 'No search provider with all required settings configured is available.',
            });
        }

        try {
            const results = await this.searchFacade.search(
                dto.query,
                {
                    maxResults: dto.maxResults,
                    includeDomains: dto.includeDomains,
                    excludeDomains: dto.excludeDomains,
                },
                {
                    userId: auth.userId,
                    ...(dto.workId && { workId: dto.workId }),
                    providerOverride: provider.id,
                },
            );

            return {
                status: 'success',
                results,
                provider: provider.name,
            };
        } catch (error) {
            if (error instanceof NoProviderError) {
                throw new BadRequestException({
                    status: 'error',
                    message: 'No search provider configured. Enable a search plugin in settings.',
                });
            }
            throw new BadRequestException({
                status: 'error',
                message: error instanceof Error ? error.message : 'Search failed',
            });
        }
    }
}
