import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { NoProviderError, ScreenshotFacadeService } from '@ever-works/agent/facades';
import { PluginRegistryService, PluginSettingsService } from '@ever-works/agent/plugins';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { RegisteredPlugin } from '@ever-works/agent/plugins';
import type { JsonSchema, ProviderOption } from '@ever-works/plugin';
import { CurrentUser, AuthSessionGuard } from '../../auth';
import { AuthenticatedUser } from '../../auth/types/auth.types';
import { CaptureScreenshotDto, GetScreenshotUrlDto } from './dto/screenshot.dto';

@ApiTags('Screenshot')
@ApiBearerAuth('JWT-auth')
@Controller('api/screenshot')
@UseGuards(AuthSessionGuard)
export class ScreenshotController {
    constructor(
        private readonly screenshotFacade: ScreenshotFacadeService,
        private readonly pluginRegistry: PluginRegistryService,
        private readonly pluginSettings: PluginSettingsService,
    ) {}

    private hasAllRequiredSettings(
        schema: JsonSchema | undefined,
        resolvedSettings: Record<string, unknown>,
    ): boolean {
        if (!schema?.required || !schema.properties) return true;

        for (const field of schema.required) {
            const propSchema = schema.properties[field];
            if (!propSchema) continue;
            if (propSchema['x-envVar']) continue;
            if (propSchema['x-adminOnly']) continue;

            const value = resolvedSettings[field];
            if (value === undefined || value === null || value === '') {
                return false;
            }
        }

        return true;
    }

    private toProviderOption(
        registered: RegisteredPlugin,
        activePluginId: string | null,
        configured: boolean,
    ): ProviderOption {
        return {
            id: registered.plugin.id,
            name: registered.plugin.name,
            description: registered.manifest.description,
            configured,
            isDefault: activePluginId
                ? registered.plugin.id === activePluginId
                : registered.manifest.defaultForCapabilities?.includes(
                      PLUGIN_CAPABILITIES.SCREENSHOT,
                  ) || registered.manifest.systemPlugin,
            icon: registered.manifest.icon,
        };
    }

    private async listProviders(userId: string, workId?: string) {
        const enabledPlugins = await this.pluginRegistry.getEnabledPluginsScoped(
            PLUGIN_CAPABILITIES.SCREENSHOT,
            workId,
            userId,
        );
        const activeProvider = await this.pluginRegistry.getDefaultForCapabilityScoped(
            PLUGIN_CAPABILITIES.SCREENSHOT,
            workId,
            userId,
        );
        const activePluginId = activeProvider?.plugin.id ?? null;

        const providers: ProviderOption[] = [];

        for (const registered of enabledPlugins) {
            const settings = await this.pluginSettings.getSettings(registered.plugin.id, {
                userId,
                workId,
                includeSecrets: true,
            });

            const configured = this.hasAllRequiredSettings(
                registered.plugin.settingsSchema,
                settings,
            );
            providers.push(this.toProviderOption(registered, activePluginId, configured));
        }

        providers.sort((left, right) => {
            const leftDefaultRank = left.id === activePluginId || left.isDefault ? 0 : 1;
            const rightDefaultRank = right.id === activePluginId || right.isDefault ? 0 : 1;
            if (leftDefaultRank !== rightDefaultRank) {
                return leftDefaultRank - rightDefaultRank;
            }

            const leftConfiguredRank = left.configured ? 0 : 1;
            const rightConfiguredRank = right.configured ? 0 : 1;
            if (leftConfiguredRank !== rightConfiguredRank) {
                return leftConfiguredRank - rightConfiguredRank;
            }

            return left.name.localeCompare(right.name);
        });

        return {
            providers,
            activeProvider:
                providers.find((provider) => provider.id === activePluginId) ??
                providers.find((provider) => provider.isDefault) ??
                null,
        };
    }

    @Get('/check-availability')
    @ApiOperation({ summary: 'Check availability' })
    @ApiResponse({ status: 200, description: 'Availability status' })
    async checkAvailability(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('workId') workId?: string,
    ) {
        const { providers, activeProvider } = await this.listProviders(auth.userId, workId);

        return {
            status: 'success',
            available: providers.some((provider) => provider.configured),
            providers,
            activeProvider,
        };
    }

    @Post('/capture')
    @ApiOperation({ summary: 'Capture screenshot' })
    @ApiResponse({ status: 200, description: 'Screenshot captured successfully' })
    @ApiResponse({ status: 400, description: 'Screenshot capture failed' })
    async capture(@CurrentUser() auth: AuthenticatedUser, @Body() dto: CaptureScreenshotDto) {
        const { providers } = await this.listProviders(auth.userId, dto.workId);

        if (!providers.some((provider) => provider.configured)) {
            throw new BadRequestException({
                status: 'error',
                message: 'No screenshot provider configured',
            });
        }

        let result;
        try {
            result = await this.screenshotFacade.capture(
                {
                    url: dto.url,
                    viewportWidth: dto.viewportWidth,
                    viewportHeight: dto.viewportHeight,
                    format: dto.format,
                    fullPage: dto.fullPage,
                    delay: dto.delay,
                    blockAds: dto.blockAds,
                    blockTrackers: dto.blockTrackers,
                    blockCookieBanners: dto.blockCookieBanners,
                },
                {
                    userId: auth.userId,
                    workId: dto.workId,
                    providerOverride: dto.providerOverride,
                },
            );
        } catch (error) {
            if (error instanceof NoProviderError) {
                throw new BadRequestException({
                    status: 'error',
                    message: 'No screenshot provider configured or available',
                });
            }
            throw error;
        }

        if (!result.success) {
            throw new BadRequestException({
                status: 'error',
                message: result.error || 'Failed to capture screenshot',
            });
        }

        return {
            status: 'success',
            imageUrl: result.cacheUrl || result.imageUrl,
            cacheUrl: result.cacheUrl,
            imageBase64: result.imageBuffer ? result.imageBuffer.toString('base64') : null,
        };
    }

    @Post('/get-url')
    @ApiOperation({ summary: 'Get screenshot URL' })
    async getScreenshotUrl(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: GetScreenshotUrlDto,
    ) {
        const { providers } = await this.listProviders(auth.userId, dto.workId);

        if (!providers.some((provider) => provider.configured)) {
            throw new BadRequestException({
                status: 'error',
                message: 'No screenshot provider configured',
            });
        }

        let imageUrl: string | null;
        try {
            imageUrl = await this.screenshotFacade.getScreenshotUrl(
                {
                    url: dto.url,
                    viewportWidth: dto.viewportWidth,
                    viewportHeight: dto.viewportHeight,
                    format: dto.format,
                    fullPage: dto.fullPage,
                    delay: dto.delay,
                    blockAds: dto.blockAds,
                    blockTrackers: dto.blockTrackers,
                    blockCookieBanners: dto.blockCookieBanners,
                },
                {
                    userId: auth.userId,
                    workId: dto.workId,
                    providerOverride: dto.providerOverride,
                },
            );
        } catch (error) {
            if (error instanceof NoProviderError) {
                throw new BadRequestException({
                    status: 'error',
                    message: 'No screenshot provider configured or available',
                });
            }
            throw error;
        }

        if (!imageUrl) {
            throw new BadRequestException({
                status: 'error',
                message: 'Failed to generate screenshot URL',
            });
        }

        return {
            status: 'success',
            imageUrl,
        };
    }
}
