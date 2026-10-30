import { Injectable, Logger } from '@nestjs/common';

/**
 * Reads the values Ever Platform handed this installation for one plugin, or
 * nothing. Called on every settings resolution of that plugin, so it answers
 * from a short-lived cache rather than reaching anything remote.
 */
export type PluginPlatformSettingsSource = () => Promise<Readonly<Record<string, unknown>> | null>;

/**
 * Settings an installation received from Ever Platform for a plugin — today the
 * Ever ID sign-in client an installation connected to Ever Platform is handed
 * (issuer, client id, client secret).
 *
 * They are the lowest level above a plugin's defaults: a value an operator set
 * (admin settings, or the setting's environment variable) always wins, so an
 * installation configured by hand keeps its configuration. A source is
 * registered by the module that holds the values; with none registered, nothing
 * changes and no value is ever read.
 */
@Injectable()
export class PluginPlatformSettingsService {
    private readonly logger = new Logger(PluginPlatformSettingsService.name);
    private readonly sources = new Map<string, PluginPlatformSettingsSource>();

    /** Register the source for one plugin; the returned function removes it again. */
    register(pluginId: string, source: PluginPlatformSettingsSource): () => void {
        this.sources.set(pluginId, source);
        return () => {
            if (this.sources.get(pluginId) === source) this.sources.delete(pluginId);
        };
    }

    /**
     * The values for one plugin. A failing source answers nothing (the plugin then
     * resolves exactly as it would without Ever Platform), and the failure is
     * logged without any value.
     */
    async read(pluginId: string): Promise<Readonly<Record<string, unknown>>> {
        const source = this.sources.get(pluginId);
        if (!source) return {};
        try {
            return (await source()) ?? {};
        } catch (error) {
            this.logger.warn(
                `Ignoring the Ever Platform settings of "${pluginId}": ${
                    error instanceof Error ? error.name : 'unreadable'
                }`,
            );
            return {};
        }
    }
}
