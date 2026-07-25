import { Injectable, Logger, Optional } from '@nestjs/common';
import type { IEventSourcePlugin, IPlugin } from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { EventIngestService } from './event-ingest.service';
import { IngestCursorRepository } from './ingest-cursor.repository';

export interface PullSourcesResult {
    /** Loaded event-source plugins visited. */
    sources: number;
    /** (plugin, user) pairs actually pulled. */
    pulled: number;
    /** `pullEvents` pages fetched across all pairs. */
    pages: number;
    /** New `ingested_events` rows written. */
    inserted: number;
    /** Envelopes dropped as duplicates by the dedupe insert. */
    duplicates: number;
    /** Envelopes rejected by the ingest floor (shape/size). */
    rejected: number;
    /** (plugin, user) pairs that failed — never fail the batch. */
    errors: number;
}

/**
 * Per-tick page budget for one (plugin, user) pair. A sweep larger
 * than this persists its continuation cursor and resumes next tick, so
 * a single noisy source can never monopolize the cron slot.
 */
export const EVENT_SOURCE_PULL_PAGE_BUDGET = 5;

/** `since` handed to a source that has never completed a sweep. */
const EPOCH_ISO = new Date(0).toISOString();

/**
 * Event-ingest spine (Wave 8) — the PULL half of the
 * `event-ingest-tick` cron.
 *
 * `processBatch()` (EventIngestService) drains rows that already
 * landed; this service is what makes rows land for pull-model sources:
 * for every loaded `event-source` plugin it resolves the users who
 * enabled it (their `user_plugins` rows, confirmed through the same
 * `isPluginEnabledForScope` gate the facades use), resolves their
 * settings (4-level hierarchy, secrets included) and calls
 * `pullEvents` with the persisted per-(user, plugin) watermark +
 * continuation cursor (`ingest_cursors`).
 *
 * Sweep/watermark protocol:
 *   - `since` = the row's `watermark` (epoch when none — connectors
 *     interpret that as "first pull" and apply their own opt-in
 *     backfill window).
 *   - a sweep that exhausts the page budget persists `cursor` +
 *     `sweepStartedAt` and resumes next tick with the SAME watermark;
 *   - on completion the watermark advances to when the sweep STARTED
 *     (never "now"), so events landing mid-sweep are re-covered next
 *     tick — overlap is free, the pipeline dedupes on
 *     `(source, sourceEventId)`.
 *
 * Isolation: every (plugin, user) pair is pulled inside its own
 * try/catch — one broken connector (or one user's revoked credentials)
 * never stops the rest of the batch. `EventSourceNotConfiguredError`
 * is the expected quiet case (enabled but not yet configured) — debug,
 * not warn.
 *
 * The plugin-system dependencies are `@Optional()`: they are `@Global`
 * providers in the API process (the only place this service runs — the
 * cron reaches it over the trigger-internal RPC channel) but absent in
 * lean test bootstraps, where `pullSources()` degrades to a no-op.
 */
@Injectable()
export class EventSourcePullService {
    private readonly logger = new Logger(EventSourcePullService.name);

    constructor(
        private readonly eventIngestService: EventIngestService,
        private readonly cursorRepository: IngestCursorRepository,
        @Optional() private readonly registry?: PluginRegistryService,
        @Optional() private readonly settingsService?: PluginSettingsService,
        @Optional() private readonly userPluginRepository?: UserPluginRepository,
    ) {}

