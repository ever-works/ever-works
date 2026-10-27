import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { FLEET_PORT_TUNNEL_HANDOFF_TTL_SEC } from '@ever-works/contracts';

/**
 * Servers and ports, phase 2 (FL-10, CONTRACTS R-17) — the preview host's
 * two credentials, both HMAC-signed with the platform's secret under a
 * domain-separation label (so neither can ever be read as a terminal or
 * viewer token, nor the other way round):
 *
 *  - the **hand-off token** (`?t=`): 60 seconds, single use on this replica,
 *    bound to one tunnel and its owner. R-17's fallback "where the domains
 *    differ" — and on this platform they always do (the web's session cookie
 *    is host-only), so it is how the owner's browser gets in. The Agent is
 *    never given one (spec U15).
 *  - the **tunnel cookie** (`ew_ta_<id>`): what the hand-off is traded for,
 *    HttpOnly + Secure + SameSite=Lax, scoped to the preview host, valid until
 *    the tunnel's hard end (60 min). Every request is ALSO re-authorised
 *    against the tunnel row (open, unexpired, same owner), so closing a tunnel
 *    ends its cookie at once.
 */

interface TokenClaims {
    /** `h` hand-off, `c` cookie. */
    k: 'h' | 'c';
    /** Tunnel id. */
    t: string;
    /** Owner user id. */
    u: string;
    /** Expiry, epoch ms. */
    e: number;
    /** Nonce (hand-off single use). */
    n?: string;
}

const LABEL = 'ever-works:fleet-port-tunnel:v1:';

@Injectable()
export class FleetPortTunnelTokens {
    /** Hand-off nonces already used on this replica (bounded by their 60 s life). */
    private readonly used = new Map<string, number>();

    private secret(): Buffer | null {
        const raw =
            process.env.FLEET_PREVIEW_SECRET ||
            process.env.TERMINAL_ATTACH_SECRET ||
            process.env.BETTER_AUTH_SECRET ||
            process.env.AUTH_SECRET;
        if (!raw || raw.length < 16) return null;
        return Buffer.from(raw, 'utf8');
    }

    private sign(claims: TokenClaims): string | null {
        const key = this.secret();
        if (!key) return null;
        const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
        const mac = createHmac('sha256', key).update(`${LABEL}${body}`).digest('base64url');
        return `${body}.${mac}`;
    }

    private read(token: unknown, kind: 'h' | 'c'): TokenClaims | null {
        const key = this.secret();
        if (!key || typeof token !== 'string' || token.length === 0 || token.length > 1024)
            return null;
        const dot = token.indexOf('.');
        if (dot <= 0 || dot === token.length - 1) return null;
        const body = token.slice(0, dot);
        try {
            const expected = createHmac('sha256', key).update(`${LABEL}${body}`).digest();
            const provided = Buffer.from(token.slice(dot + 1), 'base64url');
            if (provided.length !== expected.length || !timingSafeEqual(expected, provided))
                return null;
            const claims = JSON.parse(
                Buffer.from(body, 'base64url').toString('utf8'),
            ) as TokenClaims;
            if (
                typeof claims !== 'object' ||
                claims === null ||
                claims.k !== kind ||
                typeof claims.t !== 'string' ||
                typeof claims.u !== 'string' ||
                typeof claims.e !== 'number' ||
                claims.e < Date.now()
            ) {
                return null;
            }
            return claims;
        } catch {
            return null;
        }
    }

    /** A 60-second, single-use hand-off for the owner's browser, or null when no secret is configured. */
    mintHandoff(tunnelId: string, userId: string): string | null {
        return this.sign({
            k: 'h',
            t: tunnelId,
            u: userId,
            e: Date.now() + FLEET_PORT_TUNNEL_HANDOFF_TTL_SEC * 1000,
            n: randomBytes(12).toString('base64url'),
        });
    }

    /** Redeem a hand-off for `tunnelId`: the owner's id, once; null for anything else. */
    redeemHandoff(token: unknown, tunnelId: string): string | null {
        const claims = this.read(token, 'h');
        if (!claims || claims.t !== tunnelId || !claims.n) return null;
        this.prune();
        if (this.used.has(claims.n)) return null;
        this.used.set(claims.n, claims.e);
        return claims.u;
    }

    /** The cookie value for the tunnel, valid until `expiresAt`. */
    mintCookie(tunnelId: string, userId: string, expiresAt: Date): string | null {
        return this.sign({ k: 'c', t: tunnelId, u: userId, e: expiresAt.getTime() });
    }

    /** The owner's id a tunnel cookie names, or null. */
    readCookie(token: unknown, tunnelId: string): string | null {
        const claims = this.read(token, 'c');
        return claims && claims.t === tunnelId ? claims.u : null;
    }

    private prune(): void {
        const now = Date.now();
        for (const [nonce, expires] of this.used) if (expires < now) this.used.delete(nonce);
    }
}

/** The cookie a tunnel's credential lives in: one per tunnel (a person holds at most four). */
export function fleetPortTunnelAuthCookieName(tunnelId: string): string {
    return `ew_ta_${tunnelId.replace(/-/g, '').slice(0, 16)}`;
}
