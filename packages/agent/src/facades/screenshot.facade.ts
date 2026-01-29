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

/**
 * Screenshot Facade Error Base
 */
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

/**
 * No screenshot provider configured error
 */
export class NoScreenshotProviderError extends ScreenshotFacadeError {
    constructor() {
        super('No screenshot provider configured or available', 'getPlugin');
        this.name = 'NoScreenshotProviderError';
    }
}

/**
 * Screenshot provider not found error
 */
export class ScreenshotProviderNotFoundError extends ScreenshotFacadeError {
    constructor(providerId: string) {
        super(`Screenshot provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'ScreenshotProviderNotFoundError';
    }
}

/**
 * Facade options for provider resolution
 */
export interface ScreenshotFacadeOptions {
    /** User ID for settings resolution */
    userId?: string;
    /** Directory ID for settings resolution */
    directoryId?: string;
    /** Override provider (plugin ID) */
    providerOverride?: string;
}

/**
 * Screenshot Facade service for pipeline steps.
 *
 * Uses the plugin registry to dynamically resolve screenshot providers.
 * Supports 4-level settings resolution hierarchy.
 */
@Injectable()
export class ScreenshotFacadeService implements IScreenshotFacade {
    private readonly logger = new Logger(ScreenshotFacadeService.name);
    private readonly CAPABILITY = 'screenshot';

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
    ) {}

    /**
     * Capture a screenshot of a URL.
     */
    async capture(
        options: ScreenshotCaptureOptions,
        facadeOptions?: ScreenshotFacadeOptions,
    ): Promise<ScreenshotCaptureResult> {
        const plugin = await this.resolvePlugin(
            facadeOptions?.providerOverride,
            facadeOptions?.userId,
            facadeOptions?.directoryId,
        );

        // Get resolved settings for the plugin
        const settings = await this.settingsService.getSettings(plugin.id, {
            userId: facadeOptions?.userId,
            directoryId: facadeOptions?.directoryId,
            includeSecrets: true,
        });

        // Pass settings to plugin so it can use API keys, etc.
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
            settings, // Pass resolved settings to plugin
        });

        return {
            success: result.success,
            imageUrl: result.imageUrl,
            cacheUrl: result.cacheUrl,
            imageBuffer: result.imageBuffer,
            error: result.error,
        };
    }

    /**
     * Get a smart image for a URL based on domain type.
     * Routes image capture based on the domain type for optimal results.
     */
    async getSmartImage(
        options: SmartImageOptions,
        facadeOptions?: ScreenshotFacadeOptions,
    ): Promise<SmartImageResult> {
        const plugin = await this.resolvePlugin(
            facadeOptions?.providerOverride,
            facadeOptions?.userId,
            facadeOptions?.directoryId,
        );

        // Get resolved settings for the plugin
        const settings = await this.settingsService.getSettings(plugin.id, {
            userId: facadeOptions?.userId,
            directoryId: facadeOptions?.directoryId,
            includeSecrets: true,
        });

        // For now, use standard screenshot capture
        // TODO: Implement smart routing logic based on domain type
        // Pass settings to plugin so it can use API keys, etc.
        const result = await plugin.capture({
            url: options.url,
            viewportWidth: 1280,
            viewportHeight: 800,
            format: 'png',
            blockAds: true,
            cache: true,
            settings, // Pass resolved settings to plugin
        });

        return {
            primaryImage: result.cacheUrl || result.imageUrl,
            source: 'screenshot',
        };
    }

    /**
     * Get a pre-signed screenshot URL without actually capturing.
     */
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

    /**
     * Check if any screenshot provider plugin is available.
     */
    isAvailable(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    /**
     * Get all available screenshot provider plugins.
     */
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

    /**
     * Resolve which screenshot plugin to use.
     */
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

        // Fall back to first enabled screenshot provider
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabled = plugins.find((p) => p.state === 'enabled');

        if (enabled) {
            return enabled.plugin as IScreenshotPlugin;
        }

        throw new NoScreenshotProviderError();
    }
}