    /** Pull every enabled event-source plugin for every opted-in user. */
    async pullSources(pageBudget = EVENT_SOURCE_PULL_PAGE_BUDGET): Promise<PullSourcesResult> {
        const result: PullSourcesResult = {
            sources: 0,
            pulled: 0,
            pages: 0,
            inserted: 0,
            duplicates: 0,
            rejected: 0,
            errors: 0,
        };

        if (!this.registry || !this.settingsService || !this.userPluginRepository) {
            this.logger.debug('Plugin system not wired in this runtime — skipping source pull');
            return result;
        }

        const registered = this.registry.getByCapability(PLUGIN_CAPABILITIES.EVENT_SOURCE);
        for (const reg of registered) {
            if (reg.state !== 'loaded') continue;
            result.sources += 1;
            const pluginId = reg.plugin.id;

            let rows;
            try {
                rows = await this.userPluginRepository.findByPlugin(pluginId);
            } catch (error) {
                result.errors += 1;
                this.logger.warn(
                    `Could not list users for event-source plugin ${pluginId}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                continue;
            }

            for (const row of rows) {
                if (!row.enabled || !row.userId) continue;
                try {
                    const enabled = await this.registry.isPluginEnabledForScope(
                        pluginId,
                        undefined,
                        row.userId,
                    );
                    if (!enabled) continue;
                    const pulled = await this.pullForUser(
                        reg.plugin,
                        pluginId,
                        row.userId,
                        pageBudget,
                        result,
                    );
                    if (pulled) result.pulled += 1;
                } catch (error) {
                    // Isolation contract: one (plugin, user) failure never
                    // stops the rest of the batch.
                    result.errors += 1;
                    const message = `Event-source pull failed for ${pluginId} / user ${row.userId}: ${
                        error instanceof Error ? error.message : String(error)
                    }`;
                    const notConfigured =
                        error instanceof Error && error.name === 'EventSourceNotConfiguredError';
                    if (notConfigured) {
                        this.logger.debug(message);
                    } else {
                        this.logger.warn(message);
                    }
                }
            }
        }

        return result;
    }

    private async pullForUser(
        candidate: IPlugin,
        pluginId: string,
        userId: string,
        pageBudget: number,
        result: PullSourcesResult,
    ): Promise<boolean> {
        const plugin = (await this.materializeForUse(candidate)) as IEventSourcePlugin;
        // Lazy proxies over-report optional methods — tolerate a source
        // that materializes without a real pullEvents (see the lazy-plugin
        // proxy over-reporting gotcha).
        if (typeof plugin.pullEvents !== 'function') return false;

        const settings = await this.settingsService!.getSettings(pluginId, {
            userId,
            includeSecrets: true,
        });

        const row = await this.cursorRepository.findByUserAndPlugin(userId, pluginId);
        const since = row?.watermark ? row.watermark.toISOString() : EPOCH_ISO;
        let cursor = row?.cursor ?? undefined;
        // Resuming an in-flight sweep keeps its original start; a fresh
        // sweep starts now — the watermark advances to this on completion.
        const sweepStartedAt = cursor && row?.sweepStartedAt ? row.sweepStartedAt : new Date();

        for (let page = 0; page < pageBudget; page += 1) {
            const pull = await plugin.pullEvents({
                since,
                ...(cursor ? { cursor } : {}),
                settings,
            });
            result.pages += 1;

            if (pull.events.length > 0) {
                const ingest = await this.eventIngestService.ingest(userId, pull.events);
                result.inserted += ingest.inserted;
                result.duplicates += ingest.duplicates;
                result.rejected += ingest.rejected;
            }

            cursor = pull.nextCursor;
            if (!cursor) break;
        }

        if (cursor) {
            // Budget exhausted mid-sweep — persist the resume point and keep
            // the old watermark so later pages use the same window.
            await this.cursorRepository.save({
                userId,
                pluginId,
                cursor,
                watermark: row?.watermark ?? null,
                sweepStartedAt,
            });
        } else {
            // Sweep complete — advance the watermark to the sweep start.
            await this.cursorRepository.save({
                userId,
                pluginId,
                cursor: null,
                watermark: sweepStartedAt,
                sweepStartedAt: null,
            });
        }
        return true;
    }

    /**
     * Materialize a (possibly lazy) plugin before use — a cold proxy's
     * synchronous surface is empty and its method calls come back
     * promise-wrapped (same rationale as `BaseFacadeService`).
     */
    private async materializeForUse(plugin: IPlugin): Promise<IPlugin> {
        const stub = plugin as unknown as { __materialize?: () => Promise<IPlugin> };
        if (typeof stub.__materialize === 'function') {
            return stub.__materialize();
        }
        return plugin;
    }
}
