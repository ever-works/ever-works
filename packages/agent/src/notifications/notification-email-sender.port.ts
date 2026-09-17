/**
 * Attention controls (AW-13) — the port behind the built-in `email`
 * delivery target.
 *
 * Email to the account's own address is a first-party delivery target, the
 * same kind of thing as the built-in `in-app` target: it is not a
 * `notification_channels` row and needs nothing connected. The channel
 * facade calls this port when a notification's plan names `email`; the API
 * binds it to an implementation over its transactional mail path. Nothing in
 * this file knows how mail is sent.
 */
export const NOTIFICATION_EMAIL_SENDER = Symbol.for('NOTIFICATION_EMAIL_SENDER');

export interface NotificationEmailInput {
    /** The recipient is always this user's own account address. */
    readonly userId: string;
    readonly eventKey?: string;
    readonly title: string;
    readonly message: string;
    /** Relative in-app path the primary button opens. */
    readonly actionUrl?: string;
    readonly actionLabel?: string;
}

/**
 * Why an email could not be sent without retrying. Retrying either of these
 * cannot succeed, so the delivery is recorded as failed and not re-attempted.
 */
export const NOTIFICATION_EMAIL_TERMINAL_ERRORS = [
    'not-configured',
    'address-unverified',
    'no-address',
] as const;

export type NotificationEmailTerminalError = (typeof NOTIFICATION_EMAIL_TERMINAL_ERRORS)[number];

export interface NotificationEmailResult {
    readonly status: 'delivered' | 'failed' | 'not-configured';
    readonly providerMessageId?: string;
    /** A terminal reason from {@link NOTIFICATION_EMAIL_TERMINAL_ERRORS}, or a short transport error. */
    readonly error?: string;
}

export interface NotificationEmailSender {
    deliver(input: NotificationEmailInput): Promise<NotificationEmailResult>;
}

/** True when `error` names a failure that retrying cannot fix. */
export function isTerminalNotificationEmailError(error: string | undefined): boolean {
    return (
        typeof error === 'string' &&
        (NOTIFICATION_EMAIL_TERMINAL_ERRORS as readonly string[]).includes(error)
    );
}
