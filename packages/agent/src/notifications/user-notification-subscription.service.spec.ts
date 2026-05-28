import { Test } from '@nestjs/testing';
import {
    UserNotificationSubscriptionService,
    isWithinQuietHours,
} from './user-notification-subscription.service';
import {
    NotificationEventTypeRepository,
    UserNotificationSubscriptionRepository,
    UserNotificationPreferenceRepository,
    UserNotificationCategoryMuteRepository,
} from '@src/database';

/**
 * EW-677 / T22 — resolver unit tests covering fallback chain,
 * category mute, quiet hours (urgent bypass + non-urgent filter),
 * and the wall-clock helper.
 */
describe('UserNotificationSubscriptionService', () => {
    let service: UserNotificationSubscriptionService;
    let eventTypes: { findByKey: jest.Mock };
    let subscriptions: { findForEvent: jest.Mock };
    let preferences: { findByUser: jest.Mock };
    let mutes: { isMuted: jest.Mock };

    beforeEach(async () => {
        eventTypes = { findByKey: jest.fn() };
        subscriptions = { findForEvent: jest.fn() };
        preferences = { findByUser: jest.fn() };
        mutes = { isMuted: jest.fn().mockResolvedValue(false) };
        const moduleRef = await Test.createTestingModule({
            providers: [
                UserNotificationSubscriptionService,
                { provide: NotificationEventTypeRepository, useValue: eventTypes },
                { provide: UserNotificationSubscriptionRepository, useValue: subscriptions },
                { provide: UserNotificationPreferenceRepository, useValue: preferences },
                { provide: UserNotificationCategoryMuteRepository, useValue: mutes },
            ],
        }).compile();
        service = moduleRef.get(UserNotificationSubscriptionService);
    });

    it('returns in-app only for unknown event types', async () => {
        eventTypes.findByKey.mockResolvedValue(null);
        await expect(service.resolveChannels('u', 'mystery')).resolves.toEqual(['in-app']);
    });

    it('falls back to event default channels when user has no subscription', async () => {
        eventTypes.findByKey.mockResolvedValue({
            key: 'ai_credits_depleted',
            category: 'ai_credits',
            urgent: true,
            defaultChannels: ['in-app', 'email'],
        });
        subscriptions.findForEvent.mockResolvedValue(null);
        preferences.findByUser.mockResolvedValue(null);
        mutes.isMuted.mockResolvedValue(false);
        await expect(service.resolveChannels('u', 'ai_credits_depleted')).resolves.toEqual([
            'in-app',
            'email',
        ]);
    });

    it('honours per-user subscription channel selection', async () => {
        eventTypes.findByKey.mockResolvedValue({
            key: 'work_generation_finished',
            category: 'generation',
            urgent: false,
            defaultChannels: ['in-app'],
        });
        subscriptions.findForEvent.mockResolvedValue({ channelIds: ['in-app', 'channel-1'] });
        preferences.findByUser.mockResolvedValue(null);
        mutes.isMuted.mockResolvedValue(false);
        await expect(service.resolveChannels('u', 'work_generation_finished')).resolves.toEqual([
            'in-app',
            'channel-1',
        ]);
    });

    it('drops non-in-app channels when category is muted', async () => {
        eventTypes.findByKey.mockResolvedValue({
            key: 'work_generation_finished',
            category: 'generation',
            urgent: false,
            defaultChannels: ['in-app', 'email'],
        });
        subscriptions.findForEvent.mockResolvedValue({ channelIds: ['in-app', 'channel-1'] });
        mutes.isMuted.mockResolvedValue(true);
        preferences.findByUser.mockResolvedValue(null);
        await expect(service.resolveChannels('u', 'work_generation_finished')).resolves.toEqual([
            'in-app',
        ]);
    });

    it('expired category mute does NOT filter channels', async () => {
        eventTypes.findByKey.mockResolvedValue({
            key: 'work_generation_finished',
            category: 'generation',
            urgent: false,
            defaultChannels: ['in-app', 'email'],
        });
        subscriptions.findForEvent.mockResolvedValue({ channelIds: ['in-app', 'channel-1'] });
        // isMuted encapsulates the mutedUntil-expiry check; an expired
        // mute reports false.
        mutes.isMuted.mockResolvedValue(false);
        preferences.findByUser.mockResolvedValue(null);
        await expect(service.resolveChannels('u', 'work_generation_finished')).resolves.toEqual([
            'in-app',
            'channel-1',
        ]);
    });

    it('urgent events bypass quiet hours', async () => {
        eventTypes.findByKey.mockResolvedValue({
            key: 'ai_credits_depleted',
            category: 'ai_credits',
            urgent: true,
            defaultChannels: ['in-app'],
        });
        subscriptions.findForEvent.mockResolvedValue({ channelIds: ['in-app', 'channel-1'] });
        mutes.isMuted.mockResolvedValue(false);
        // Quiet hours always-on for the test
        preferences.findByUser.mockResolvedValue({
            quietHoursStart: '00:00:00',
            quietHoursEnd: '23:59:59',
            timezone: 'UTC',
        });
        await expect(service.resolveChannels('u', 'ai_credits_depleted')).resolves.toEqual([
            'in-app',
            'channel-1',
        ]);
    });

    it('non-urgent events drop non-in-app channels during quiet hours', async () => {
        eventTypes.findByKey.mockResolvedValue({
            key: 'work_generation_finished',
            category: 'generation',
            urgent: false,
            defaultChannels: ['in-app'],
        });
        subscriptions.findForEvent.mockResolvedValue({ channelIds: ['in-app', 'channel-1'] });
        mutes.isMuted.mockResolvedValue(false);
        preferences.findByUser.mockResolvedValue({
            quietHoursStart: '00:00:00',
            quietHoursEnd: '23:59:59',
            timezone: 'UTC',
        });
        await expect(service.resolveChannels('u', 'work_generation_finished')).resolves.toEqual([
            'in-app',
        ]);
    });

    it('resolvePlan DEFERS non-in-app channels during quiet hours (does not drop them)', async () => {
        eventTypes.findByKey.mockResolvedValue({
            key: 'work_generation_finished',
            category: 'generation',
            urgent: false,
            defaultChannels: ['in-app'],
        });
        subscriptions.findForEvent.mockResolvedValue({ channelIds: ['in-app', 'channel-1'] });
        mutes.isMuted.mockResolvedValue(false);
        preferences.findByUser.mockResolvedValue({
            quietHoursStart: '00:00:00',
            quietHoursEnd: '23:59:59',
            timezone: 'UTC',
        });

        const plan = await service.resolvePlan('u', 'work_generation_finished');
        expect(plan.immediate).toEqual(['in-app']);
        expect(plan.deferred).toEqual(['channel-1']);
        expect(typeof plan.deferUntil).toBe('string');
        expect(new Date(plan.deferUntil!).getTime()).toBeGreaterThan(Date.now());
    });

    it('resolvePlan leaves deferred empty outside quiet hours', async () => {
        eventTypes.findByKey.mockResolvedValue({
            key: 'work_generation_finished',
            category: 'generation',
            urgent: false,
            defaultChannels: ['in-app'],
        });
        subscriptions.findForEvent.mockResolvedValue({ channelIds: ['in-app', 'channel-1'] });
        mutes.isMuted.mockResolvedValue(false);
        preferences.findByUser.mockResolvedValue(null); // no quiet hours configured
        const plan = await service.resolvePlan('u', 'work_generation_finished');
        expect(plan.immediate).toEqual(['in-app', 'channel-1']);
        expect(plan.deferred).toEqual([]);
        expect(plan.deferUntil).toBeUndefined();
    });
});

