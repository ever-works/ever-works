import * as crypto from 'crypto';
import { OAuthStateService, OAUTH_STATE_COOKIE } from './oauth-state.service';

describe('OAuthStateService (C-03)', () => {
    let service: OAuthStateService;

    beforeEach(() => {
        service = new OAuthStateService();
    });

    describe('mint', () => {
        it('produces a state value with high entropy and a Set-Cookie header that carries the same value', () => {
            const { state, setCookie } = service.mint({ secure: true });

            // 32 bytes → 43-char base64url (no padding).
            expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
            // The cookie value must be the SAME nonce so the callback can compare.
            expect(setCookie).toContain(`${OAUTH_STATE_COOKIE}=${state}`);
        });

        it('sets HttpOnly + SameSite=Lax + Secure when secure=true', () => {
            const { setCookie } = service.mint({ secure: true });
            expect(setCookie).toContain('HttpOnly');
            expect(setCookie).toContain('SameSite=Lax');
            expect(setCookie).toContain('Secure');
        });

        it('drops Secure when secure=false (dev / http)', () => {
            const { setCookie } = service.mint({ secure: false });
            expect(setCookie).toContain('HttpOnly');
            expect(setCookie).toContain('SameSite=Lax');
            expect(setCookie).not.toContain('Secure');
        });

        it('scopes the cookie path to /api/oauth (not the whole site)', () => {
            const { setCookie } = service.mint({ secure: true });
            expect(setCookie).toContain('Path=/api/oauth');
        });

        it('gives the cookie a finite TTL (Max-Age)', () => {
            const { setCookie } = service.mint({ secure: true });
            const m = setCookie.match(/Max-Age=(\d+)/);
            expect(m).not.toBeNull();
            expect(Number(m![1])).toBeGreaterThan(60); // > 1 minute
            expect(Number(m![1])).toBeLessThanOrEqual(60 * 60); // ≤ 1 hour
        });

        it('mints a fresh nonce on every call (no caching)', () => {
            const a = service.mint({ secure: true });
            const b = service.mint({ secure: true });
            expect(a.state).not.toBe(b.state);
        });
    });

    describe('verify', () => {
        it('accepts when the cookie and the state query match', () => {
            const { state, setCookie } = service.mint({ secure: false });
            const cookieValue = setCookie.split(';')[0]; // "ew_oauth_state=<nonce>"
            const result = service.verify({
                cookieHeader: cookieValue,
                stateQuery: state,
                secure: false,
            });
            expect(result.valid).toBe(true);
            expect(result.reason).toBeUndefined();
        });

        it('rejects when the state query is missing', () => {
            const { setCookie } = service.mint({ secure: false });
            const cookieValue = setCookie.split(';')[0];
            const result = service.verify({
                cookieHeader: cookieValue,
                stateQuery: undefined,
                secure: false,
            });
            expect(result.valid).toBe(false);
            expect(result.reason).toMatch(/missing state query/);
        });

        it('rejects when the cookie is missing', () => {
            const { state } = service.mint({ secure: false });
            const result = service.verify({
                cookieHeader: undefined,
                stateQuery: state,
                secure: false,
            });
            expect(result.valid).toBe(false);
            expect(result.reason).toMatch(/missing state cookie/);
        });

        it('rejects when the cookie value does not match the state query (CSRF attempt)', () => {
            const a = service.mint({ secure: false });
            const b = service.mint({ secure: false }); // different nonce
            const aCookie = a.setCookie.split(';')[0];
            const result = service.verify({
                cookieHeader: aCookie,
                stateQuery: b.state, // attacker-controlled state
                secure: false,
            });
            expect(result.valid).toBe(false);
            expect(result.reason).toMatch(/state .* mismatch/);
        });

        it('rejects when state and cookie are different lengths (no oracle)', () => {
            const { setCookie } = service.mint({ secure: false });
            const cookieValue = setCookie.split(';')[0];
            const result = service.verify({
                cookieHeader: cookieValue,
                stateQuery: 'short',
                secure: false,
            });
            expect(result.valid).toBe(false);
            expect(result.reason).toMatch(/length mismatch/);
        });

        // AI-review feedback (PR #818): the previous length-mismatch branch
        // compared the attacker-controlled cookie against a zero-filled
        // buffer of the cookie's length, giving the attacker a tiny timing
        // oracle for "is my cookie all-zero bytes?". The current branch
        // pads BOTH buffers to a common width and runs a single
        // timingSafeEqual, so the byte pattern of the inputs no longer
        // affects which buffer is "absent".
        it('length-mismatch path always rejects, regardless of which side is longer', () => {
            const { setCookie, state } = service.mint({ secure: false });
            const cookieValue = setCookie.split(';')[0];

            // Cookie longer than state query.
            const r1 = service.verify({
                cookieHeader: cookieValue,
                stateQuery: 'short',
                secure: false,
            });
            expect(r1.valid).toBe(false);
            expect(r1.reason).toMatch(/length mismatch/);

            // State query longer than cookie. Construct a short cookie value.
            const shortCookieHeader = `${OAUTH_STATE_COOKIE}=ab`;
            const r2 = service.verify({
                cookieHeader: shortCookieHeader,
                stateQuery: state, // 43 chars
                secure: false,
            });
            expect(r2.valid).toBe(false);
            expect(r2.reason).toMatch(/length mismatch/);
        });

        it('length-mismatch branch performs a single timingSafeEqual on equal-width padded buffers (no all-zero oracle)', () => {
            // The fix: regardless of input lengths, exactly one call to
            // timingSafeEqual happens, and it's on two buffers of the same
            // (max) length — derived from BOTH sides, not just the cookie.
            // This means an attacker choosing an all-zero cookie can't
            // distinguish their compare from a compare against the real
            // expected value.
            const spy = jest.spyOn(crypto, 'timingSafeEqual');
            try {
                const { setCookie } = service.mint({ secure: false });
                const cookieValue = setCookie.split(';')[0];

                // Wrong-length attacker state.
                const result = service.verify({
                    cookieHeader: cookieValue,
                    stateQuery: 'a'.repeat(10),
                    secure: false,
                });
                expect(result.valid).toBe(false);
                expect(result.reason).toMatch(/length mismatch/);

                // Exactly one comparison happens (no second "real" compare).
                expect(spy).toHaveBeenCalledTimes(1);
                const [aArg, bArg] = spy.mock.calls[0] as [Buffer, Buffer];
                // Both args have the same length (the new shape) so
                // timingSafeEqual doesn't throw.
                expect(aArg.byteLength).toBe(bArg.byteLength);
                // And the width is max(cookieLen, queryLen) — i.e. derived
                // from BOTH sides, not just one. With a 43-char base64url
                // cookie and a 10-char query, width should be 43.
                expect(aArg.byteLength).toBe(43);
            } finally {
                spy.mockRestore();
            }
        });

        it('attacker-supplied all-zero-byte cookie of length-mismatch is rejected (no timing oracle)', () => {
            // Regression: a cookie containing only NUL bytes used to be
            // compared against a zero-buffer of the same length on the
            // mismatch branch, which made that comparison return true and
            // gave a tiny timing delta vs a non-zero-cookie compare.
            //
            // We assert the rejection still happens and that the result is
            // not "valid" — exact same observable behavior across both
            // inputs from the caller's POV.
            const zeroCookie = `${OAUTH_STATE_COOKIE}=${'\0'.repeat(8)}`;
            const result = service.verify({
                cookieHeader: zeroCookie,
                stateQuery: 'x'.repeat(43), // different length
                secure: false,
            });
            expect(result.valid).toBe(false);
            expect(result.reason).toMatch(/length mismatch/);
        });

        it('always returns a Max-Age=0 clear-cookie header so the value is single-use', () => {
            const { state, setCookie } = service.mint({ secure: false });
            const cookieValue = setCookie.split(';')[0];
            const result = service.verify({
                cookieHeader: cookieValue,
                stateQuery: state,
                secure: false,
            });
            expect(result.clearCookie).toContain(`${OAUTH_STATE_COOKIE}=`);
            expect(result.clearCookie).toContain('Max-Age=0');
            expect(result.clearCookie).toContain('HttpOnly');
        });

        it('clears the cookie even on failure (no zombie state)', () => {
            const result = service.verify({
                cookieHeader: undefined,
                stateQuery: undefined,
                secure: false,
            });
            expect(result.valid).toBe(false);
            expect(result.clearCookie).toContain('Max-Age=0');
        });

        it('parses out the state cookie even when other cookies are also present in the header', () => {
            const { state, setCookie } = service.mint({ secure: false });
            const stateCookie = setCookie.split(';')[0];
            const cookieHeader = `_ga=GA1.2.x; ${stateCookie}; other=value`;
            const result = service.verify({
                cookieHeader,
                stateQuery: state,
                secure: false,
            });
            expect(result.valid).toBe(true);
        });
    });
});
