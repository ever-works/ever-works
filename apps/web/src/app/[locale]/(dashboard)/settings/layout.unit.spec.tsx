import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * APW-11 T16 — `settings/layout.tsx` must resolve the App Launcher flag and
 * hand it to the client nav (APW11-G13, ACC-11-28).
 *
 * A **parent layout cannot pass props into a nested one**, and the client nav
 * must not read a non-public env var itself (it would be `undefined` in the
 * browser and the tab would reappear for a switched-off deployment). So this
 * nested server layout is the only place the flag can be resolved for the nav —
 * and the only thing a unit test can assert here is the **prop it passes**,
 * which is exactly the wiring that has gone missing before in this codebase
 * (`fleetEnabled` was passed, declared, documented — and never destructured).
 *
 * The complementary half — that an omitted prop defaults to OFF — is asserted
 * by rendering the client nav itself in `settings-layout-client.unit.spec.tsx`.
 */

const listForSettingsMenu = vi.fn();
const isFleetEnabled = vi.fn();
const isAppLauncherEnabled = vi.fn();
const getAuthFromRequest = vi.fn();

vi.mock('@/lib/api/plugins', () => ({
    pluginsAPI: {
        listForSettingsMenu: (...args: unknown[]) => listForSettingsMenu(...args),
    },
}));
vi.mock('@/lib/fleet-flags', () => ({
    isFleetEnabled: () => isFleetEnabled(),
}));
vi.mock('@/lib/feature-flags/app-launcher', () => ({
    isAppLauncherEnabled: (...args: unknown[]) => isAppLauncherEnabled(...args),
}));
vi.mock('@/lib/auth', () => ({
    getAuthFromRequest: () => getAuthFromRequest(),
}));
// The client nav imports its pathname helper from `@/i18n/navigation`, whose
// own `next/navigation` import does not resolve outside the Next runtime —
// the same mock the client nav's own spec uses.
vi.mock('@/i18n/navigation', () => ({
    usePathname: () => '/settings',
}));

import SettingsLayout from './layout';

beforeEach(() => {
    listForSettingsMenu.mockReset().mockResolvedValue({ categories: [] });
    isFleetEnabled.mockReset().mockReturnValue(true);
    isAppLauncherEnabled.mockReset().mockResolvedValue(true);
    getAuthFromRequest.mockReset().mockResolvedValue({
        isAuthenticated: true,
        isExpired: false,
        isOpaqueToken: false,
        user: { sub: 'user-1' },
    });
});

describe('SettingsLayout — the App Launcher flag', () => {
    it('passes appLauncherEnabled=true through to the client nav when the launcher is on', async () => {
        const tree = (await SettingsLayout({ children: null })) as React.ReactElement<{
            appLauncherEnabled?: boolean;
            fleetEnabled?: boolean;
        }>;

        expect(tree.props.appLauncherEnabled).toBe(true);
        // Control: the sibling flag still travels the same way, so a passing
        // assertion above is the launcher's prop and not a coincidence.
        expect(tree.props.fleetEnabled).toBe(true);
    });

    it('passes appLauncherEnabled=false when the launcher is off', async () => {
        isAppLauncherEnabled.mockResolvedValue(false);

        const tree = (await SettingsLayout({ children: null })) as React.ReactElement<{
            appLauncherEnabled?: boolean;
        }>;

        expect(tree.props.appLauncherEnabled).toBe(false);
    });

    it('evaluates the flag for the signed-in person, not for an anonymous id', async () => {
        await SettingsLayout({ children: null });

        // The PostHog half of `isAppLauncherEnabled` is per-person, and the
        // dashboard shell resolves it with the same id — a different id here
        // could show a tab whose launcher the header hides.
        expect(isAppLauncherEnabled).toHaveBeenCalledWith('user-1');
    });

    it('abstains (no id) when the session carries no user, rather than inventing one', async () => {
        getAuthFromRequest.mockResolvedValue({
            isAuthenticated: false,
            isExpired: false,
            isOpaqueToken: false,
        });

        await SettingsLayout({ children: null });

        expect(isAppLauncherEnabled).toHaveBeenCalledWith(undefined);
    });

    it('still resolves the flag when the settings-menu read fails', async () => {
        listForSettingsMenu.mockRejectedValue(new Error('API down'));

        const tree = (await SettingsLayout({ children: null })) as React.ReactElement<{
            appLauncherEnabled?: boolean;
        }>;

        expect(tree.props.appLauncherEnabled).toBe(true);
    });
});
