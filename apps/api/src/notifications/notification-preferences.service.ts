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
        return this.eventTypes.find({ order: { category: 'ASC', key: 'ASC' } });
    }

    async getPreferences(userId: string): Promise<PreferencesView> {
        const [subs, pref, muteRows] = await Promise.all([
            this.subscriptions.find({ where: { userId } }),
            this.preferences.findOne({ where: { userId } }),
            this.mutes.find({ where: { userId } }),
        ]);
        return {
            subscriptions: subs,
            preference: pref ?? null,
            mutes: muteRows.map((m) => ({ category: m.category, mutedUntil: m.mutedUntil ?? null })),
        };
    }

    async setEventSubscription(
        userId: string,
        eventTypeKey: string,
        channelIds: string[],
    ): Promise<UserNotificationSubscription> {
        const existing = await this.subscriptions.findOne({ where: { userId, eventTypeKey } });
        if (existing) {
            existing.channelIds = channelIds;
            return this.subscriptions.save(existing);
        }
        return this.subscriptions.save(
            this.subscriptions.create({ userId, eventTypeKey, channelIds }),
        );
    }

    async setQuietHours(
        userId: string,
        quietHoursStart: string | null,
        quietHoursEnd: string | null,
        timezone: string | null,
    ): Promise<UserNotificationPreference> {
        const existing = await this.preferences.findOne({ where: { userId } });
        if (existing) {
            existing.quietHoursStart = quietHoursStart;
            existing.quietHoursEnd = quietHoursEnd;
            existing.timezone = timezone;
            return this.preferences.save(existing);
        }
        return this.preferences.save(
            this.preferences.create({ userId, quietHoursStart, quietHoursEnd, timezone }),
        );
    }

    async muteCategory(
        userId: string,
        category: string,
        mutedUntil: Date | null,
    ): Promise<{ category: string; mutedUntil: Date | null }> {
        const existing = await this.mutes.findOne({ where: { userId, category } });
        if (existing) {
            existing.mutedUntil = mutedUntil;
            await this.mutes.save(existing);
        } else {
            await this.mutes.save(this.mutes.create({ userId, category, mutedUntil }));
        }
        return { category, mutedUntil };
    }

    async unmuteCategory(userId: string, category: string): Promise<void> {
        const existing = await this.mutes.findOne({ where: { userId, category } });
        if (existing) await this.mutes.remove(existing);
    }
}
