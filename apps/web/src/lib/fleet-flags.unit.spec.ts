import { afterEach, describe, expect, it } from 'vitest';
import { isFleetEnabled, isFleetHubEnabled } from './fleet-flags';
import { ROUTES } from './constants';

/**
 * Fleet hub (FL-01) — the two switches the hub sits behind, and the route
 * constants CONTRACTS §11.1 fixes.
 */

const saved = { fleet: process.env.FLEET_ENABLED, hub: process.env.FLEET_HUB_ENABLED };

afterEach(() => {
    if (saved.fleet === undefined) delete process.env.FLEET_ENABLED;
    else process.env.FLEET_ENABLED = saved.fleet;
    if (saved.hub === undefined) delete process.env.FLEET_HUB_ENABLED;
    else process.env.FLEET_HUB_ENABLED = saved.hub;
});

describe('isFleetHubEnabled', () => {
    it('is OFF by default (CONTRACTS §9) while the fleet itself stays on', () => {
        delete process.env.FLEET_ENABLED;
        delete process.env.FLEET_HUB_ENABLED;
        expect(isFleetEnabled()).toBe(true);
        expect(isFleetHubEnabled()).toBe(false);
    });

    it("is ON only for the literal 'true'", () => {
        process.env.FLEET_HUB_ENABLED = 'true';
        expect(isFleetHubEnabled()).toBe(true);
        for (const value of ['1', 'yes', 'TRUE', 'on', '']) {
            process.env.FLEET_HUB_ENABLED = value;
            expect(isFleetHubEnabled()).toBe(false);
        }
    });

    it('cannot resurrect a fleet FLEET_ENABLED switched off (spec U3)', () => {
        process.env.FLEET_HUB_ENABLED = 'true';
        process.env.FLEET_ENABLED = 'false';
        expect(isFleetHubEnabled()).toBe(false);
    });
});

describe('Fleet hub ROUTES (CONTRACTS §11.1)', () => {
    it('names every hub route', () => {
        expect(ROUTES.DASHBOARD_FLEET).toBe('/fleet');
        expect(ROUTES.DASHBOARD_FLEET_COMPUTERS).toBe('/fleet/computers');
        expect(ROUTES.DASHBOARD_FLEET_SESSIONS).toBe('/fleet/sessions');
        expect(ROUTES.DASHBOARD_FLEET_CHECKOUTS).toBe('/fleet/checkouts');
        expect(ROUTES.DASHBOARD_FLEET_COMMANDS).toBe('/fleet/commands');
        expect(ROUTES.DASHBOARD_FLEET_USAGE).toBe('/fleet/usage');
        expect(ROUTES.DASHBOARD_FLEET_SESSION('s-1')).toBe('/fleet/sessions/s-1');
        expect(ROUTES.DASHBOARD_ACTIVITY_SESSIONS).toBe('/activity?view=sessions');
    });

    it('addresses a computer page, omitting the default tab so the plain link stays canonical', () => {
        expect(ROUTES.DASHBOARD_FLEET_COMPUTER('n-1')).toBe('/fleet/computers/n-1');
        expect(ROUTES.DASHBOARD_FLEET_COMPUTER('n-1', 'overview')).toBe('/fleet/computers/n-1');
        expect(ROUTES.DASHBOARD_FLEET_COMPUTER('n-1', 'logs')).toBe(
            '/fleet/computers/n-1?tab=logs',
        );
        expect(ROUTES.DASHBOARD_FLEET_COMPUTER('a/b', 'x y')).toBe(
            '/fleet/computers/a%2Fb?tab=x%20y',
        );
    });
});
