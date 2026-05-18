import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'crypto';

/**
 * C-03 — server-side OAuth `state` minted on URL issuance and verified on
 * callback. Mitigates OAuth login CSRF (forced session fixation via
 * attacker-issued provider code) and OAuth-link CSRF (an attacker linking
 * their own provider identity to the victim's session).
 *
 * Mechanism: random 32-byte nonce, set as an HttpOnly cookie at
 * `/api/oauth/:providerId/url`, embedded as the `state` query param in
 * the upstream OAuth URL. On `/api/oauth/:providerId/callback`, the cookie
 * is matched against the `state` query param using `timingSafeEqual`, then
 * cleared so the value is single-use.
 *
 * The HttpOnly + Secure (in prod) + SameSite=Lax cookie prevents:
 *   - JS exfil from another origin
 *   - Cross-site cookie attaches on top-level POST (still attached on
 *     top-level GET, which is how OAuth callbacks come back — that's
 *     intentional and required for the flow to work)
 *
 * Replay protection: the cookie is deleted after a single match, so a
 * captured state value cannot be reused for a second callback.
 */

export const OAUTH_STATE_COOKIE = 'ew_oauth_state';
const STATE_TTL_SECONDS = 10 * 60; // 10 minutes — long enough for the
//  user to OAuth + come back, short
//  enough that a leaked state expires.

@Injectable()
export class OAuthStateService {
    private readonly logger = new Logger(OAuthStateService.name);

    /**
     * Generate a fresh state nonce. Returns both the value to embed in the
     * OAuth URL's `state` parameter AND the `Set-Cookie` header value the
     * caller should attach to the response.
     */
    mint(opts: { secure: boolean }): { state: string; setCookie: string } {
        const nonce = randomBytes(32).toString('base64url');
        const cookie =
            `${OAUTH_STATE_COOKIE}=${nonce}` +
            `; Path=/api/oauth` +
            `; Max-Age=${STATE_TTL_SECONDS}` +
            `; HttpOnly` +
            `; SameSite=Lax` +
            (opts.secure ? '; Secure' : '');
        return { state: nonce, setCookie: cookie };
    }

    /**
     * Constant-time compare the value the OAuth provider echoed back
     * (`state` query param) against the cookie the browser sent. Returns
     * true only if both are present, equal-length, and byte-for-byte
     * identical. Also returns a `clearCookie` `Set-Cookie` header so the
     * caller can delete the cookie regardless of outcome.
     */
    verify(opts: {
        cookieHeader: string | undefined;
        stateQuery: string | undefined;
        secure: boolean;
    }): { valid: boolean; clearCookie: string; reason?: string } {
        const clearCookie =
            `${OAUTH_STATE_COOKIE}=; Path=/api/oauth` +
            `; Max-Age=0` +
            `; HttpOnly` +
            `; SameSite=Lax` +
            (opts.secure ? '; Secure' : '');

        if (
            !opts.stateQuery ||
            typeof opts.stateQuery !== 'string' ||
            opts.stateQuery.length === 0
        ) {
            return { valid: false, clearCookie, reason: 'missing state query' };
        }
        const cookieValue = parseStateCookie(opts.cookieHeader);
        if (!cookieValue) {
            return { valid: false, clearCookie, reason: 'missing state cookie' };
        }
        const a = Buffer.from(cookieValue, 'utf8');
        const b = Buffer.from(opts.stateQuery, 'utf8');
        if (a.length !== b.length) {
            // Length-pad the compare to keep timing uniform.
            const c = Buffer.alloc(a.length);
            timingSafeEqual(a, c);
            return { valid: false, clearCookie, reason: 'state length mismatch' };
        }
        if (!timingSafeEqual(a, b)) {
            return { valid: false, clearCookie, reason: 'state value mismatch' };
        }
        return { valid: true, clearCookie };
    }
}

function parseStateCookie(header: string | undefined): string | undefined {
    if (!header) return undefined;
    // Hand-roll a minimal parser — the API doesn't ship cookie-parser
    // middleware and the OAuth cookie is the only one we read.
    for (const raw of header.split(';')) {
        const eq = raw.indexOf('=');
        if (eq < 0) continue;
        const name = raw.slice(0, eq).trim();
        if (name !== OAUTH_STATE_COOKIE) continue;
        return raw.slice(eq + 1).trim();
    }
    return undefined;
}
