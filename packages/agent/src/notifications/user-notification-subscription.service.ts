import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    NotificationEventTypeRepository,
    UserNotificationSubscriptionRepository,
    UserNotificationPreferenceRepository,
    UserNotificationCategoryMuteRepository,
} from '@src/database';

/**
 * Notifications v2 (EW-664 / EW-677 / T22).
 *
 * Resolves the channel list for a given `(userId, eventTypeKey)` pair
 * with full fallback semantics:
 *
 * 1. Per-user subscription row, if any.
 * 2. Event-type default channels.
 * 3. `['in-app']` as the ultimate fallback (matches v1 behaviour).
 *
 * Then applies two filters:
 *
 * 4. Category mute: when `(userId, eventType.category)` has an active
 *    mute, drop all non-`in-app` channels (in-app still records the
 *    notification for retrospective viewing).
 * 5. Quiet hours: when `now ∈ [quietHoursStart, quietHoursEnd]` in
 *    the user's configured timezone AND `eventType.urgent === false`,
 *    drop all non-`in-app` channels.
 *
 * **Deferred from v1**:
 * - Organisation defaults fallback (between steps 1 and 2). The
 *   `OrganizationNotificationDefaultRepository` exists; wiring the
 *   user→organization lookup is a follow-up.
 * - BullMQ delayed-delivery: quiet-hours-caught non-urgent events
 *   currently get dropped to in-app only. v2 will queue them for
 *   delivery at end-of-quiet-window. The `deferredAt` / `dueAt`
 *   bookkeeping needs an additional table that's out of scope for
 *   the resolver alone.
 *
 * Hard-rule additive: this service is consumed by the api layer's
 * NotificationFanoutListener (replacing its thin stub resolver). The
 * v1 NotificationService.create path remains untouched.
 */
/**
 * Outcome of {@link UserNotificationSubscriptionService.resolvePlan}.
 * `immediate` channels deliver now; `deferred` channels are held until
 * `deferUntil` (end of the user's quiet-hours window, ISO-8601).
 */
export interface ResolvedChannelPlan {
    immediate: string[];
    deferred: string[];
    deferUntil?: string;
}

@Injectable()
export class UserNotificationSubscriptionService {
    private readonly logger = new Logger(UserNotificationSubscriptionService.name);

    constructor(
        private readonly eventTypes: NotificationEventTypeRepository,
        private readonly subscriptions: UserNotificationSubscriptionRepository,
        @Optional() private readonly preferences?: UserNotificationPreferenceRepository,
        @Optional() private readonly mutes?: UserNotificationCategoryMuteRepository,
    ) {}

    /**
     * Returns the channel ids that should deliver `eventTypeKey` to
     * `userId` right now. Always includes `'in-app'` unless a category
     * mute explicitly demands silence (and even then in-app stays so
     * the user can review).
     */
    async resolveChannels(userId: string, eventTypeKey: string): Promise<string[]> {
        const plan = await this.resolvePlan(userId, eventTypeKey);
        return plan.immediate;
    }

    /**
     * Deferral-aware resolution. `immediate` always carries `'in-app'`
     * (unless muted). For a non-urgent event inside the user's quiet
     * hours, non-in-app channels move to `deferred` with `deferUntil`
     * set to the end-of-window instant (ISO) — the producer enqueues
     * them on the Trigger.dev delivery task with that `delay` instead of
     * dropping them. Muted categories are silenced (dropped, NOT
     * deferred) — a mute means "don't tell me", not "tell me later".
     */
    async resolvePlan(userId: string, eventTypeKey: string): Promise<ResolvedChannelPlan> {
        const eventType = await this.eventTypes.findByKey(eventTypeKey);
        if (!eventType) {
            this.logger.debug(`Unknown event type ${eventTypeKey}; defaulting to in-app only`);
            return { immediate: ['in-app'], deferred: [] };
        }

        let channels = await this.loadInitialChannels(
            userId,
            eventTypeKey,
            eventType.defaultChannels,
        );

        // Category mute (drops non-in-app). `isMuted` already accounts
        // for mutedUntil expiry semantics.
        if (this.mutes) {
            const muted = await this.mutes.isMuted(userId, eventType.category);
            if (muted) {
                channels = channels.filter((c) => c === 'in-app');
            }
        }

        // Quiet hours: defer (not drop) non-in-app channels for non-urgent
        // events so they fire at end-of-window.
        if (this.preferences && !eventType.urgent && channels.some((c) => c !== 'in-app')) {
            const pref = await this.preferences.findByUser(userId);
            if (pref?.quietHoursStart && pref?.quietHoursEnd) {
                const now = new Date();
                const timeZone = pref.timezone ?? 'UTC';
                if (isWithinQuietHours(now, pref.quietHoursStart, pref.quietHoursEnd, timeZone)) {
                    const deferred = channels.filter((c) => c !== 'in-app');
                    const immediate = channels.filter((c) => c === 'in-app');
                    return {
                        immediate,
                        deferred,
                        deferUntil: quietHoursEndIso(now, pref.quietHoursEnd, timeZone),
                    };
                }
            }
        }

        return { immediate: channels, deferred: [] };
    }

