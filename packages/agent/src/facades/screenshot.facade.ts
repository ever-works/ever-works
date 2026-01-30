import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    IScreenshotFacade,
    ScreenshotCaptureOptions,
    ScreenshotCaptureResult,
    SmartImageOptions,
    SmartImageResult,
    IScreenshotPlugin,
    IPlugin,
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { BaseFacadeService, BaseFacadeOptions } from './base.facade';

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

export interface ScreenshotFacadeOptions extends BaseFacadeOptions {}

/**
 * Screenshot Facade - simple interface for capturing screenshots.
 *
 * Extends BaseFacadeService to inherit:
 * - Three-level enable resolution (Directory > User > Generation)
 * - Default provider resolution via activeCapability
 * - Settings resolution via 4-level hierarchy
 */
@Injectable()
export class ScreenshotFacadeService extends BaseFacadeService implements IScreenshotFacade {
    protected readonly logger = new Logger(ScreenshotFacadeService.name);
    protected readonly CAPABILITY = 'screenshot';

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() directoryPluginRepository?: DirectoryPluginRepository,
        @Optional() userPluginRepository?: UserPluginRepository,
    ) {
        super(registry, settingsService, directoryPluginRepository, userPluginRepository);
    }

    async capture(
        options: ScreenshotCaptureOptions,
        facadeOptions?: ScreenshotFacadeOptions,
    ): Promise<ScreenshotCaptureResult> {
        const plugin = await this.resolvePlugin(
            facadeOptions?.providerOverride,
            facadeOptions?.userId,
            facadeOptions?.directoryId,
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

    /** Alias for isConfigured() for interface compatibility */
    isAvailable(): boolean {
        return this.isConfigured();
    }

    override getAvailableProviders(): Array<{
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

    protected override getProviderName(plugin: IPlugin): string {
        return (plugin as IScreenshotPlugin).providerName || plugin.name;
    }

    /**
     * Resolve which screenshot plugin to use.
     *
     * Resolution order:
     * 1. Explicit provider override
     * 2. Directory default (activeCapability)
     * 3. First enabled screenshot provider that passes enable check
     */
    private async resolvePlugin(
        providerOverride?: string,
        userId?: string,
        directoryId?: string,
    ): Promise<IScreenshotPlugin> {
        // 1. Explicit override
        if (providerOverride) {
            const registered = this.registry.get(providerOverride);
            if (
                registered &&
                registered.manifest.capabilities.includes(this.CAPABILITY) &&
                registered.state === 'enabled'
            ) {
                // Check if enabled for this context
                const isEnabled = await this.isPluginEnabled(providerOverride, directoryId, userId);
                if (isEnabled) {
                    return registered.plugin as IScreenshotPlugin;
                }
            }
            throw new ScreenshotProviderNotFoundError(providerOverride);
        }

        // 2. Check for directory default via activeCapability
        const activePlugin = directoryId
            ? await this.findActivePluginForDirectory(directoryId)
            : null;

        if (activePlugin) {
            return activePlugin.plugin as IScreenshotPlugin;
        }

        // 3. Fall back to first enabled screenshot provider that passes enable check
        const enabledPlugins = await this.getEnabledPlugins(directoryId, userId);
        if (enabledPlugins.length > 0) {
            return enabledPlugins[0].plugin as IScreenshotPlugin;
        }

        throw new NoScreenshotProviderError();
    }
}
