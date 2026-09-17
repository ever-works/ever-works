import type {
    NotificationAlternativeSurface,
    NotificationMatrixGroup,
} from '@ever-works/contracts';
import { NotificationCategory } from '../entities/notification.types';

/**
 * Attention controls (AW-13) — the core notification event catalogue.
 *
 * One row per event key a first-party producer emits. The API upserts these
 * rows into `notification_event_types` on every boot, so this list is the
 * single source of what the platform can tell a user about, how urgent it
 * is, and where it goes when the user has not chosen for themselves.
 *
 * Data only: nothing in this file delivers anything.
 *
 * ## The defaults rule
 *
 * - Every row ships **in-app on**. The in-app record is what reaches people
 *   today, and a new default may add a way to be told, never remove one.
 * - Rows only the owner can unblock (`urgent`) also ship **email on**.
 * - Rows whose email is already sent by a dedicated producer governed by a
 *   profile setting (`emailGovernedByProfile`) do NOT add email here, so the
 *   owner never receives the same alert twice.
 *
 * `event-registry-coverage.spec.ts` fails when a producer in
 * `notification.service.ts` emits a key that has no row here.
 */
export interface CoreNotificationEvent {
    readonly key: string;
    /** Stored on the registry row. See {@link resolveMuteCategory} for the mute target. */
    readonly category: string;
    readonly title: string;
    readonly description: string;
    /**
     * `true` → only the owner can unblock it. An urgent event's external
     * deliveries come through quiet hours, unless
     * {@link CoreNotificationEvent.quietHoursBypassNeedsOptIn} is set.
     */
    readonly urgent: boolean;
    readonly defaultChannels: readonly string[];
    /** The producer writes persistent rows: they always show in the app. */
    readonly persistent?: boolean;
    /** Set on Routine rows: where the information is already visible. */
    readonly alternativeSurface?: NotificationAlternativeSurface;
    /** Email is sent by a dedicated producer and governed by a profile setting. */
    readonly emailGovernedByProfile?: boolean;
    /**
     * Set on urgent rows whose external deliveries did NOT come through quiet
     * hours before AW-13 — either the row was not urgent then, or it was not
     * registered at all. They keep waiting until the person's quiet hours end
     * unless that person opted in to let every urgent event through
     * (`user_notification_preferences.urgentBypassesQuietHours`). AW-13 never
     * widens what breaks through a quiet-hours window a person chose.
     */
    readonly quietHoursBypassNeedsOptIn?: boolean;
}

const IN_APP = ['in-app'] as const;
const IN_APP_AND_EMAIL = ['in-app', 'email'] as const;

