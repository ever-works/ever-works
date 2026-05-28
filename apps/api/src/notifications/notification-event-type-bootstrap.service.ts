import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { NotificationEventTypeRepository } from '@ever-works/agent/database';
import type { PluginNotificationEvent } from '@ever-works/plugin';

/**
 * EW-664 / EW-676 / T21 — pulls plugin-declared notification events
 * out of each registered plugin's manifest at app bootstrap and
 * upserts them into `notification_event_types`. The keys are namespaced
 * as `<pluginId>:<key>` so plugins can't collide with the core event
 * keys (`ai_credits_depleted`, `work_generation_finished`, …) seeded
 * by `SeedNotificationEventTypes1780000010000`.
 *
 * Idempotent: re-runs on every boot, repeated upserts only touch the
 * rows whose title / description / urgent / defaultChannels actually
 * changed.
 *
 * Hard-rule additive: this only inserts new rows or updates plugin-
 * source rows; core rows seeded by the migration are left alone.
 */
@Injectable()
export class NotificationEventTypeBootstrap implements OnApplicationBootstrap {
    private readonly logger = new Logger(NotificationEventTypeBootstrap.name);

    constructor(
        @Optional() private readonly registry?: PluginRegistryService,
        @Optional() private readonly eventTypes?: NotificationEventTypeRepository,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (!this.registry || !this.eventTypes) {
            this.logger.debug(
                'Plugin registry or event-types repository not wired; skipping plugin event bootstrap',
            );
            return;
        }

        const plugins = this.registry.getAll();
        let upserts = 0;

        for (const registered of plugins) {
            const events = readManifestEvents(registered);
            if (!events.length) continue;
            for (const event of events) {
                const key = `${registered.plugin.id}:${event.key}`;
                try {
                    await this.eventTypes.upsert({
                        key,
                        category: event.category,
                        title: event.title,
                        description: event.description,
                        urgent: event.urgent ?? false,
                        defaultChannels: [...(event.defaultChannels ?? ['in-app'])],
                        source: 'plugin' as const,
                        pluginId: registered.plugin.id,
                    });
                    upserts++;
                } catch (err) {
                    this.logger.warn(
                        `Failed to upsert plugin event ${key}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            }
        }

        if (upserts > 0) {
            this.logger.log(`Upserted ${upserts} plugin-contributed notification event types`);
        }
    }
}

/**
 * Defensive manifest reader — the `events` field is a v2 addition so
 * plenty of plugin builds in the wild won't carry it. Treat absence
 * as `[]` and tolerate the shape being slightly wrong (we run during
 * bootstrap; we must never throw).
 */
function readManifestEvents(registered: unknown): readonly PluginNotificationEvent[] {
    if (!registered || typeof registered !== 'object') return [];
    const r = registered as { manifest?: { events?: unknown }; plugin?: { manifest?: { events?: unknown } } };
    const raw = r.manifest?.events ?? r.plugin?.manifest?.events;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is PluginNotificationEvent => {
        return (
            entry !== null &&
            typeof entry === 'object' &&
            typeof (entry as PluginNotificationEvent).key === 'string' &&
            typeof (entry as PluginNotificationEvent).category === 'string' &&
            typeof (entry as PluginNotificationEvent).title === 'string' &&
            typeof (entry as PluginNotificationEvent).description === 'string'
        );
    });
}
