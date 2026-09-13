/**
 * Agent email (AW-05) — every numeric limit the agent email loop uses, in
 * one place.
 *
 * The send ceilings below are the PLATFORM DEFAULTS. They are not the only
 * word: an operator can replace any of them per deployment (environment),
 * an organization can replace them for its own agents, and an Agent's inbox
 * can replace the per-inbox ones for itself. See `email-send-caps.ts` for the
 * override shape, where `0` means "no ceiling for this limit" and
 * `null`/absent means "inherit from the scope above".
 */

/** Rolling 24 hours of sends from one Agent inbox. */
export const EMAIL_INBOX_DEFAULT_DAILY_CAP = 100;
/** Sends from one Agent inbox inside {@link EMAIL_INBOX_BURST_WINDOW_MS}. */
export const EMAIL_INBOX_BURST_SENDS = 10;
export const EMAIL_INBOX_BURST_WINDOW_MS = 60_000;
/** Distinct recipients one Agent inbox may reach inside {@link EMAIL_INBOX_RECIPIENT_WINDOW_MS}. */
export const EMAIL_INBOX_BURST_RECIPIENTS = 20;
export const EMAIL_INBOX_RECIPIENT_WINDOW_MS = 300_000;
/** Rolling 24 hours of sends across every Agent an account owns. */
export const EMAIL_WORKSPACE_DAILY_CAP = 500;
/** Rolling 30 days of sends across every Agent an account owns. */
export const EMAIL_WORKSPACE_MONTHLY_CAP = 10_000;
/** to + cc + bcc on one message. */
export const EMAIL_MAX_RECIPIENTS_PER_MESSAGE = 50;

export const EMAIL_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EMAIL_MONTH_WINDOW_MS = 30 * EMAIL_DAY_WINDOW_MS;

/**
 * Upper bound a configured ceiling may take. Not a product limit — a guard
 * against a typo (an extra few zeros) silently becoming "effectively
 * unlimited" when the operator meant a number. `0` stays the explicit way
 * to say "no ceiling".
 */
export const EMAIL_SEND_CAP_MAX_CONFIGURABLE = 1_000_000;

export const EMAIL_MAX_SCHEDULED_PER_INBOX = 200;
export const EMAIL_SCHEDULE_MIN_LEAD_MS = 60_000;
export const EMAIL_SCHEDULE_MAX_HORIZON_DAYS = 90;
export const EMAIL_MAX_REVISIONS = 5;
export const EMAIL_MAX_REVISE_NOTE_CHARS = 2_000;
export const EMAIL_DRAFT_VERSION_HISTORY = 10;
export const EMAIL_DRAFT_WARN_DAYS = 7;
export const EMAIL_DRAFT_EXPIRE_DAYS = 14;
export const EMAIL_MAX_STANDING_INSTRUCTION_CHARS = 8_000;
export const EMAIL_MAX_RULES_PER_WORKSPACE = 500;
export const EMAIL_MAX_RULES_PER_INBOX = 200;
export const EMAIL_MAX_SENDING_DOMAINS = 5;
export const EMAIL_ADDRESS_ALIAS_GRACE_DAYS = 30;
export const EMAIL_BLOCKED_RETENTION_DAYS = 30;
export const EMAIL_SEND_UNDO_GRACE_MS = 5_000;
export const EMAIL_BOUNCE_AUTO_GATE_THRESHOLD = 3;
export const EMAIL_MAX_ATTACHMENT_META = 25;
export const EMAIL_DOMAIN_CHECK_INTERVAL_MS = 900_000;
export const EMAIL_DOMAIN_MAX_CHECKS = 288;
/** Longest failure reason persisted on a message row. */
export const EMAIL_MAX_FAILURE_REASON_CHARS = 500;
