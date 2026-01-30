import { Injectable, Logger } from '@nestjs/common';
import type {
    IScreenshotFacade,
    ScreenshotCaptureOptions,
    ScreenshotCaptureResult,
    SmartImageOptions,
    SmartImageResult,
    IScreenshotPlugin,
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';

export class ScreenshotFacadeError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly provider?: string,
        public readonly cause?: Error,
    ) {
        super(message);
        this.name = 'ScreenshotFacadeError';
    }
}

export class NoScreenshotProviderError extends ScreenshotFacadeError {
    constructor() {
        super('No screenshot provider configured or available', 'getPlugin');
        this.name = 'NoScreenshotProviderError';
    }
}

export class ScreenshotProviderNotFoundError extends ScreenshotFacadeError {
    constructor(providerId: string) {
        super(`Screenshot provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'ScreenshotProviderNotFoundError';
    }
}

export interface ScreenshotFacadeOptions {
    userId?: string;
    directoryId?: string;
    providerOverride?: string;
}

/**
 * Screenshot Facade - simple interface for capturing screenshots.
 */
@Injectable()
export class ScreenshotFacadeService implements IScreenshotFacade {
    private readonly logger = new Logger(ScreenshotFacadeService.name);
    private readonly CAPABILITY = 'screenshot';

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
    ) {}

    async capture(
        options: ScreenshotCaptureOptions,
        facadeOptions?: ScreenshotFacadeOptions,
    ): Promise<ScreenshotCaptureResult> {
        const plugin = await this.resolvePlugin(
            facadeOptions?.providerOverride,
            facadeOptions?.userId,
            facadeOptions?.directoryId,
        );

        const settings = await this.settingsService.getSettings(plugin.id, {
            userId: facadeOptions?.userId,
            directoryId: facadeOptions?.directoryId,
            includeSecrets: true,
        });

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
        facadeOptions?: ScreenshotFacadeOptions,
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
        facadeOptions?: ScreenshotFacadeOptions,
    ): Promise<string | null> {
        const plugin = await this.resolvePlugin(
            facadeOptions?.providerOverride,
            facadeOptions?.userId,
            facadeOptions?.directoryId,
        );

        if (!plugin.getScreenshotUrl) {
            return null;
        }

        return plugin.getScreenshotUrl(options);
    }

    isAvailable(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    getAvailableProviders(): Array<{
        id: string;
        name: string;
        enabled: boolean;
    }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as IScreenshotPlugin).providerName,
            enabled: p.state === 'enabled',
        }));
    }

    private async resolvePlugin(
        providerOverride?: string,
        userId?: string,
        directoryId?: string,
    ): Promise<IScreenshotPlugin> {
        if (providerOverride) {
            const registered = this.registry.get(providerOverride);
            if (
                registered &&
                registered.manifest.capabilities.includes(this.CAPABILITY) &&
                registered.state === 'enabled'
            ) {
                return registered.plugin as IScreenshotPlugin;
            }
            throw new ScreenshotProviderNotFoundError(providerOverride);
        }

        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabled = plugins.find((p) => p.state === 'enabled');

        if (enabled) {
            return enabled.plugin as IScreenshotPlugin;
        }

        throw new NoScreenshotProviderError();
    }
}
