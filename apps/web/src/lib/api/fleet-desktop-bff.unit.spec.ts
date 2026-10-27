import { describe, expect, it } from 'vitest';
import { browserGrant, sanitizeDesktopViewBody } from './fleet-desktop-bff';

/** Desktop view & control (FL-07, T-25) — the Desktop BFF rebuilds bodies and grants. */

describe('fleet-desktop-bff', () => {
    it('rebuilds the view body from its allow-list', () => {
        expect(
            sanitizeDesktopViewBody({
                displayId: 'DP-1',
                quality: 'steady',
                role: 'driver',
                source: 'browser',
            }),
        ).toEqual({ displayId: 'DP-1', quality: 'steady' });
        expect(sanitizeDesktopViewBody({ displayId: '../../etc', quality: 'ultra' })).toEqual({});
    });

    it('never upgrades a grant to driver and refuses a malformed one', () => {
        const grant = browserGrant({
            token: 't',
            wsPath: '/ws/fleet/desktop/v1',
            expiresInSec: 60,
            role: 'admin',
        });
        expect(grant).toMatchObject({ token: 't', role: 'viewer', expiresInSec: 60 });
        expect(String(grant?.wsUrl)).toContain('/ws/fleet/desktop/v1');
        expect(browserGrant({ token: 1, wsPath: '/x' })).toBeNull();
        expect(browserGrant(null)).toBeNull();
    });
});
