import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    ScreenshotCaptureOptions,
    ScreenshotCaptureResult,
    SmartImageOptions,
    SmartImageResult,
    IScreenshotPlugin,
    IPlugin,
    IScreenshotFacade,
    FacadeOptions,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { BaseFacadeService } from './base.facade';

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
        facadeOptions?: FacadeOptions,
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
        facadeOptions?: FacadeOptions,
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
        facadeOptions?: FacadeOptions,
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

    // Resolution: override > directory default > first enabled
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
                const isEnabled = await this.isPluginEnabled(providerOverride, directoryId, userId);
                if (isEnabled) return registered.plugin as IScreenshotPlugin;
            }
            throw new ScreenshotProviderNotFoundError(providerOverride);
        }

        if (directoryId) {
            const activePlugin = await this.findActivePluginForDirectory(directoryId);
            if (activePlugin) return activePlugin.plugin as IScreenshotPlugin;
        }

        const enabledPlugins = await this.getEnabledPlugins(directoryId, userId);
        if (enabledPlugins.length > 0) {
            return enabledPlugins[0].plugin as IScreenshotPlugin;
        }

        throw new NoScreenshotProviderError();
    }
}
