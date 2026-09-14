import {
    EMAIL_SEND_CAP_MAX_CONFIGURABLE,
    EMAIL_SEND_CAP_RECOMMENDED_DEFAULTS,
    type AgentInboxDto,
    type EmailCapMeterDto,
    type EmailSendCapLimitKind,
} from '@ever-works/contracts';

/**
 * Agent email (AW-05) — the pure half of the per-Agent inbox page: parsing
 * what a person typed into a limit field, and turning a refused send into
 * something the page can say without string-matching server messages.
 *
 * Kept free of React and of `server-only` so both the server actions and
 * the client panel use the same rules, and so they are unit-testable.
 */

export interface AgentEmailSendPolicyView {
    inbox: AgentInboxDto | null;
    meter: EmailCapMeterDto;
}

/** The four per-Agent limits a person can set. */
export const AGENT_INBOX_CAP_FIELDS = [
    'dailySendCap',
    'burstSendCap',
    'recipientBurstCap',
    'recipientsPerMessageCap',
] as const;

export type AgentInboxCapField = (typeof AGENT_INBOX_CAP_FIELDS)[number];

/** Which contract ceiling each per-Agent field sets. */
export const AGENT_INBOX_CAP_FIELD_TO_CAP: Record<AgentInboxCapField, keyof AgentInboxDto['caps']> =
    {
        dailySendCap: 'inboxDailySends',
        burstSendCap: 'inboxBurstSends',
        recipientBurstCap: 'inboxBurstRecipients',
        recipientsPerMessageCap: 'recipientsPerMessage',
    };

/** The meter window each per-Agent field is read from. */
export const AGENT_INBOX_CAP_FIELD_TO_WINDOW: Record<AgentInboxCapField, EmailSendCapLimitKind> = {
    dailySendCap: 'inboxDaily',
    burstSendCap: 'inboxBurst',
    recipientBurstCap: 'inboxRecipients',
    recipientsPerMessageCap: 'recipientsPerMessage',
};

/** The recommended per-Agent limits — what "apply the recommended limits" saves. */
export const RECOMMENDED_AGENT_INBOX_CAPS: Record<AgentInboxCapField, number> = {
    dailySendCap: EMAIL_SEND_CAP_RECOMMENDED_DEFAULTS.inboxDailySends,
    burstSendCap: EMAIL_SEND_CAP_RECOMMENDED_DEFAULTS.inboxBurstSends,
    recipientBurstCap: EMAIL_SEND_CAP_RECOMMENDED_DEFAULTS.inboxBurstRecipients,
    recipientsPerMessageCap: EMAIL_SEND_CAP_RECOMMENDED_DEFAULTS.recipientsPerMessage,
};

/**
 * Per-Agent fields for which NOTHING is configured right now — no operator
 * env var, no organization cap, no Agent settings — read from the meter's
 * window sources. A field whose window the meter does not report is not
 * listed (nothing is known about it).
 */
export function unconfiguredAgentCapFields(meter: EmailCapMeterDto): AgentInboxCapField[] {
    const sourceByKind = new Map(meter.windows.map((window) => [window.kind, window.source]));
    return AGENT_INBOX_CAP_FIELDS.filter(
        (field) => sourceByKind.get(AGENT_INBOX_CAP_FIELD_TO_WINDOW[field]) === 'unconfigured',
    );
}

/**
 * `true` when the Agent currently has no send limits of its own because
 * nothing is configured — every per-Agent window the meter reports is
 * `unconfigured` — while limits are not switched off for the deployment.
 * The panel says so and offers the recommended limits.
 */
export function hasNoConfiguredAgentLimits(meter: EmailCapMeterDto): boolean {
    if (!meter.enforced) return false;
    const agentWindows = meter.windows.filter((window) =>
        (Object.values(AGENT_INBOX_CAP_FIELD_TO_WINDOW) as string[]).includes(window.kind),
    );
    return (
        agentWindows.length > 0 && agentWindows.every((window) => window.source === 'unconfigured')
    );
}

/**
 * The text each limit field starts with. Existing settings show what is
 * stored. With no settings yet, a limit nobody configured is pre-filled with
 * the recommended number — so the first save protects the Agent by default,
 * visibly — while a limit an organization or the operator already sets is
 * left blank to keep inheriting it.
 */
export function initialCapInputs(
    view: AgentEmailSendPolicyView | null,
): Record<AgentInboxCapField, string> {
    const out = {} as Record<AgentInboxCapField, string>;
    const prefill = view && !view.inbox ? new Set(unconfiguredAgentCapFields(view.meter)) : null;
    for (const field of AGENT_INBOX_CAP_FIELDS) {
        const stored = view?.inbox?.caps[AGENT_INBOX_CAP_FIELD_TO_CAP[field]];
        out[field] = prefill?.has(field)
            ? String(RECOMMENDED_AGENT_INBOX_CAPS[field])
            : formatCapInput(stored);
    }
    return out;
}

/**
 * A limit field's text → the value the API takes.
 * - blank → `null` (inherit from the organization / platform)
 * - `0`   → `0`   (no limit for this Agent)
 * - a whole number up to the configurable maximum → that number
 * - anything else → `undefined` (invalid; the form refuses to submit)
 */
export function parseCapInput(raw: string): number | null | undefined {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    if (!/^\d+$/.test(trimmed)) return undefined;
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value) || value > EMAIL_SEND_CAP_MAX_CONFIGURABLE) return undefined;
    return value;
}

/** The stored value → the text a limit field starts with. */
export function formatCapInput(value: number | null | undefined): string {
    return value === null || value === undefined ? '' : String(value);
}

export type EmailSendRefusal =
    | {
          kind: 'sendLimit';
          limitKind: EmailSendCapLimitKind;
          used: number;
          cap: number;
          retryAfterSeconds: number;
      }
    | { kind: 'approvalRequired' }
    | { kind: 'alreadyDecided' };

/**
 * Recognise the structured refusals the email API returns. Accepts the
 * error a server fetch throws (`statusCode` + the parsed body in
 * `details`) and never reads the free-text message.
 */
export function describeEmailSendRefusal(error: unknown): EmailSendRefusal | null {
    if (!error || typeof error !== 'object') return null;
    const body = (error as { details?: unknown }).details;
    if (!body || typeof body !== 'object') return null;
    const { error: code, details } = body as { error?: unknown; details?: unknown };
    if (code === 'EmailSendCapExceeded' && details && typeof details === 'object') {
        const d = details as Record<string, unknown>;
        if (
            typeof d.limitKind === 'string' &&
            typeof d.used === 'number' &&
            typeof d.cap === 'number'
        ) {
            return {
                kind: 'sendLimit',
                limitKind: d.limitKind as EmailSendCapLimitKind,
                used: d.used,
                cap: d.cap,
                retryAfterSeconds:
                    typeof d.retryAfterSeconds === 'number' ? d.retryAfterSeconds : 0,
            };
        }
    }
    if (code === 'EmailApprovalRequired') return { kind: 'approvalRequired' };
    if (code === 'EmailDraftAlreadyDecided') return { kind: 'alreadyDecided' };
    return null;
}

/** Whole minutes until capacity returns, never less than 1. */
export function minutesUntil(retryAfterSeconds: number): number {
    return Math.max(1, Math.ceil(retryAfterSeconds / 60));
}

/** Statuses a person can act on from the inbox list. */
export function isDecidableDraft(status: string | null | undefined): boolean {
    return status === 'draft';
}
