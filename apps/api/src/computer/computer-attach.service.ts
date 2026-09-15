import { Injectable } from '@nestjs/common';
import { TerminalAttachService } from '../terminal/terminal-attach.service';
import type { TerminalClientRole } from '../terminal/terminal-relay.registry';

/**
 * Agent computers — attach tokens for the live-view WebSocket.
 *
 * NOT a second signer. The streaming terminal already mints short-lived
 * HMAC attach tokens with a fail-closed secret, a 60-second lifetime and a
 * constant-time check; this service rides that exact signer and only adds
 * the `computer` channel claim, so a live-view token can never open a
 * terminal socket and a terminal token can never open a live view.
 *
 * The role model is the terminal's, too, read one level over:
 *
 *   terminal role   live-view meaning
 *   ─────────────   ─────────────────────────────────────────────────────
 *   `viewer`        watches: receives pictures, may ask for a refresh or a
 *                   different quality, never sends input
 *   `driver`        holds control: may also send pointer, key, text and
 *                   scroll input (minted only to a view that holds control,
 *                   and gated again by the relay on every input frame)
 *   `worker`        the machine's own inbound leg: receives what viewers
 *                   ask for; minted only through the node-authenticated
 *                   internal route, never handed to a browser
 */
export interface ComputerAttachClaims {
    userId: string;
    sessionId: string;
    role: TerminalClientRole;
    /** Unix ms expiry. */
    exp: number;
}

/** Roles a browser may be minted for a live view today. */
export type ComputerRequestedRole = Extract<TerminalClientRole, 'viewer'>;

/**
 * Resolve the role an owner's attach-token request asks for.
 *
 * Watching is the only browser role while taking control has not shipped,
 * so every request — `driver`, the internal `worker`, anything unknown —
 * resolves to `viewer`. A request can only ever downgrade itself, the same
 * rule the terminal attach service applies.
 */
export function resolveRequestedComputerRole(_raw?: string | null): ComputerRequestedRole {
    return 'viewer';
}

/** Roles a browser may be minted for a live view: watching, or driving while it holds control. */
export type ComputerMintedRole = Extract<TerminalClientRole, 'viewer' | 'driver'>;

/**
 * Does an attach-token request ask to drive the machine (`controller`, or
 * the relay's own name for it, `driver`)? Asking is never enough: the
 * controller mints `driver` only when the arbiter says the requesting view
 * holds control right now, and `viewer` otherwise — the downgrade rule
 * above still holds, it just has one more rung.
 */
export function wantsComputerControlRole(raw?: string | null): boolean {
    return raw === 'controller' || raw === 'driver';
}

@Injectable()
export class ComputerAttachService {
    constructor(private readonly signer: TerminalAttachService) {}

    /** Mint a token for one live-view session. Throws 503 when no attach secret is configured. */
    mint(claims: Omit<ComputerAttachClaims, 'exp'>): { token: string; expiresInSec: number } {
        return this.signer.mint({
            userId: claims.userId,
            runId: claims.sessionId,
            role: claims.role,
            channel: 'computer',
        });
    }

    /** Claims of a valid live-view token, or null for anything else (a terminal token included). Never throws. */
    verify(token: string): ComputerAttachClaims | null {
        const claims = this.signer.verify(token);
        if (!claims || claims.channel !== 'computer') {
            return null;
        }
        return {
            userId: claims.userId,
            sessionId: claims.runId,
            role: claims.role,
            exp: claims.exp,
        };
    }
}
