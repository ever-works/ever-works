import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    IBrowserAutomationPlugin,
    BrowserExtractQuery,
    BrowserExtractResult,
    BrowserNavigateResult,
    BrowserScreenshotRequest,
    BrowserScreenshotResult,
    BrowserSessionSpec,
    FacadeOptions,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { BaseFacadeService, FacadeError } from './base.facade';

export class BrowserAutomationFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'BrowserAutomationFacadeError';
    }
}

/** What one `read` produces: where we ended up, and what was on the page. */
export interface BrowserReadResult {
    /** Final URL after every ALLOWED redirect hop. */
    readonly url: string;
    readonly status: number | null;
    readonly title: string;
    readonly redirectChain: readonly string[];
    readonly values: readonly string[];
    readonly truncated: boolean;
    /**
     * Sub-resource requests the navigation policy refused. Surfaced rather
     * than swallowed: "the page looked empty" and "half the page was
     * blocked" are different answers and the caller must be able to tell.
     */
    readonly blockedRequests: BrowserNavigateResult['blockedRequests'];
}

/**
 * Browser-automation facade (audit item G22) — the platform-side consumer
 * of the `browser-automation` capability.
 *
 * ## Why the surface is `read`/`capture` and not the raw plugin
 *
 * The plugin interface is session-based (`open` → navigate/extract/act →
 * `close`), which is right for the provider and wrong for callers: every
 * caller would own a session lifetime, and a caller that throws between
 * `open` and `close` leaks a browser context. Both methods here are
 * one-shot and close the session in a `finally`, so a leaked context needs
 * the provider itself to fail, not merely an unhappy path in a caller.
 *
 * `act` is deliberately NOT exposed yet. Reading a page and driving a page
 * are different risk profiles — the second can submit forms and click
 * through irreversible actions on the user's behalf — and nothing in the
 * platform has asked for it. The capability keeps the method so a future
 * caller can add a facade method with its own gating; it is not reachable
 * by omission rather than by an unreviewed default.
 *
 * Navigation safety is the provider's contract (default-deny allowlist,
 * re-checked on every redirect hop, SSRF guard). This facade does not
 * re-implement it — it resolves settings and lets a blocked navigation
 * throw.
 */
@Injectable()
export class BrowserAutomationFacadeService extends BaseFacadeService {
    protected readonly logger = new Logger(BrowserAutomationFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.BROWSER_AUTOMATION;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    /**
     * Open, navigate, extract, close. The whole point of the one-shot
     * shape: the session cannot outlive the call.
     */
    async read(
        options: {
            readonly url: string;
            readonly query?: BrowserExtractQuery;
            readonly session?: Omit<BrowserSessionSpec, 'settings'>;
        },
        facadeOptions: FacadeOptions,
    ): Promise<BrowserReadResult> {
        const plugin = await this.resolvePlugin<IBrowserAutomationPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.workId,
        );
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);

        const handle = await plugin.open({ ...options.session, settings });
        try {
            const navigation = await plugin.navigate(handle, options.url);
            const extracted: BrowserExtractResult = await plugin.extract(
                handle,
                options.query ?? { format: 'text' },
            );
            return {
                url: navigation.url,
                status: navigation.status,
                title: navigation.title,
                redirectChain: navigation.redirectChain,
                values: extracted.values,
                truncated: extracted.truncated,
                blockedRequests: navigation.blockedRequests,
            };
        } finally {
            await this.closeQuietly(plugin, handle);
        }
    }

    /** Open, navigate, screenshot, close. Same one-shot contract as `read`. */
    async capture(
        options: {
            readonly url: string;
            readonly screenshot?: BrowserScreenshotRequest;
            readonly session?: Omit<BrowserSessionSpec, 'settings'>;
        },
        facadeOptions: FacadeOptions,
    ): Promise<BrowserScreenshotResult & { readonly url: string }> {
        const plugin = await this.resolvePlugin<IBrowserAutomationPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.workId,
        );
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);

        const handle = await plugin.open({ ...options.session, settings });
        try {
            const navigation = await plugin.navigate(handle, options.url);
            const shot = await plugin.screenshot(handle, options.screenshot);
            return { ...shot, url: navigation.url };
        } finally {
            await this.closeQuietly(plugin, handle);
        }
    }

    isAvailable(): boolean {
        return this.isConfigured();
    }

    /**
     * A failed `close` must not replace the caller's real error (or its
     * real result) with a teardown error — the session is already beyond
     * our reach at that point and the only useful action is to say so.
     */
    private async closeQuietly(
        plugin: IBrowserAutomationPlugin,
        handle: Awaited<ReturnType<IBrowserAutomationPlugin['open']>>,
    ): Promise<void> {
        try {
            await plugin.close(handle);
        } catch (error) {
            this.logger.warn(
                `Failed to close browser session ${handle.sessionId} on ${plugin.id}: ` +
                    `${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
