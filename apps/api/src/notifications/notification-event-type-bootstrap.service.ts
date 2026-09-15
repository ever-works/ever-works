import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { NotificationEventTypeRepository } from '@ever-works/agent/database';
import { CORE_NOTIFICATION_EVENTS } from '@ever-works/agent/notifications';
import type { PluginNotificationEvent } from '@ever-works/plugin';

/**
 * EW-664 / EW-676 / T21 — at app bootstrap:
 *  1. Seed the core event catalogue (`CORE_NOTIFICATION_EVENTS`, owned by
 *     `@ever-works/agent/notifications` since AW-13) into
 *     `notification_event_types`. The same rows are
 *     also inserted by `SeedNotificationEventTypes1780000010000`, but that
 *     migration only runs when `migrationsRun=true` (prod). In CI / E2E
 *     environments that boot with `synchronize: true`, migrations are
 *     skipped, so we re-seed here. Idempotent via TypeORM
 *     `repo.upsert([...], ['key'])`.
 *  2. Pull plugin-declared notification events out of each registered
 *     plugin's manifest and upsert them under `<pluginId>:<key>` so they
 *     can't collide with core keys.
 *
 * Hard-rule additive: this only inserts new rows or updates existing
 * core / plugin-source rows; never deletes.
 */
@Injectable()
export class NotificationEventTypeBootstrap implements OnApplicationBootstrap {
    private readonly logger = new Logger(NotificationEventTypeBootstrap.name);

    constructor(
        @Optional() private readonly registry?: PluginRegistryService,
        @Optional() private readonly eventTypes?: NotificationEventTypeRepository,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (!this.eventTypes) {
            this.logger.debug(
                'Event-types repository not wired; skipping notification event bootstrap',
            );
            return;
        }

        // 1. Seed core events (idempotent — safe to run alongside the
        //    Postgres migration that inserts the same rows).
        let coreUpserts = 0;
        for (const event of CORE_NOTIFICATION_EVENTS) {
            try {
                await this.eventTypes.upsert({
                    key: event.key,
                    category: event.category,
                    title: event.title,
                    description: event.description,
                    urgent: event.urgent,
                    defaultChannels: [...event.defaultChannels],
                    source: 'core' as const,
                    pluginId: null,
                });
                coreUpserts++;
            } catch (err) {
                this.logger.warn(
                    `Failed to upsert core event ${event.key}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
        if (coreUpserts > 0) {
            this.logger.log(`Upserted ${coreUpserts} core notification event types`);
        }

        // 2. Seed plugin-contributed events (skipped if plugin registry
        //    isn't wired — e.g. CLI / test contexts).
        if (!this.registry) {
            this.logger.debug('Plugin registry not wired; skipping plugin event bootstrap');
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
    const r = registered as {
        manifest?: { events?: unknown };
        plugin?: { manifest?: { events?: unknown } };
    };
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