export const CORE_NOTIFICATION_EVENTS: readonly CoreNotificationEvent[] = [
    {
        key: 'ai_credits_depleted',
        category: 'ai_credits',
        title: 'AI credits depleted',
        description:
            'Your configured AI provider has run out of credits. Top up to resume generation.',
        urgent: true,
        defaultChannels: IN_APP_AND_EMAIL,
        persistent: true,
    },
    {
        key: 'ai_provider_error',
        category: 'ai_credits',
        title: 'AI provider error',
        description: 'Recurring error from one of your enabled AI providers.',
        urgent: false,
        defaultChannels: IN_APP,
    },
    {
        key: 'generation_error',
        category: 'generation',
        title: 'Generation failed',
        description: 'A scheduled or manual content generation run failed for one of your works.',
        urgent: false,
        defaultChannels: IN_APP,
    },
    {
        key: 'schedule_paused',
        category: 'generation',
        title: 'Schedule paused',
        description:
            'Scheduled updates for a work have been paused — likely due to repeated errors or an exhausted credit pool.',
        urgent: false,
        defaultChannels: IN_APP,
    },
    {
        key: 'git_auth_expired',
        // Stored as `integrations` — the value this row has always carried
        // and which callers of the registry read. `resolveMuteCategory` maps
        // it to `security`, the category the producer files the in-app row
        // under, so the event can be muted.
        category: 'integrations',
        title: 'Git authentication expired',
        description: 'Your Git provider authentication has expired and needs to be refreshed.',
        urgent: true,
        defaultChannels: IN_APP_AND_EMAIL,
        persistent: true,
    },
    {
        key: 'work_generation_finished',
        category: 'generation',
        title: 'Work generation finished',
        description: 'A scheduled or manual content generation run for a work finished.',
        urgent: false,
        defaultChannels: IN_APP,
        alternativeSurface: 'liveFeedWorkActivity',
    },
    {
        key: 'agent_run_finished',
        // Stored as `agents` — the value this row has always carried and
        // which callers of the registry read. `resolveMuteCategory` maps it
        // to the mutable `agent` category.
        category: 'agents',
        title: 'Agent run finished',
        description: 'An autonomous agent run completed.',
        urgent: false,
        defaultChannels: IN_APP,
        alternativeSurface: 'liveFeedRunsHome',
    },
    {
        key: 'mission_blocked',
        category: 'system',
        title: 'Mission blocked',
        description: 'A mission can no longer progress — review its blocking task to unblock.',
        urgent: true,
        quietHoursBypassNeedsOptIn: true,
        defaultChannels: IN_APP_AND_EMAIL,
    },
    {
        key: 'agent_run_queued_too_long',
        category: 'agent',
        title: 'Agent run queued too long',
        description:
            'An agent run has been waiting for capacity longer than the configured bound. Nothing was cancelled.',
        urgent: false,
        defaultChannels: IN_APP,
    },
    {
        key: 'agent_run_escalated',
        category: 'agent',
        title: 'Agent needs a decision',
        description:
            'An agent stopped without finishing (checks exhausted, guardrail refusal, budget stop or refused merge) and a human decision is required.',
        urgent: true,
        quietHoursBypassNeedsOptIn: true,
        defaultChannels: IN_APP_AND_EMAIL,
        persistent: true,
    },
    {
        key: 'inbox_question',
        category: 'agent',
        title: 'Agent asked a question',
        description:
            'An agent paused its run on a blocking question and is waiting for your reply in the Inbox.',
        urgent: true,
        defaultChannels: IN_APP_AND_EMAIL,
    },
    {
        key: 'inbox_approval_requested',
        category: 'agent',
        title: 'Approval requested',
        description:
            'An agent proposed a side-effectful action and is waiting for your approval in the Inbox.',
        urgent: true,
        quietHoursBypassNeedsOptIn: true,
        defaultChannels: IN_APP_AND_EMAIL,
    },
    {
        key: 'inbox_escalation',
        category: 'agent',
        title: 'Agent escalation in your Inbox',
        description:
            'An agent stopped without finishing and the escalation is waiting in your Inbox.',
        urgent: true,
        quietHoursBypassNeedsOptIn: true,
        defaultChannels: IN_APP_AND_EMAIL,
    },
    {
        key: 'inbox_notice',
        category: 'system',
        title: 'Inbox notice',
        description: 'The platform filed a notice in your Inbox.',
        urgent: false,
        defaultChannels: IN_APP,
    },
    {
        key: 'fleet_runner_fallback',
        category: 'agent',
        title: 'Local runner fallback',
        description:
            'A run that preferred your local runner was executed in the cloud instead, because no runner could take it.',
        urgent: false,
        defaultChannels: IN_APP,
    },
    // --- Emitted by producers but never registered before AW-13 ---
    {
        key: 'credits_balance_exhausted',
        category: 'ai_credits',
        title: 'Credits balance exhausted',
        description:
            "Your credit balance could not cover a run's metered usage. Top up credits to keep usage billing normally.",
        urgent: true,
        quietHoursBypassNeedsOptIn: true,
        defaultChannels: IN_APP_AND_EMAIL,
        persistent: true,
    },
    {
        key: 'payg_cap_80',
        category: 'ai_credits',
        title: 'Pay-as-you-go at 80% of cap',
        description: 'Your pay-as-you-go usage reached 80% of your monthly cap.',
        urgent: false,
        defaultChannels: IN_APP,
    },
    {
        key: 'payg_cap_100',
        category: 'ai_credits',
        title: 'Pay-as-you-go cap reached',
        description:
            'Your pay-as-you-go usage reached your monthly cap. New runs that need credits are paused until you raise the cap, buy a credit pack, or the cycle resets.',
        urgent: true,
        quietHoursBypassNeedsOptIn: true,
        defaultChannels: IN_APP_AND_EMAIL,
        persistent: true,
    },
    {
        key: 'payg_past_due',
        category: 'ai_credits',
        title: 'Pay-as-you-go payment failed',
        description:
            'A pay-as-you-go invoice could not be collected. Pay-as-you-go is paused until it is settled.',
        urgent: true,
        quietHoursBypassNeedsOptIn: true,
        defaultChannels: IN_APP_AND_EMAIL,
        persistent: true,
    },
    {
        key: 'budget_threshold_warning',
        category: 'ai_credits',
        title: 'Budget cap approaching',
        description: 'A Work budget crossed 75% or 90% of its cap for this period.',
        urgent: false,
        defaultChannels: IN_APP,
        emailGovernedByProfile: true,
    },
    {
        key: 'budget_threshold_reached',
        category: 'ai_credits',
        title: 'Budget cap reached',
        description: 'A Work budget reached its cap for this period, or is running in overage.',
        urgent: true,
        quietHoursBypassNeedsOptIn: true,
        defaultChannels: IN_APP,
        persistent: true,
        emailGovernedByProfile: true,
    },
    {
        key: 'memory_consolidation_ready',
        category: 'system',
        title: 'Memory ready for review',
        description: 'A scheduled memory consolidation pass produced changes waiting for review.',
        urgent: false,
        defaultChannels: IN_APP,
    },
    {
        key: 'digest_ready',
        category: 'digest',
        title: 'Digest ready',
        description: 'Your scheduled activity digest is ready.',
        urgent: false,
        defaultChannels: IN_APP_AND_EMAIL,
    },
    // Shared view (AW-18). Registered so the first-view notice can be routed
    // to a channel from the preference matrix; an unregistered key would stay
    // in-app forever.
    {
        key: 'shared_view_first_view',
        category: 'system',
        title: 'Shared view opened',
        description: 'A share link you published was opened for the first time.',
        urgent: false,
        defaultChannels: IN_APP,
    },
];