describe('isWithinQuietHours', () => {
    it('same-day window: returns true when now is inside', () => {
        const now = new Date('2026-05-28T12:30:00.000Z');
        expect(isWithinQuietHours(now, '12:00:00', '14:00:00', 'UTC')).toBe(true);
    });

    it('same-day window: returns false when now is outside', () => {
        const now = new Date('2026-05-28T15:00:00.000Z');
        expect(isWithinQuietHours(now, '12:00:00', '14:00:00', 'UTC')).toBe(false);
    });

    it('crosses-midnight window: returns true for the late-night side', () => {
        const now = new Date('2026-05-28T23:30:00.000Z');
        expect(isWithinQuietHours(now, '22:00:00', '07:00:00', 'UTC')).toBe(true);
    });

    it('crosses-midnight window: returns true for the early-morning side', () => {
        const now = new Date('2026-05-28T06:00:00.000Z');
        expect(isWithinQuietHours(now, '22:00:00', '07:00:00', 'UTC')).toBe(true);
    });

    it('crosses-midnight window: returns false during the day', () => {
        const now = new Date('2026-05-28T12:00:00.000Z');
        expect(isWithinQuietHours(now, '22:00:00', '07:00:00', 'UTC')).toBe(false);
    });

    it('returns false on garbage inputs (over-deliver rather than swallow)', () => {
        const now = new Date('2026-05-28T12:00:00.000Z');
        expect(isWithinQuietHours(now, 'not-a-time', 'either', 'UTC')).toBe(false);
    });
});
