import { describe, expect, it } from 'vitest';
import { match } from 'path-to-regexp';
import { PUBLIC_ROUTES, ROUTES } from '../constants';

/**
 * APW-12 (Ever ID) — which of the new pages render for a signed-out visitor.
 *
 * The two confirmation screens of a first Ever ID sign-in are reached SIGNED
 * OUT, straight from the provider round trip. Missing from `PUBLIC_ROUTES`, the
 * proxy would bounce them to /login and the pending confirmation would be lost
 * with nothing logged — the failure `public-routes.unit.spec.ts` describes. The
 * settings pages stay behind the auth gate.
 */

const isPublic = (pathname: string): boolean =>
    PUBLIC_ROUTES.some((route) => {
        const matcher = match(route);
        return pathname === route || !!matcher(pathname);
    });

describe('PUBLIC_ROUTES — Ever ID pages', () => {
    it('serves both confirmation screens to signed-out visitors', () => {
        expect(ROUTES.AUTH_EVER_ID_CREATE_ACCOUNT).toBe('/auth/ever-id/create-account');
        expect(ROUTES.AUTH_EVER_ID_ACCOUNT_EXISTS).toBe('/auth/ever-id/account-exists');
        expect(isPublic(ROUTES.AUTH_EVER_ID_CREATE_ACCOUNT)).toBe(true);
        expect(isPublic(ROUTES.AUTH_EVER_ID_ACCOUNT_EXISTS)).toBe(true);
    });

    it('does not open the rest of the /auth/ever-id namespace', () => {
        expect(isPublic('/auth/ever-id')).toBe(false);
        expect(isPublic('/auth/ever-id/anything-else')).toBe(false);
    });

    it('keeps the connect confirmation and the administrator page behind the auth gate', () => {
        expect(isPublic(ROUTES.DASHBOARD_SETTINGS_SECURITY_CONNECT_EVER_ID)).toBe(false);
        expect(isPublic(ROUTES.DASHBOARD_SETTINGS_ADMIN_EVER_ID)).toBe(false);
    });
});
