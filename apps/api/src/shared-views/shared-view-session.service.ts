import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { SHARED_VIEW_LIMITS } from '@ever-works/contracts/api';

/**
 * The claims a view session carries. Nothing else: no token, no token hash,
 * no Organization id and no user id, so a leaked session names nothing.
 */
export interface SharedViewSessionClaims {
    v: 1;
    /** The Shared view id. */
    sid: string;
    /** The view's rotation count when the session was minted. */
    rot: number;
    /** Unix ms expiry. */
    exp: number;
}

const MAX_SESSION_LENGTH = 512;

/**
 * Short-lived view sessions for the public share-link reads.
 *
 * A visitor presents the share token ONCE, in a request body, and gets back a
 * compact HMAC-SHA256 credential (`base64url(claims).base64url(mac)`) valid for
 * fifteen minutes. Every read presents only that, in the `Authorization`
 * header, so the token never travels in an API URL. Modelled on the terminal
 * attach token.
 *
 * Revocable without storage: the session carries the view's rotation count,
 * and the guard requires the stored view to still be active at that same
 * count. Regenerating the link, turning sharing off or deleting the view
 * therefore refuses every outstanding session on its next request.
 *
 * Secret: `SHARED_VIEW_SESSION_SECRET`, falling back to the auth secret every
 * deployment already has. Fail closed: with no secret, minting answers 503 and
 * verification refuses everything.
 */
@Injectable()
export class SharedViewSessionService {
    private secret(): Buffer | null {
        const raw =
            process.env.SHARED_VIEW_SESSION_SECRET ||
            process.env.BETTER_AUTH_SECRET ||
            process.env.AUTH_SECRET;
        if (!raw || raw.length < 16) return null;
        // Domain-separate from any other signer sharing the fallback secret.
        return createHmac('sha256', raw).update('ever-works:shared-view-session:v1').digest();
    }

    mint(
        view: { id: string; rotationCount: number },
        now: number = Date.now(),
    ): {
        viewSession: string;
        expiresAt: string;
    } {
        const key = this.secret();
        if (!key) {
            throw new ServiceUnavailableException('shared_view_sessions_unavailable');
        }
        const exp = now + SHARED_VIEW_LIMITS.viewSessionTtlSeconds * 1000;
        const claims: SharedViewSessionClaims = {
            v: 1,
            sid: view.id,
            rot: view.rotationCount,
            exp,
        };
        const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
        const mac = createHmac('sha256', key).update(body).digest('base64url');
        return { viewSession: `${body}.${mac}`, expiresAt: new Date(exp).toISOString() };
    }

    /**
     * Verify a session and return its claims, or `null` for ANYTHING invalid:
     * bad shape, bad MAC (constant-time), expired, missing secret. Never throws.
     */
    verify(session: unknown, now: number = Date.now()): SharedViewSessionClaims | null {
        const key = this.secret();
        if (!key) return null;
        const parts = splitSession(session);
        if (!parts) return null;
        try {
            const expected = createHmac('sha256', key).update(parts.body).digest();
            const provided = Buffer.from(parts.mac, 'base64url');
            if (provided.length !== expected.length) return null;
            if (!timingSafeEqual(expected, provided)) return null;
            const claims = decodeClaims(parts.body);
            if (!claims) return null;
            if (now >= claims.exp) return null;
            return claims;
        } catch {
            return null;
        }
    }
}

/** `Authorization: Bearer <session>` → the session, or `null`. */
export function readBearerSession(header: unknown): string | null {
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== 'string') return null;
    const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
    return match ? match[1] : null;
}

/**
 * A stable throttle bucket for a presented session WITHOUT verifying it: the
 * Shared view id when the claims decode, else a hash of the raw value. Only
 * picks a bucket — the guard still verifies before anything is served.
 */
export function sessionThrottleBucket(session: string | null): string {
    if (!session) return 'none';
    const parts = splitSession(session);
    const claims = parts ? decodeClaims(parts.body) : null;
    if (claims) return `view:${claims.sid}`;
    return `raw:${createHash('sha256').update(session).digest('hex').slice(0, 32)}`;
}

function splitSession(session: unknown): { body: string; mac: string } | null {
    if (
        typeof session !== 'string' ||
        session.length === 0 ||
        session.length > MAX_SESSION_LENGTH
    ) {
        return null;
    }
    const dot = session.indexOf('.');
    if (dot <= 0 || dot === session.length - 1 || session.indexOf('.', dot + 1) !== -1) return null;
    return { body: session.slice(0, dot), mac: session.slice(dot + 1) };
}

function decodeClaims(body: string): SharedViewSessionClaims | null {
    try {
        const claims = JSON.parse(
            Buffer.from(body, 'base64url').toString('utf8'),
        ) as SharedViewSessionClaims;
        if (
            typeof claims !== 'object' ||
            claims === null ||
            claims.v !== 1 ||
            typeof claims.sid !== 'string' ||
            claims.sid.length === 0 ||
            !Number.isInteger(claims.rot) ||
            claims.rot < 0 ||
            typeof claims.exp !== 'number'
        ) {
            return null;
        }
        return claims;
    } catch {
        return null;
    }
}
