import { BadRequestException, Injectable } from '@nestjs/common';
import {
    NotificationEventTypeRepository,
    UserNotificationSubscriptionRepository,
    UserNotificationPreferenceRepository,
    UserNotificationCategoryMuteRepository,
    NotificationChannelRepository,
} from '@ever-works/agent/database';

/**
 * Channel ids that are not rows in `notification_channels` — always
 * available to every user and therefore exempt from the ownership check.
 */
const BUILT_IN_CHANNEL_IDS = new Set<string>(['in-app']);

/**
 * Security (DoS / storage amplification): cap the number of channel ids a
 * single subscription may carry. Ownership validation below issues one DB
 * query per unique id, so an unbounded list lets a caller force N
 * sequential queries and persist an arbitrarily large array.
 */
const MAX_SUBSCRIPTION_CHANNELS = 20;
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
        private readonly channels: NotificationChannelRepository,
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
        // Reject unknown event types so a typo can't persist a dead
        // subscription row that silently never resolves.
        const eventType = await this.eventTypes.findByKey(eventTypeKey);
        if (!eventType) {
            throw new BadRequestException(`Unknown notification event type: ${eventTypeKey}`);
        }

        // Validate channel ownership: every non-built-in channel id must
        // be a notification_channels row owned by this user. Without this
        // a caller could persist arbitrary (or another user's) channel
        // UUIDs into their subscription row. Send-time scoping already
        // blocks cross-tenant *delivery*, but storing foreign ids is a
        // storage-integrity / info-leak gap. Dedupe first.
        const unique = [...new Set(channelIds)];
        if (unique.length > MAX_SUBSCRIPTION_CHANNELS) {
            throw new BadRequestException(
                `Too many notification channels: maximum ${MAX_SUBSCRIPTION_CHANNELS} allowed per subscription.`,
            );
        }
        for (const id of unique) {
            if (BUILT_IN_CHANNEL_IDS.has(id)) continue;
            const owned = await this.channels.findByIdForUser(id, userId);
            if (!owned) {
                throw new BadRequestException(
                    `Unknown or unauthorized notification channel: ${id}`,
                );
            }
        }

        await this.subscriptions.upsert(userId, eventTypeKey, unique);
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
