import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    NotificationChannelRepository,
    NotificationEventTypeRepository,
    UserNotificationCategoryMuteRepository,
    UserNotificationPreferenceRepository,
    UserNotificationSubscriptionRepository,
    UserRepository,
} from '@ever-works/agent/database';
import type { NotificationChannel, NotificationEventType } from '@ever-works/agent/entities';
import {
    CORE_NOTIFICATION_EVENTS,
    UserNotificationSubscriptionService,
    deriveNotificationMatrixGroup,
    effectiveNotificationTargets,
    findCoreNotificationEvent,
    resolveMuteCategory,
    type StoredNotificationChoice,
} from '@ever-works/agent/notifications';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import {
    NOTIFICATION_MATRIX_GROUPS,
    NOTIFICATION_MATRIX_MAX_COLUMNS,
    NOTIFICATION_MATRIX_MAX_TARGETS,
    NOTIFICATION_TARGET_EMAIL,
    NOTIFICATION_TARGET_IN_APP,
    type NotificationEmailAvailability,
    type NotificationMatrixColumnDto,
    type NotificationMatrixDto,
    type NotificationMatrixEventDto,
    type NotificationMatrixResetResultDto,
} from '@ever-works/contracts';
import { NotificationEmailSenderService } from './notification-email-sender.service';

const CORE_ORDER = new Map(CORE_NOTIFICATION_EVENTS.map((event, index) => [event.key, index]));
const GROUP_ORDER = new Map(NOTIFICATION_MATRIX_GROUPS.map((group, index) => [group, index]));

/**
 * Attention controls (AW-13) — composes Settings -> Notifications in one read
 * and resets it in one write.
 *
 * Built from the registry at request time, so an event a newly installed
 * plugin contributes appears without a deploy, and from the user's own
 * channel rows, so no chat provider is named here. Every read and write is
 * scoped to the calling user.
 *
 * Owns no routing rule of its own: the fallback chain (the user's choice,
 * else the organisation default, else the event default) is the resolver's,
 * and the group of each row is the catalogue's.
 */
@Injectable()
export class NotificationMatrixService {
    private readonly logger = new Logger(NotificationMatrixService.name);

    constructor(
        private readonly eventTypes: NotificationEventTypeRepository,
        private readonly subscriptions: UserNotificationSubscriptionRepository,
        private readonly preferences: UserNotificationPreferenceRepository,
        private readonly mutes: UserNotificationCategoryMuteRepository,
        private readonly channels: NotificationChannelRepository,
        private readonly users: UserRepository,
        @Optional() private readonly resolver?: UserNotificationSubscriptionService,
        @Optional() private readonly pluginRegistry?: PluginRegistryService,
        @Optional() private readonly emailSender?: NotificationEmailSenderService,
    ) {}

    async getMatrix(userId: string): Promise<NotificationMatrixDto> {
        const [registry, subs, preference, activeMutes, channelRows, user, orgDefaults] =
            await Promise.all([
                this.eventTypes.findAll(),
                this.subscriptions.findByUser(userId),
                this.preferences.findByUser(userId),
                this.mutes.findActiveByUser(userId),
                this.channels.findAllByUser(userId),
                this.users.findById(userId),
                this.loadOrgDefaults(userId),
            ]);

        const subsByKey = new Map<string, StoredNotificationChoice>(
            subs.map((s) => [s.eventTypeKey, { channelIds: s.channelIds ?? [], origin: s.origin }]),
        );
        const mutesByCategory = new Map(
            activeMutes.map((m) => [m.category, m.mutedUntil ?? null] as const),
        );

        const events = registry
            .map((row) => this.toEventDto(row, subsByKey, orgDefaults, mutesByCategory))
            .sort(compareEvents);

        const availability: NotificationEmailAvailability = this.emailSender
            ? this.emailSender.availabilityFor(user)
            : 'not-configured';

        return {
            columns: [...builtInColumns(availability), ...this.channelColumns(channelRows)],
            events,
            quietHours: {
                start: preference?.quietHoursStart ?? null,
                end: preference?.quietHoursEnd ?? null,
                timezone: preference?.timezone ?? null,
                urgentBypassesQuietHours: preference?.urgentBypassesQuietHours === true,
            },
            mutes: activeMutes.map((m) => ({
                category: m.category,
                mutedUntil: toIso(m.mutedUntil),
            })),
            email: {
                availability,
                profileBudgetAlerts: user?.emailBudgetAlerts !== false,
            },
            budgets: [],
            limits: {
                maxTargets: NOTIFICATION_MATRIX_MAX_TARGETS,
                maxColumns: NOTIFICATION_MATRIX_MAX_COLUMNS,
            },
        };
    }

