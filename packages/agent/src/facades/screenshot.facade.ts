import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    ScreenshotCaptureOptions,
    ScreenshotCaptureResult,
    SmartImageOptions,
    SmartImageResult,
    IScreenshotPlugin,
    IScreenshotFacade,
    FacadeOptions,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { BaseFacadeService, FacadeError } from './base.facade';

export class ScreenshotFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'ScreenshotFacadeError';
    }
}

@Injectable()
export class ScreenshotFacadeService extends BaseFacadeService implements IScreenshotFacade {
    protected readonly logger = new Logger(ScreenshotFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.SCREENSHOT;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() directoryPluginRepository?: DirectoryPluginRepository,
    ) {
        super(registry, settingsService, directoryPluginRepository);
    }

    async capture(
        options: ScreenshotCaptureOptions,
        facadeOptions: FacadeOptions,
    ): Promise<ScreenshotCaptureResult> {
        const plugin = await this.resolvePlugin<IScreenshotPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.directoryId,
        );

        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);

        const result = await plugin.capture({
            url: options.url,
            viewportWidth: options.viewportWidth,
            viewportHeight: options.viewportHeight,
            format: options.format,
            fullPage: options.fullPage,
            delay: options.delay,
            blockAds: options.blockAds,
            blockTrackers: options.blockTrackers,
            blockCookieBanners: options.blockCookieBanners,
            cache: options.cache,
            cacheTtl: options.cacheTtl,
            settings,
        });

        return {
            success: result.success,
            imageUrl: result.imageUrl,
            cacheUrl: result.cacheUrl,
            imageBuffer: result.imageBuffer,
            error: result.error,
        };
    }

    async getSmartImage(
        options: SmartImageOptions,
        facadeOptions: FacadeOptions,
    ): Promise<SmartImageResult> {
        const result = await this.capture(
            {
                url: options.url,
                viewportWidth: 1280,
                viewportHeight: 800,
                format: 'png',
                blockAds: true,
                blockCookieBanners: true,
                cache: true,
            },
            facadeOptions,
        );

        return {
            primaryImage: result.cacheUrl || result.imageUrl,
            source: 'screenshot',
        };
    }

    async getScreenshotUrl(
        options: ScreenshotCaptureOptions,
        facadeOptions: FacadeOptions,
    ): Promise<string | null> {
        const plugin = await this.resolvePlugin<IScreenshotPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.directoryId,
        );

        if (!plugin.getScreenshotUrl) {
            return null;
        }

        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        return plugin.getScreenshotUrl({ ...options, settings });
    }

    isAvailable(): boolean {
        return this.isConfigured();
    }
}
