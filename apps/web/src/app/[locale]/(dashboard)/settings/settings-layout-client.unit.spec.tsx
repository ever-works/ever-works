import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    usePathname: () => '/settings',
}));
vi.mock('next/link', () => ({
    default: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/lib/utils/plugin-category-icons', () => ({
    getCategoryIcon: () => () => null,
}));

import { SettingsLayoutClient } from './settings-layout-client';
import { ROUTES } from '@/lib/constants';

/**
 * The `fleetEnabled` prop must actually WIRE THROUGH to the nav.
 *
 * The prop was declared (with a docstring), and the server layout passed
 * `fleetEnabled={isFleetEnabled()}` — but the client component never
 * destructured it, so FLEET_ENABLED had no effect and the fleet tab rendered
 * unconditionally. A test on the filter predicate alone would not have caught
 * that: the defect was the unread prop, not the logic. So this RENDERS the
 * component and asserts on the emitted nav.
 */
describe('SettingsLayoutClient — fleetEnabled wiring', () => {
    const renderNav = (props: { fleetEnabled?: boolean } = {}) =>
        render(
            <SettingsLayoutClient settingsMenu={null} {...props}>
                <div data-testid="page-body" />
            </SettingsLayoutClient>,
        );

    const fleetLink = () =>
        [...document.querySelectorAll('a')].find((a) =>
            (a.getAttribute('href') || '').endsWith('/settings/fleet'),
        );

    it('control: a neighbouring tab renders in every variant, so absence below is meaningful', () => {
        renderNav({ fleetEnabled: false });
        // Job Runtime sits directly below Fleet by design — if IT were missing
        // too, "no fleet tab" would mean the nav failed to render at all.
        const jobRuntime = [...document.querySelectorAll('a')].find((a) =>
            (a.getAttribute('href') || '').endsWith('/settings/job-runtime'),
        );
        expect(jobRuntime).toBeTruthy();
        expect(screen.getByTestId('page-body')).toBeInTheDocument();
    });

    it('renders the fleet tab by default (prop omitted) — the documented contract', () => {
        renderNav();
        expect(fleetLink()).toBeTruthy();
    });

    it('renders the fleet tab when explicitly enabled', () => {
        renderNav({ fleetEnabled: true });
        expect(fleetLink()).toBeTruthy();
    });

    it('hides the fleet tab when the operator has turned Fleet off', () => {
        // Pre-fix this failed: the prop was never read, so the tab rendered
        // regardless — a disabled deployment kept a nav entry to a dead route.
        renderNav({ fleetEnabled: false });
        expect(fleetLink()).toBeUndefined();
    });
});

/**
 * APW-11 T16 — the App Launcher tab (ACC-11-28).
 *
 * `appLauncherEnabled` is the opposite contract to `fleetEnabled`: the launcher
 * is OFF by default per installation (FR-54/FR-65), so the tab must be absent
 * unless the server layout says otherwise — including when a caller forgets the
 * prop entirely, which is the state a route with no entry point must have.
 */
describe('SettingsLayoutClient — the App Launcher tab', () => {
    const renderNav = (props: { appLauncherEnabled?: boolean } = {}) =>
        render(
            <SettingsLayoutClient settingsMenu={null} {...props}>
                <div data-testid="page-body" />
            </SettingsLayoutClient>,
        );

    const hrefs = () =>
        [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') || '');

    const launcherLink = () =>
        [...document.querySelectorAll('a')].find((a) =>
            (a.getAttribute('href') || '').endsWith('/settings/app-launcher'),
        );

    it('renders the tab when the launcher is enabled for this deployment', () => {
        renderNav({ appLauncherEnabled: true });

        expect(launcherLink()).toBeTruthy();
        expect(launcherLink()?.getAttribute('href')).toBe(ROUTES.DASHBOARD_SETTINGS_APP_LAUNCHER);
    });

    it('does not render the tab when the launcher is switched off', () => {
        renderNav({ appLauncherEnabled: false });

        // Control: a neighbouring tab still renders, so `undefined` below means
        // the filter worked rather than the nav failing to render at all.
        expect(hrefs().some((href) => href.endsWith('/settings/notifications'))).toBe(true);
        expect(launcherLink()).toBeUndefined();
    });

    it('defaults to OFF when a caller passes no prop at all', () => {
        renderNav();

        expect(launcherLink()).toBeUndefined();
    });

    it('places the tab directly after Notifications', () => {
        renderNav({ appLauncherEnabled: true });

        const notifications = hrefs().findIndex((href) => href.endsWith('/settings/notifications'));
        const launcher = hrefs().findIndex((href) => href.endsWith('/settings/app-launcher'));

        expect(notifications).toBeGreaterThanOrEqual(0);
        expect(launcher).toBe(notifications + 1);
    });
});