    /**
     * Remove the caller's stored choices (for `eventKeys`, or all of them) so
     * those rows follow their shipped defaults again. One write, whatever the
     * number of rows. A key the caller has no choice for changes nothing.
     */
    async reset(
        userId: string,
        eventKeys?: readonly string[],
    ): Promise<NotificationMatrixResetResultDto> {
        const changed = await this.subscriptions.deleteForUser(userId, eventKeys);
        return { changed };
    }

    private toEventDto(
        row: NotificationEventType,
        subsByKey: ReadonlyMap<string, StoredNotificationChoice>,
        orgDefaults: Record<string, string[]> | undefined,
        mutesByCategory: ReadonlyMap<string, Date | null>,
    ): NotificationMatrixEventDto {
        const core = row.source === 'core' ? findCoreNotificationEvent(row.key) : undefined;
        const alternativeSurface = core?.alternativeSurface ?? null;
        const defaultTargets = [...(row.defaultChannels ?? [])];
        const stored = subsByKey.get(row.key);
        // The resolver's rules, not a copy of them (notification-choice.ts):
        // a choice saved in the matrix shows exactly as saved; any other
        // stored row (before AW-13, or through the API / chat assistant)
        // shows its non-empty list or, when empty, the defaults; and in-app
        // shows on whenever the notification still reaches the bell.
        const selectedTargets = effectiveNotificationTargets(
            stored,
            orgDefaults?.[row.key],
            defaultTargets,
        );
        const muteCategory = resolveMuteCategory(row.category);
        const muted = muteCategory !== null && mutesByCategory.has(muteCategory);
        const mutedUntil = muted
            ? toIso(mutesByCategory.get(muteCategory as string) ?? null)
            : null;

        return {
            key: row.key,
            group: deriveNotificationMatrixGroup({
                urgent: row.urgent,
                category: row.category,
                alternativeSurface,
            }),
            category: row.category,
            muteCategory,
            title: row.title,
            description: row.description,
            alternativeSurface,
            urgent: row.urgent,
            source: row.source,
            pluginId: row.pluginId ?? null,
            inAppLocked: core?.persistent === true,
            emailGovernedByProfile: core?.emailGovernedByProfile === true,
            defaultTargets,
            selectedTargets,
            explicit: stored !== undefined,
            mutedUntil,
            muted,
        };
    }

    private channelColumns(rows: readonly NotificationChannel[]): NotificationMatrixColumnDto[] {
        return [...rows]
            .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt))
            .map((channel) => ({
                id: channel.id,
                kind: 'channel' as const,
                label: channel.name,
                providerLabel: this.providerLabel(channel.pluginId),
                pluginId: channel.pluginId,
                disabled: Boolean(channel.disabledAt),
                disabledReason: channel.disabledAt ? ('channel-disabled' as const) : null,
                createdAt: toIso(channel.createdAt),
            }));
    }

    /** The delivering plugin's own display name, from the plugin registry. */
    private providerLabel(pluginId: string): string | null {
        try {
            return this.pluginRegistry?.get(pluginId)?.plugin?.name ?? null;
        } catch {
            return null;
        }
    }

    private async loadOrgDefaults(userId: string): Promise<Record<string, string[]> | undefined> {
        if (!this.resolver) return undefined;
        try {
            return await this.resolver.loadOrgDefaultMap(userId);
        } catch (err) {
            this.logger.debug(`Organisation defaults unavailable for the matrix: ${String(err)}`);
            return undefined;
        }
    }
}

function builtInColumns(
    availability: NotificationEmailAvailability,
): NotificationMatrixColumnDto[] {
    return [
        {
            id: NOTIFICATION_TARGET_IN_APP,
            kind: 'in-app',
            label: '',
            providerLabel: null,
            pluginId: null,
            disabled: false,
            disabledReason: null,
            createdAt: null,
        },
        {
            id: NOTIFICATION_TARGET_EMAIL,
            kind: 'email',
            label: '',
            providerLabel: null,
            pluginId: null,
            disabled: availability !== 'available',
            disabledReason:
                availability === 'not-configured'
                    ? 'email-not-configured'
                    : availability === 'unverified'
                      ? 'email-unverified'
                      : null,
            createdAt: null,
        },
    ];
}

function compareEvents(a: NotificationMatrixEventDto, b: NotificationMatrixEventDto): number {
    const byGroup = (GROUP_ORDER.get(a.group) ?? 0) - (GROUP_ORDER.get(b.group) ?? 0);
    if (byGroup !== 0) return byGroup;
    const ca = CORE_ORDER.get(a.key);
    const cb = CORE_ORDER.get(b.key);
    if (ca !== undefined && cb !== undefined) return ca - cb;
    if (ca !== undefined) return -1;
    if (cb !== undefined) return 1;
    return a.key.localeCompare(b.key);
}

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toTime(value: Date | string | null | undefined): number {
    if (!value) return 0;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
