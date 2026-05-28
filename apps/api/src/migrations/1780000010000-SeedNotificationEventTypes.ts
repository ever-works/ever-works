import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notifications v2 (EW-664 / EW-676 / T21) — seed the
 * `notification_event_types` registry with the core event keys the
 * platform emits today + the Work / Agent / Mission lifecycle events
 * the v2 producers will start emitting.
 *
 * Idempotent: uses `INSERT … ON CONFLICT (key) DO NOTHING` so re-runs
 * are safe (the entity uses `key` as PK and isn't auto-generated).
 *
 * Plugin-contributed event types land at plugin-load time via the
 * NotificationEventTypeBootstrap service in apps/api — not part of
 * this migration.
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
    // v1 dedup keys — mirror the existing notifyAi*, notifySchedule*,
    // notifyGenerationAccountError, notifyGitAuthExpired producers
    // (packages/agent/src/notifications/notification.service.ts).
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
        category: 'security',
        title: 'Git authentication expired',
        description: 'Your git provider OAuth token has expired. Reconnect to resume git syncs.',
        urgent: true,
        defaultChannels: ['in-app'],
    },
    // Work lifecycle (v2 — fanout-friendly events).
    {
        key: 'work_generation_finished',
        category: 'generation',
        title: 'Work generation finished',
        description: 'A generation run for one of your works just completed successfully.',
        urgent: false,
        defaultChannels: ['in-app'],
    },
    {
        key: 'work_published',
        category: 'generation',
        title: 'Work published',
        description: 'A work was published or deployed to its target environment.',
        urgent: false,
        defaultChannels: ['in-app'],
    },
    // Agent lifecycle.
    {
        key: 'agent_task_completed',
        category: 'system',
        title: 'Agent task completed',
        description: 'An agent finished executing a task assigned to it.',
        urgent: false,
        defaultChannels: ['in-app'],
    },
    {
        key: 'agent_task_failed',
        category: 'system',
        title: 'Agent task failed',
        description: 'An agent task terminated unsuccessfully — see the activity log for context.',
        urgent: false,
        defaultChannels: ['in-app'],
    },
    {
        key: 'agent_inbound_email_received',
        category: 'system',
        title: 'Agent received inbound email',
        description:
            'A new inbound email arrived for one of your agents. Tap to view in the agent inbox.',
        urgent: false,
        defaultChannels: ['in-app'],
    },
    // Mission lifecycle.
    {
        key: 'mission_completed',
        category: 'system',
        title: 'Mission completed',
        description: 'A mission reached its completion condition.',
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

export class SeedNotificationEventTypes1780000010000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // Guard against running against a DB where the table doesn't
        // exist yet (e.g. a partial environment). The earlier
        // AddNotificationsV2Tables1780000000000 migration is the
        // sole creator of this table; if it hasn't run, this seed
        // is a no-op rather than an error.
        if (!(await queryRunner.hasTable('notification_event_types'))) {
            return;
        }

        for (const event of CORE_EVENTS) {
            await queryRunner.query(
                `INSERT INTO notification_event_types
                   (key, category, title, description, urgent, "defaultChannels", source, "pluginId", "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'core', NULL, now(), now())
                 ON CONFLICT (key) DO NOTHING`,
                [
                    event.key,
                    event.category,
                    event.title,
                    event.description,
                    event.urgent,
                    JSON.stringify(event.defaultChannels),
                ],
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('notification_event_types'))) {
            return;
        }
        const keys = CORE_EVENTS.map((e) => e.key);
        await queryRunner.query(
            `DELETE FROM notification_event_types WHERE source = 'core' AND key = ANY($1::text[])`,
            [keys],
        );
    }
}
