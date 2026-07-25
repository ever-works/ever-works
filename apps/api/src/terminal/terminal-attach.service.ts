import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { TerminalClientRole } from './terminal-relay.registry';

/**
 * Short-lived signed attach tokens for the terminal WebSocket leg.
 *
 * Compact HMAC-SHA256 tokens (`base64url(payload).base64url(mac)`) —
 * deliberately NOT the session JWT: an attach token authorizes exactly
 * one run's terminal for ~60s and carries no other claims, so a leak
 * has minimal blast radius. Presented in the FIRST WebSocket message
 * (never in the URL → never in proxy/access logs).
 *
 * Secret: `TERMINAL_ATTACH_SECRET`, falling back to the Better Auth
 * secret every deployment already has (`BETTER_AUTH_SECRET`/`AUTH_SECRET`)
 * so local installs work out of the box. **Fail-closed**: with neither
 * set, minting throws 503 and verification refuses everything — an
 * unsecured relay must refuse attaches, never accept them all.
 */
export interface TerminalAttachClaims {
    userId: string;
    runId: string;
    role: TerminalClientRole;
    /** Unix ms expiry. */
    exp: number;
}

export const TERMINAL_ATTACH_TOKEN_TTL_SECONDS = 60;

@Injectable()
export class TerminalAttachService {
    private secret(): Buffer | null {
        const raw =
            process.env.TERMINAL_ATTACH_SECRET ||
            process.env.BETTER_AUTH_SECRET ||
            process.env.AUTH_SECRET;
        if (!raw || raw.length < 16) return null;
        return Buffer.from(raw, 'utf8');
    }

    mint(claims: Omit<TerminalAttachClaims, 'exp'>): { token: string; expiresInSec: number } {
        const key = this.secret();
        if (!key) {
            throw new ServiceUnavailableException(
                'Terminal attach tokens are not configured on this install ' +
                    '(set TERMINAL_ATTACH_SECRET or BETTER_AUTH_SECRET).',
            );
        }
        const payload: TerminalAttachClaims = {
            ...claims,
            exp: Date.now() + TERMINAL_ATTACH_TOKEN_TTL_SECONDS * 1000,
        };
        const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
        const mac = createHmac('sha256', key).update(body).digest('base64url');
        return { token: `${body}.${mac}`, expiresInSec: TERMINAL_ATTACH_TOKEN_TTL_SECONDS };
    }

    /**
     * Verify a token and return its claims, or `null` for ANYTHING
     * invalid: bad shape, bad MAC (constant-time), expired, missing
     * secret. Never throws — the gateway closes the socket on null.
     */
    verify(token: string): TerminalAttachClaims | null {
        const key = this.secret();
        if (!key) return null;
        if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null;
        const dot = token.indexOf('.');
        if (dot <= 0 || dot === token.length - 1) return null;
        const body = token.slice(0, dot);
        const mac = token.slice(dot + 1);
        try {
            const expected = createHmac('sha256', key).update(body).digest();
            const provided = Buffer.from(mac, 'base64url');
            if (provided.length !== expected.length) return null;
            if (!timingSafeEqual(expected, provided)) return null;
            const claims = JSON.parse(
                Buffer.from(body, 'base64url').toString('utf8'),
            ) as TerminalAttachClaims;
            if (
                typeof claims !== 'object' ||
                claims === null ||
                typeof claims.userId !== 'string' ||
                typeof claims.runId !== 'string' ||
                (claims.role !== 'driver' &&
                    claims.role !== 'viewer' &&
                    claims.role !== 'worker') ||
                typeof claims.exp !== 'number'
            ) {
                return null;
            }
            if (Date.now() >= claims.exp) return null;
            return claims;
        } catch {
            return null;
        }
    }
}
