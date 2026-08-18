import { describe, expect, it } from 'vitest';
import { match } from 'path-to-regexp';
import { PUBLIC_ROUTES, ROUTES } from '../constants';

/**
 * Which pages render for a signed-out visitor.
 *
 * The failure this guards is silent and total. `proxy.ts` bounces an
 * unauthenticated request for a non-public route to `/login`, **clears the
 * auth cookie, and preserves no token**. So a token-landing page that is
 * missing from `PUBLIC_ROUTES` does not merely redirect — it destroys the
 * thing the visitor was sent. The user sees a login screen and their
 * invitation is simply gone, with nothing logged anywhere.
 *
 * Three routes already exist for exactly this reason and each carries a
 * comment saying so: the magic-link landing page, the resend-verification
 * page, and the onboarding hand-off. `/org-invite/:token` is the fourth, and
 * it is the one an outsider hits FIRST, before they have any account at all.
 *
 * Scope note, stated rather than implied: this exercises the real
 * `PUBLIC_ROUTES` data with the real `path-to-regexp` matcher, which is where
 * the mistake would actually be made. It does not import `proxy.ts` itself —
 * that would pull the whole Next middleware graph in — so the three-line
 * `isPublicRoute` wrapper is not covered here.
 */

const isPublic = (pathname: string): boolean =>
    PUBLIC_ROUTES.some((route) => {
        const matcher = match(route);
        return pathname === route || !!matcher(pathname);
    });

describe('PUBLIC_ROUTES', () => {
    it('CONTROL: a dashboard route is NOT public', () => {
        // Without this, an `isPublic` that returned true for everything would
        // make every assertion below pass while the auth gate was wide open.
        expect(isPublic('/dashboard')).toBe(false);
        expect(isPublic('/settings')).toBe(false);
        expect(isPublic('/teams/abc-123')).toBe(false);
    });

    it('serves the organization-invitation landing page to signed-out visitors', () => {
        const token = 'a'.repeat(64);
        expect(isPublic(`/org-invite/${token}`)).toBe(true);
    });

    it('matches any token shape, not one hard-coded example', () => {
        // The token is 64 hex characters today. The route must not silently
        // depend on that — a length change would otherwise 404 every live
        // invitation at once.
        expect(isPublic('/org-invite/short')).toBe(true);
        expect(isPublic(`/org-invite/${'f'.repeat(128)}`)).toBe(true);
    });

    it('does not accidentally open the whole /org-invite namespace', () => {
        // `:token` is a single segment. A bare `/org-invite` or a deeper path
        // is not a valid invitation link and should not be exempted from auth.
        expect(isPublic('/org-invite')).toBe(false);
        expect(isPublic('/org-invite/abc/extra')).toBe(false);
    });

    it('keeps the sibling token-landing pages public', () => {
        // Regression net: these three have each been broken before, and the
        // symptom every time was a cleared cookie rather than an error.
        expect(isPublic(ROUTES.AUTH_MAGIC_LINK)).toBe(true);
        expect(isPublic(ROUTES.AUTH_RESEND_VERIFICATION)).toBe(true);
        expect(isPublic(ROUTES.ONBOARDING)).toBe(true);
    });

    it('exposes a helper that builds a link the matcher accepts', () => {
        // The route pattern and the href builder have to agree; if they drift,
        // every emailed link 404s while the pattern still looks correct.
        const href = ROUTES.orgInvite('tok-123');
        expect(href).toBe('/org-invite/tok-123');
        expect(isPublic(href)).toBe(true);
    });
});
