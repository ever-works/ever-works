jest.mock('@ever-works/agent/database', () => ({
    NotificationEventTypeRepository: class NotificationEventTypeRepository {},
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginRegistryService: class PluginRegistryService {},
}));

import { NotificationEventTypeBootstrap } from './notification-event-type-bootstrap.service';

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
