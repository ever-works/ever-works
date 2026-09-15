import type { EmailSendOrigin } from '@ever-works/contracts';

/**
 * Agent email (AW-05) — injection token + contract for the question the
 * send path asks before any provider is touched: "may this message go out
 * now?"
 *
 * Token + contract only (a leaf file with type-only imports — the same
 * circular-dependency dodge as `policy/merge-approval.port.ts`).
 * `EmailFacadeService.send()` consumes it via `@Optional() @Inject(...)`;
 * `EmailSendPolicyModule` binds it to `EmailSendPolicyService`.
 *
 * Why the question lives behind the facade and not at each caller: every
 * send in the platform — an Agent's `sendEmail` / `messageAgent` tool, a
 * person composing, a released draft — converges on `send()`. Asking there
 * is the only place the answer cannot be skipped by a caller that forgot to
 * ask.
 *
 * Unbound (a bare unit-test context) = no gate, which is the behaviour the
 * facade had before this port existed. Every runtime that sends mail imports
 * `FacadesModule`, which binds it.
 */

export interface EmailSendAttempt {
    /** Owner the send is attributed to. No owner → nothing to gate or count. */
    readonly userId?: string;
    /** Agent the send is attributed to. Per-inbox ceilings and the draft gate key on it. */
    readonly agentId?: string;
    /** Set by server code, never from a request body. Absent is treated as `system`. */
    readonly origin?: EmailSendOrigin;
    /**
     * The `email_messages` row being released, when this send is an approved
     * draft. The gate reads the row back and refuses unless a person approved
     * exactly this message.
     */
    readonly draftMessageId?: string;
    readonly to: readonly string[];
    readonly cc?: readonly string[];
    readonly bcc?: readonly string[];
    readonly subject: string;
}

/**
 * AW-05 — the audit row a fresh send will be recorded as, written up front
 * as a RESERVATION (`status = 'sending'`, `sentAt` = admission time) when a
 * windowed ceiling applies, so the next concurrent send's count includes it.
 */
export interface EmailSendReservationRow {
    readonly userId: string;
    readonly agentId: string | null;
    readonly taskId: string | null;
    readonly emailAddressId: string;
    /** Provisional; replaced by the provider that actually sends. */
    readonly pluginId: string;
    readonly from: string;
    readonly toAddresses: string[];
    readonly ccAddresses: string[] | null;
    readonly bccAddresses: string[] | null;
    readonly subject: string;
    readonly bodyText: string;
    readonly bodyHtml: string | null;
    readonly metadata: Record<string, unknown> | null;
    readonly messageRef: string | null;
}

/**
 * How capacity is reserved for a send that passes its ceilings:
 * - `message` — insert this row as the reservation (a direct send);
 * - `draft`   — stamp the approved draft row itself (a released draft,
 *   `attempt.draftMessageId`), which already exists.
 */
export type EmailSendReservation =
    | { readonly kind: 'message'; readonly row: EmailSendReservationRow }
    | { readonly kind: 'draft' };

export interface EmailSendAdmission {
    /**
     * The `email_messages` row now holding capacity for this send. The
     * caller MUST settle it: move it to `sent` when the provider accepts the
     * message, or release it (no `sentAt`) when the send does not go out.
     * `null` = no windowed ceiling applies, nothing was reserved, and the
     * caller records the send after the provider accepts it, as before.
     */
    readonly reservedMessageId: string | null;
}

export interface EmailSendPolicyGate {
    /**
     * Resolve when the send may proceed. Throw
     * `EmailApprovalRequiredException` (the Agent's inbox holds its mail for
     * review and this is not an approved draft) or
     * `EmailSendCapExceededException` (a ceiling would be broken).
     */
    assertSendAllowed(attempt: EmailSendAttempt): Promise<void>;

    /**
     * {@link assertSendAllowed}, plus an ATOMIC reservation: when a windowed
     * ceiling applies, the count and the reservation happen under one
     * serialization (a Postgres advisory lock on the Agent and/or account),
     * so N concurrent sends at `cap - 1` admit exactly one. Same refusals.
     * Optional so a gate that only answers yes/no keeps working; the facade
     * prefers this when present.
     */
    admitSend?(
        attempt: EmailSendAttempt,
        reservation?: EmailSendReservation | null,
    ): Promise<EmailSendAdmission>;
}

export const EMAIL_SEND_POLICY_GATE = 'EMAIL_SEND_POLICY_GATE' as const;
