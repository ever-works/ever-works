import type { FleetSessionAttention } from '@ever-works/contracts';
import type { FleetSession } from '../../entities/fleet-session.entity';

/**
 * Session status (FL-05, CONTRACTS R-12, §5.2) — where an attention edge is
 * delivered once the row holds it: the Inbox item that IS the Decision (a
 * question or a permission), the Inbox notice (blocked, failed), the "needs a
 * look" row and the notification, all keyed by the attention key so one
 * answer clears them everywhere.
 *
 * `FleetSessionStateService` calls it after it stored a NEW key (raised) or
 * let one go (cleared); a refresh of the same key is not a new edge. Bound by
 * FL-05 P2; unbound, the row is the only surface (the card still shows it).
 */
export const FLEET_SESSION_ATTENTION_SINK = Symbol('FLEET_SESSION_ATTENTION_SINK');

export interface FleetSessionAttentionAnswer {
    /** `user:<id>` | `agent:<id>` — who answered (the Decision records it). */
    answeredBy: string;
    /** The option chosen — never the free text (FR-49). */
    optionId?: string;
}

export interface FleetSessionAttentionSink {
    attentionRaised(
        row: FleetSession,
        attention: FleetSessionAttention,
        context: { finished: boolean },
    ): Promise<void>;
    /**
     * `answer` is set when it cleared because somebody answered through the
     * platform; null when the machine cleared it (answered in the terminal, a
     * new prompt, the session ended).
     */
    attentionCleared(
        row: FleetSession,
        attention: FleetSessionAttention,
        answer: FleetSessionAttentionAnswer | null,
    ): Promise<void>;
}
