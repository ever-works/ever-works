/**
 * Attention controls (AW-13) — what a stored per-event notification choice
 * means.
 *
 * `user_notification_subscriptions` rows reach the platform through two kinds
 * of write, and they do not mean the same thing:
 *
 * - **Matrix choices** (`origin = 'matrix'`): saved from Settings ->
 *   Notifications, which always writes the complete list of targets for the
 *   row. The list is taken literally: an empty list means "nothing", and a
 *   list without `in-app` keeps the notification out of the bell.
 * - **Every other row** (`origin` NULL): rows stored before AW-13, and writes
 *   through `PUT /api/notifications/preferences/event/:eventKey` by API
 *   callers or the chat assistant. They keep the meaning they always had: a
 *   non-empty list picks the external targets, an empty list falls back to the
 *   organisation / event defaults, and the notification always reaches the
 *   bell.
 *
 * Only a choice the person made in the matrix may silence the bell or turn an
 * event's external deliveries off entirely. Pure functions, no I/O, so the
 * resolver and the matrix read agree by construction.
 */

import {
    NOTIFICATION_CHOICE_ORIGIN_MATRIX,
    NOTIFICATION_TARGET_IN_APP,
} from '@ever-works/contracts';

export { NOTIFICATION_CHOICE_ORIGIN_MATRIX };

/** The part of a stored subscription row these rules read. */
export interface StoredNotificationChoice {
    readonly channelIds?: readonly string[] | null;
    readonly origin?: string | null;
}

/** True when the row was saved from the notification matrix. */
export function isMatrixChoice(stored: StoredNotificationChoice | null | undefined): boolean {
    return stored?.origin === NOTIFICATION_CHOICE_ORIGIN_MATRIX;
}

/**
 * Does the stored row decide the target list, or do the defaults?
 *
 * A matrix choice always decides, even when empty. Any other row decides only
 * when it names at least one target; an empty one falls back to the defaults.
 */
export function storedChoiceDecidesTargets(
    stored: StoredNotificationChoice | null | undefined,
): boolean {
    if (!stored) return false;
    if (isMatrixChoice(stored)) return true;
    return (stored.channelIds?.length ?? 0) > 0;
}

/**
 * Does the in-app notification for this event interrupt (count as unread and
 * show in the bell)? Only a matrix choice that leaves `in-app` out says no.
 */
export function storedChoiceKeepsInApp(
    stored: StoredNotificationChoice | null | undefined,
): boolean {
    if (!isMatrixChoice(stored)) return true;
    return (stored?.channelIds ?? []).includes(NOTIFICATION_TARGET_IN_APP);
}

/**
 * The first non-empty default: the organisation default for the event, else
 * the event's own default, else in-app alone.
 */
export function defaultNotificationTargets(
    orgDefault: readonly string[] | null | undefined,
    eventDefault: readonly string[] | null | undefined,
): string[] {
    if (Array.isArray(orgDefault) && orgDefault.length > 0) return [...orgDefault];
    if (Array.isArray(eventDefault) && eventDefault.length > 0) return [...eventDefault];
    return [NOTIFICATION_TARGET_IN_APP];
}

/**
 * The targets that apply to one event right now, as the notification matrix
 * shows them: the stored row when it decides the targets, else the defaults;
 * and, unless a matrix choice says otherwise, `in-app` — because the
 * notification reaches the bell whatever the list names.
 */
export function effectiveNotificationTargets(
    stored: StoredNotificationChoice | null | undefined,
    orgDefault: readonly string[] | null | undefined,
    eventDefault: readonly string[] | null | undefined,
): string[] {
    const targets = storedChoiceDecidesTargets(stored)
        ? [...(stored?.channelIds ?? [])]
        : defaultNotificationTargets(orgDefault, eventDefault);
    if (storedChoiceKeepsInApp(stored) && !targets.includes(NOTIFICATION_TARGET_IN_APP)) {
        return [NOTIFICATION_TARGET_IN_APP, ...targets];
    }
    return targets;
}
