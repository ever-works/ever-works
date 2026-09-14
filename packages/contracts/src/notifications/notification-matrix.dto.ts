/**
 * Attention controls (AW-13) — wire shape of Settings -> Notifications.
 *
 * The matrix is one row per registered notification event and one column per
 * delivery target the user can pick: the built-in in-app and email targets,
 * then each chat channel the user has connected. The server composes the whole
 * thing in one read, including the group each row belongs to, so the web never
 * re-derives a routing rule and the two cannot drift.
 */

import type { AttentionBudgetSnapshot } from './attention.types.js';

/** Built-in delivery target ids. Neither is a `notification_channels` row. */
export const NOTIFICATION_TARGET_IN_APP = 'in-app';
export const NOTIFICATION_TARGET_EMAIL = 'email';

/** Every built-in target id, in column order. */
export const NOTIFICATION_BUILT_IN_TARGETS: readonly string[] = [NOTIFICATION_TARGET_IN_APP, NOTIFICATION_TARGET_EMAIL];

/**
 * Stored with a per-event choice saved from the notification matrix
 * (`user_notification_subscriptions.origin`). Only such a choice is taken
 * literally: an empty list means "nothing" and a list without in-app keeps the
 * notification out of the bell. Choices stored any other way (before the
 * matrix existed, or through the API / chat assistant) carry no marker and
 * keep their original meaning.
 */
export const NOTIFICATION_CHOICE_ORIGIN_MATRIX = 'matrix';

/** A single event may name at most this many delivery targets. */
export const NOTIFICATION_MATRIX_MAX_TARGETS = 20;

/** Columns shown at once; the rest sit behind a per-row picker. */
export const NOTIFICATION_MATRIX_MAX_COLUMNS = 6;

/**
 * The four headings of the matrix.
 *
 * - `needsYou` — urgent events: only the owner can unblock them.
 * - `digest`   — the scheduled briefing itself.
 * - `routine`  — events already visible elsewhere in the product.
 * - `signals`  — everything else worth knowing.
 */
export type NotificationMatrixGroup = 'needsYou' | 'signals' | 'routine' | 'digest';

/** Append only — render order of the groups. */
export const NOTIFICATION_MATRIX_GROUPS: readonly NotificationMatrixGroup[] = [
	'needsYou',
	'signals',
	'routine',
	'digest'
];

/** Where a Routine row's information is already visible. Renderers own the words. */
export type NotificationAlternativeSurface = 'liveFeedRunsHome' | 'liveFeedWorkActivity';

export type NotificationMatrixColumnKind = 'in-app' | 'email' | 'channel';

/** Whether email to the account address can be delivered for this user. */
export type NotificationEmailAvailability = 'available' | 'unverified' | 'not-configured';

export type NotificationMatrixColumnDisabledReason = 'channel-disabled' | 'email-unverified' | 'email-not-configured';

export interface NotificationMatrixColumnDto {
	/** `in-app`, `email`, or a `notification_channels` row id. */
	readonly id: string;
	readonly kind: NotificationMatrixColumnKind;
	/** The channel's own name for chat channels; empty for built-ins (renderers translate). */
	readonly label: string;
	/** Display name of the delivering plugin, resolved server-side from the plugin registry. */
	readonly providerLabel: string | null;
	readonly pluginId: string | null;
	/** Switches in a disabled column are read-only; stored selections are kept. */
	readonly disabled: boolean;
	readonly disabledReason: NotificationMatrixColumnDisabledReason | null;
	/** ISO-8601; null for built-ins. Chat columns are ordered newest first. */
	readonly createdAt: string | null;
}

export interface NotificationMatrixEventDto {
	readonly key: string;
	readonly group: NotificationMatrixGroup;
	/** The category as stored on the registry row. */
	readonly category: string;
	/** The category a mute for this row targets, or null when it cannot be muted. */
	readonly muteCategory: string | null;
	readonly title: string;
	readonly description: string;
	readonly alternativeSurface: NotificationAlternativeSurface | null;
	readonly urgent: boolean;
	readonly source: 'core' | 'plugin';
	readonly pluginId: string | null;
	/**
	 * Persistent notifications always appear in the app, whatever the in-app
	 * switch says, so the in-app switch is rendered on and read-only.
	 */
	readonly inAppLocked: boolean;
	/**
	 * The email for this event is sent by a dedicated first-party producer
	 * governed by a profile setting, not by the matrix. The email switch is
	 * rendered read-only and reflects that setting.
	 */
	readonly emailGovernedByProfile: boolean;
	/** The shipped default target list for this event. */
	readonly defaultTargets: readonly string[];
	/**
	 * The targets that apply right now: the user's choice, else the defaults.
	 * In-app is included whenever the notification reaches the bell, which is
	 * always unless a choice saved in the matrix leaves it out.
	 */
	readonly selectedTargets: readonly string[];
	/** True when the user has stored a choice for this event (an empty choice included). */
	readonly explicit: boolean;
	/** ISO-8601 end of an active category mute; null when not muted or muted indefinitely. */
	readonly mutedUntil: string | null;
	readonly muted: boolean;
}

export interface NotificationMatrixQuietHoursDto {
	readonly start: string | null;
	readonly end: string | null;
	readonly timezone: string | null;
	/**
	 * The person's opt-in to let every urgent event through quiet hours.
	 * Off (the default): only the urgent events that always came through do;
	 * every other email and chat delivery waits until the window ends. The
	 * server always sends it; optional so older readers keep compiling.
	 */
	readonly urgentBypassesQuietHours?: boolean;
}

export interface NotificationMatrixDto {
	readonly columns: readonly NotificationMatrixColumnDto[];
	readonly events: readonly NotificationMatrixEventDto[];
	readonly quietHours: NotificationMatrixQuietHoursDto;
	readonly mutes: readonly { readonly category: string; readonly mutedUntil: string | null }[];
	readonly email: {
		readonly availability: NotificationEmailAvailability;
		/** The profile setting that governs rows with `emailGovernedByProfile`. */
		readonly profileBudgetAlerts: boolean;
	};
	/** Attention budget meters. Empty until budgets are enforced on this workspace. */
	readonly budgets: readonly AttentionBudgetSnapshot[];
	readonly limits: {
		readonly maxTargets: number;
		readonly maxColumns: number;
	};
}

export interface NotificationMatrixResetResultDto {
	/** Number of stored choices removed; those rows now follow their defaults. */
	readonly changed: number;
}
