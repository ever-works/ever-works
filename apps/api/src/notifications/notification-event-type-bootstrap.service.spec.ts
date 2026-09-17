jest.mock('@ever-works/agent/plugins', () => ({ PluginRegistryService: class {} }));
jest.mock('@ever-works/agent/database', () => ({ NotificationEventTypeRepository: class {} }));
jest.mock('@ever-works/agent/notifications', () =>
    jest.requireActual('../../../../packages/agent/src/notifications/core-event-catalogue'),
);

import { NotificationEventTypeBootstrap } from './notification-event-type-bootstrap.service';

/**
 * The registry is seeded from the shared core catalogue on every boot, so
 * every environment — including CI and e2e, where migrations do not run —
 * ends up with the same 24 core rows, and a plugin's own events beside them.
 */
describe('NotificationEventTypeBootstrap', () => {
    function quiet(service: NotificationEventTypeBootstrap) {
        const logger = (service as unknown as { logger: Record<string, unknown> }).logger;
        for (const level of ['log', 'warn', 'debug']) logger[level] = jest.fn();
        return service;
    }

    it('upserts all 24 core events as core rows, idempotently', async () => {
        const rows = new Map<string, Record<string, unknown>>();
        const eventTypes = {
            upsert: jest.fn(async (row: Record<string, unknown>) => {
                rows.set(row.key as string, row);
            }),
        };
        const service = quiet(new NotificationEventTypeBootstrap(undefined, eventTypes as never));

        await service.onApplicationBootstrap();
        await service.onApplicationBootstrap();

        expect(rows.size).toBe(24);
        expect(rows.get('digest_ready')).toMatchObject({
            source: 'core',
            pluginId: null,
            category: 'digest',
            defaultChannels: ['in-app', 'email'],
        });
        expect(rows.get('git_auth_expired')).toMatchObject({
            category: 'integrations',
            urgent: true,
        });
        expect(rows.get('agent_run_finished')).toMatchObject({
            category: 'agents',
            defaultChannels: ['in-app'],
        });
    });

    it('keeps seeding the rest when one upsert fails', async () => {
        const eventTypes = {
            upsert: jest
                .fn()
                .mockRejectedValueOnce(new Error('locked'))
                .mockResolvedValue(undefined),
        };
        const service = quiet(new NotificationEventTypeBootstrap(undefined, eventTypes as never));
        await service.onApplicationBootstrap();
        expect(eventTypes.upsert).toHaveBeenCalledTimes(24);
    });

    it('namespaces plugin-contributed events and leaves their defaults to the manifest', async () => {
        const eventTypes = { upsert: jest.fn().mockResolvedValue(undefined) };
        const registry = {
            getAll: () => [
                {
                    plugin: { id: 'acme-plugin' },
                    manifest: {
                        events: [
                            {
                                key: 'deploy_failed',
                                category: 'generation',
                                title: 'Deploy failed',
                                description: 'A deploy failed.',
                                defaultChannels: ['in-app', 'email'],
                            },
                        ],
                    },
                },
            ],
        };
        const service = quiet(
            new NotificationEventTypeBootstrap(registry as never, eventTypes as never),
        );
        await service.onApplicationBootstrap();
        expect(eventTypes.upsert).toHaveBeenLastCalledWith({
            key: 'acme-plugin:deploy_failed',
            category: 'generation',
            title: 'Deploy failed',
            description: 'A deploy failed.',
            urgent: false,
            defaultChannels: ['in-app', 'email'],
            source: 'plugin',
            pluginId: 'acme-plugin',
        });
    });
});

describe('NotificationEventTypeBootstrap — core events', () => {
    async function seededKeys(): Promise<Map<string, Record<string, unknown>>> {
        const upsert = jest.fn().mockResolvedValue(undefined);
        const bootstrap = new NotificationEventTypeBootstrap(undefined, { upsert } as never);
        await bootstrap.onApplicationBootstrap();
        return new Map(upsert.mock.calls.map(([row]) => [row.key as string, row]));
    }

    it('registers the shared view first-view notice so it can reach a channel', async () => {
        const rows = await seededKeys();
        expect(rows.get('shared_view_first_view')).toEqual({
            key: 'shared_view_first_view',
            category: 'system',
            title: 'Shared view opened',
            description: 'A share link you published was opened for the first time.',
            urgent: false,
            defaultChannels: ['in-app'],
            source: 'core',
            pluginId: null,
        });
    });

    it('still registers the existing core events', async () => {
        const rows = await seededKeys();
        for (const key of ['ai_credits_depleted', 'inbox_question', 'fleet_runner_fallback']) {
            expect(rows.has(key)).toBe(true);
        }
    });
});