    private async loadInitialChannels(
        userId: string,
        eventTypeKey: string,
        eventDefaults: string[] | undefined,
    ): Promise<string[]> {
        const sub = await this.subscriptions.findForEvent(userId, eventTypeKey);
        if (sub?.channelIds && sub.channelIds.length > 0) {
            return [...sub.channelIds];
        }
        if (eventDefaults && eventDefaults.length > 0) {
            return [...eventDefaults];
        }
        return ['in-app'];
    }
}

/**
 * Lightweight wall-clock check for "is `now` inside the quiet-hours
 * window". The window may cross midnight (start > end means the
 * "night" range 22:00 → 07:00 of the next day).
 *
 * Uses `Intl.DateTimeFormat` to convert `now` into the user's
 * timezone wall-clock. Returns false on parse errors — we'd rather
 * over-deliver than silently swallow a notification.
 */
export function isWithinQuietHours(
    now: Date,
    quietStart: string,
    quietEnd: string,
    timeZone: string,
): boolean {
    try {
        const formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        const parts = formatter.formatToParts(now);
        const get = (type: Intl.DateTimeFormatPartTypes) =>
            parts.find((p) => p.type === type)?.value ?? '00';
        const wall = `${get('hour')}:${get('minute')}:${get('second')}`;

        const startMinutes = toMinutes(quietStart);
        const endMinutes = toMinutes(quietEnd);
        const nowMinutes = toMinutes(wall);
        if (startMinutes === endMinutes) return false;

        if (startMinutes < endMinutes) {
            // Same-day window — e.g. 12:00 → 14:00.
            return nowMinutes >= startMinutes && nowMinutes < endMinutes;
        }
        // Crosses midnight — e.g. 22:00 → 07:00.
        return nowMinutes >= startMinutes || nowMinutes < endMinutes;
    } catch {
        return false;
    }
}

function toMinutes(hms: string): number {
    const [h, m, s] = hms.split(':').map((n) => Number.parseInt(n, 10) || 0);
    // Hour 24 (midnight as end-of-day) is allowed in some libs.
    return (h % 24) * 60 + (m % 60) + (s >= 30 ? 1 : 0);
}

/**
 * The next instant (ISO-8601) at which the user's quiet-hours window
 * ends, computed from `now` + the wall-clock minutes until `quietEnd`
 * in the user's timezone. Used as the Trigger.dev `delay` target for
 * deferred channels. Assumes the caller has already confirmed `now` is
 * within the window. DST transitions inside the window may shift the
 * fire time by ±1h — acceptable for a "fire after quiet hours" signal.
 */
export function quietHoursEndIso(now: Date, quietEnd: string, timeZone: string): string {
    let delayMinutes: number;
    try {
        const formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        const parts = formatter.formatToParts(now);
        const get = (type: Intl.DateTimeFormatPartTypes) =>
            parts.find((p) => p.type === type)?.value ?? '00';
        const nowMinutes = toMinutes(`${get('hour')}:${get('minute')}:${get('second')}`);
        const endMinutes = toMinutes(quietEnd);
        const diff = (((endMinutes - nowMinutes) % 1440) + 1440) % 1440;
        // diff === 0 means now is exactly at the boundary — push a full
        // day rather than firing instantly (shouldn't happen for an
        // in-window check, but keeps the delay strictly positive).
        delayMinutes = diff === 0 ? 1440 : diff;
    } catch {
        // Fall back to a 1h defer so a bad timezone never drops the send.
        delayMinutes = 60;
    }
    return new Date(now.getTime() + delayMinutes * 60_000).toISOString();
}
