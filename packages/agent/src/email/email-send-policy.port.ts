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

export interface EmailSendPolicyGate {
    /**
     * Resolve when the send may proceed. Throw
     * `EmailApprovalRequiredException` (the Agent's inbox holds its mail for
     * review and this is not an approved draft) or
     * `EmailSendCapExceededException` (a ceiling would be broken).
     */
    assertSendAllowed(attempt: EmailSendAttempt): Promise<void>;
}

export const EMAIL_SEND_POLICY_GATE = 'EMAIL_SEND_POLICY_GATE' as const;
