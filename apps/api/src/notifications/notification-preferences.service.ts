import { Injectable } from '@nestjs/common';
import {
    NotificationEventTypeRepository,
    UserNotificationSubscriptionRepository,
    UserNotificationPreferenceRepository,
    UserNotificationCategoryMuteRepository,
} from '@ever-works/agent/database';
import type {
    NotificationEventType,
    UserNotificationSubscription,
    UserNotificationPreference,
} from '@ever-works/agent/entities';

export interface PreferencesView {
    readonly subscriptions: UserNotificationSubscription[];
    readonly preference: UserNotificationPreference | null;
    readonly mutes: { category: string; mutedUntil: Date | null }[];
}

/**
 * EW-664 / EW-678 — Subscription preferences service. Owns the
 * read/write surface behind /api/notifications/preferences/*.
 *
 * The resolver that translates (userId, eventType) → channelIds[] lives
 * in the agent package and is consumed by the channel facade as a
 * callback; this service only manages the persisted preferences shapes.
 */
@Injectable()
export class NotificationPreferencesService {
    constructor(
        private readonly eventTypes: NotificationEventTypeRepository,
        private readonly subscriptions: UserNotificationSubscriptionRepository,
        private readonly preferences: UserNotificationPreferenceRepository,
        private readonly mutes: UserNotificationCategoryMuteRepository,
    ) {}

    async listEventTypes(): Promise<NotificationEventType[]> {
        const all = await this.eventTypes.findAll();
        return [...all].sort(
            (a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key),
        );
    }

    async getPreferences(userId: string): Promise<PreferencesView> {
        const [subs, pref, muteRows] = await Promise.all([
            this.subscriptions.findByUser(userId),
            this.preferences.findByUser(userId),
            this.mutes.findActiveByUser(userId),
        ]);
        return {
            subscriptions: subs,
            preference: pref ?? null,
            mutes: muteRows.map((m) => ({
                category: m.category,
                mutedUntil: m.mutedUntil ?? null,
            })),
        };
    }

    async setEventSubscription(
        userId: string,
        eventTypeKey: string,
        channelIds: string[],
    ): Promise<UserNotificationSubscription> {
        await this.subscriptions.upsert(userId, eventTypeKey, channelIds);
        return (await this.subscriptions.findForEvent(
            userId,
            eventTypeKey,
        )) as UserNotificationSubscription;
    }

    async setQuietHours(
        userId: string,
        quietHoursStart: string | null,
        quietHoursEnd: string | null,
        timezone: string | null,
    ): Promise<UserNotificationPreference> {
        return this.preferences.upsert(userId, { quietHoursStart, quietHoursEnd, timezone });
    }

    async muteCategory(
        userId: string,
        category: string,
        mutedUntil: Date | null,
    ): Promise<{ category: string; mutedUntil: Date | null }> {
        await this.mutes.upsert(userId, category, mutedUntil);
        return { category, mutedUntil };
    }

    async unmuteCategory(userId: string, category: string): Promise<void> {
        await this.mutes.delete(userId, category);
    }
}