const CORE_EVENTS_BY_KEY: ReadonlyMap<string, CoreNotificationEvent> = new Map(
    CORE_NOTIFICATION_EVENTS.map((event) => [event.key, event]),
);

/** The catalogue row for a core event key, or undefined for plugin / unknown keys. */
export function findCoreNotificationEvent(key: string): CoreNotificationEvent | undefined {
    return CORE_EVENTS_BY_KEY.get(key);
}

/**
 * Does this urgent registry row come through the person's quiet hours?
 *
 * - Not urgent: never.
 * - Urgent and it came through before AW-13 (a core row without
 *   `quietHoursBypassNeedsOptIn`, or any plugin row): always, as before.
 * - Urgent since AW-13: only when the person opted in.
 */
export function urgentEventBypassesQuietHours(
    event: { readonly key: string; readonly urgent: boolean; readonly source?: string | null },
    optedIn: boolean,
): boolean {
    if (!event.urgent) return false;
    const needsOptIn =
        event.source !== 'plugin' &&
        findCoreNotificationEvent(event.key)?.quietHoursBypassNeedsOptIn === true;
    return needsOptIn ? optedIn : true;
}

/**
 * Registry category values that are not themselves mutable categories but
 * name one. Kept so rows (and plugin manifests) that carry the older value
 * can still be muted, without rewriting what those rows store.
 */
export const NOTIFICATION_CATEGORY_MUTE_ALIASES: Readonly<Record<string, NotificationCategory>> = {
    agents: NotificationCategory.AGENT,
    integrations: NotificationCategory.SECURITY,
};

const MUTABLE_CATEGORIES = new Set<string>(Object.values(NotificationCategory));

/**
 * The `NotificationCategory` a mute for an event of this category targets,
 * or null when no mute can reach it.
 */
export function resolveMuteCategory(category: string): NotificationCategory | null {
    if (MUTABLE_CATEGORIES.has(category)) {
        return category as NotificationCategory;
    }
    return NOTIFICATION_CATEGORY_MUTE_ALIASES[category] ?? null;
}

/**
 * The matrix heading an event sits under. Derived, never stored: an urgent
 * event needs you; the digest event is the digest; an event already visible
 * elsewhere in the product is routine; everything else is a signal.
 */
export function deriveNotificationMatrixGroup(event: {
    readonly urgent: boolean;
    readonly category: string;
    readonly alternativeSurface?: NotificationAlternativeSurface | null;
}): NotificationMatrixGroup {
    if (event.urgent) return 'needsYou';
    if (event.category === NotificationCategory.DIGEST) return 'digest';
    if (event.alternativeSurface) return 'routine';
    return 'signals';
}
