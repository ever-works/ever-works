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
