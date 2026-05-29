import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { NotificationEventTypeRepository } from '@ever-works/agent/database';
import type { PluginNotificationEvent } from '@ever-works/plugin';

/**
 * Core event registry — kept in sync with the rows
 * `SeedNotificationEventTypes1780000010000` migration inserts on Postgres.
 * Bootstrapped here too so SQLite / CI environments that boot with
 * `synchronize: true` (migrationsRun is false in that mode) still end up
 * with the core registry populated. Idempotent via TypeORM `repo.upsert`.
 */
interface CoreEventRow {
    readonly key: string;
    readonly category: string;
    readonly title: string;
    readonly description: string;
    readonly urgent: boolean;
    readonly defaultChannels: readonly string[];
}

const CORE_EVENTS: readonly CoreEventRow[] = [
    {
        key: 'ai_credits_depleted',
        category: 'ai_credits',
        title: 'AI credits depleted',
        description:
            'Your configured AI provider has run out of credits. Top up to resume generation.',
        urgent: true,
        defaultChannels: ['in-app'],
    },
    {
        key: 'ai_provider_error',
        category: 'ai_credits',
        title: 'AI provider error',
        description: 'Recurring error from one of your enabled AI providers.',
        urgent: false,
        defaultChannels: ['in-app'],
    },
    {
        key: 'generation_error',
        category: 'generation',
        title: 'Generation failed',
        description: 'A scheduled or manual content generation run failed for one of your works.',
        urgent: false,
        defaultChannels: ['in-app'],
    },
    {
        key: 'schedule_paused',
        category: 'generation',
        title: 'Schedule paused',
        description:
            'Scheduled updates for a work have been paused — likely due to repeated errors or an exhausted credit pool.',
        urgent: false,
        defaultChannels: ['in-app'],
    },
    {
        key: 'git_auth_expired',
        category: 'integrations',
        title: 'Git authentication expired',
        description: 'Your Git provider authentication has expired and needs to be refreshed.',
        urgent: true,
        defaultChannels: ['in-app'],
    },
    {
        key: 'work_generation_finished',
        category: 'generation',
        title: 'Work generation finished',
        description: 'A scheduled or manual content generation run for a work finished.',
        urgent: false,
        defaultChannels: ['in-app'],
    },
    {
        key: 'agent_run_finished',
        category: 'agents',
        title: 'Agent run finished',
        description: 'An autonomous agent run completed.',
        urgent: false,
        defaultChannels: ['in-app'],
    },
    {
        key: 'mission_blocked',
        category: 'system',
        title: 'Mission blocked',
        description: 'A mission can no longer progress — review its blocking task to unblock.',
        urgent: false,
        defaultChannels: ['in-app'],
    },
];

/**
 * EW-664 / EW-676 / T21 — at app bootstrap:
 *  1. Seed CORE_EVENTS into `notification_event_types`. The same rows are
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
        for (const event of CORE_EVENTS) {
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
