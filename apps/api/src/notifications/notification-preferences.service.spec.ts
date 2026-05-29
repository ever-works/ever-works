import { BadRequestException } from '@nestjs/common';

// Stub the agent database barrel so importing the service under test
// doesn't pull in `@ever-works/agent/database`'s source `database.module`
// (which uses the agent-internal `@src/config` alias the api jest config
// can't resolve). We construct the service directly with mocks below, so
// the real repository classes are only needed as DI metadata tokens.
jest.mock('@ever-works/agent/database', () => ({
    NotificationEventTypeRepository: class {},
    UserNotificationSubscriptionRepository: class {},
    UserNotificationPreferenceRepository: class {},
    UserNotificationCategoryMuteRepository: class {},
    NotificationChannelRepository: class {},
}));

import { NotificationPreferencesService } from './notification-preferences.service';

/**
 * Covers the channel-ownership + event-type validation added to
 * `setEventSubscription` (review finding #6) — a caller must not be able
 * to persist unknown event keys or channel ids they don't own.
 */
describe('NotificationPreferencesService.setEventSubscription validation', () => {
    let eventTypes: { findByKey: jest.Mock };
    let subscriptions: { upsert: jest.Mock; findForEvent: jest.Mock };
    let channels: { findByIdForUser: jest.Mock };
    let service: NotificationPreferencesService;

    beforeEach(() => {
        eventTypes = { findByKey: jest.fn().mockResolvedValue({ key: 'ai.credits.depleted' }) };
        subscriptions = {
            upsert: jest.fn().mockResolvedValue(undefined),
            findForEvent: jest.fn().mockResolvedValue({ id: 'sub-1' }),
        };
        channels = { findByIdForUser: jest.fn().mockResolvedValue({ id: 'ch-1' }) };
        service = new NotificationPreferencesService(
            eventTypes as never,
            subscriptions as never,
            {} as never,
            {} as never,
            channels as never,
        );
    });

    it('rejects an unknown event type', async () => {
        eventTypes.findByKey.mockResolvedValue(null);
        await expect(
            service.setEventSubscription('user-1', 'bogus.key', ['in-app']),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(subscriptions.upsert).not.toHaveBeenCalled();
    });

    it('rejects a channel id the user does not own', async () => {
        channels.findByIdForUser.mockResolvedValue(null);
        await expect(
            service.setEventSubscription('user-1', 'ai.credits.depleted', ['ch-foreign']),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(channels.findByIdForUser).toHaveBeenCalledWith('ch-foreign', 'user-1');
        expect(subscriptions.upsert).not.toHaveBeenCalled();
    });

    it('accepts the built-in in-app channel without an ownership lookup', async () => {
        await service.setEventSubscription('user-1', 'ai.credits.depleted', ['in-app']);
        expect(channels.findByIdForUser).not.toHaveBeenCalled();
        expect(subscriptions.upsert).toHaveBeenCalledWith('user-1', 'ai.credits.depleted', [
            'in-app',
        ]);
    });

    it('accepts an owned channel id and dedupes the list', async () => {
        await service.setEventSubscription('user-1', 'ai.credits.depleted', [
            'in-app',
            'ch-1',
            'ch-1',
        ]);
        expect(channels.findByIdForUser).toHaveBeenCalledTimes(1);
        expect(subscriptions.upsert).toHaveBeenCalledWith('user-1', 'ai.credits.depleted', [
            'in-app',
            'ch-1',
        ]);
    });
});
