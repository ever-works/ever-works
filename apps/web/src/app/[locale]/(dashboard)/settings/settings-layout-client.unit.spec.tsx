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
