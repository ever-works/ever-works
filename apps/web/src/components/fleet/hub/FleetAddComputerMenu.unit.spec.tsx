import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Fleet hub (FL-01, spec §5.2, CONTRACTS §11.1 revision 6) — "Add computer ▾":
 * the two kinds FL-01 ships (a command-line node, the desktop app), each
 * opening the existing Add flow preset to that kind, then every entry another
 * epic registered (FL-16 virtual, FL-17 cloud) whose flag is on, in order.
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('../modules', () => ({}));

import { registerAddComputerItem, resetFleetRegistryForTests } from '../registry';
import { FleetAddComputerMenu, fleetAddComputerHref } from './FleetAddComputerMenu';

async function openMenu() {
    await userEvent.click(screen.getByRole('button', { name: 'addComputerMenuLabel' }));
}

/** The menu's entries, in the order they render. */
function entryIds(): Array<string | null> {
    return screen
        .getAllByTestId(/^fleet-add-computer-/)
        .map((element) => element.getAttribute('data-testid'));
}

afterEach(() => resetFleetRegistryForTests());

describe('fleetAddComputerHref', () => {
    it('sends each kind to the Computers tab’s Add flow, preset', () => {
        expect(fleetAddComputerHref('node')).toBe('/fleet/computers?add=node');
        expect(fleetAddComputerHref('desktop-node')).toBe('/fleet/computers?add=desktop-node');
    });
});

describe('FleetAddComputerMenu', () => {
    it('offers the two built-in kinds and nothing else when no epic registered one', async () => {
        render(<FleetAddComputerMenu />);
        await openMenu();
        expect(screen.getByTestId('fleet-add-computer-node')).toHaveAttribute(
            'href',
            '/fleet/computers?add=node',
        );
        expect(screen.getByTestId('fleet-add-computer-desktop-node')).toHaveAttribute(
            'href',
            '/fleet/computers?add=desktop-node',
        );
        expect(entryIds()).toEqual(['fleet-add-computer-node', 'fleet-add-computer-desktop-node']);
    });

    it('adds the registered entries whose flag is on, after the built-in two, in order', async () => {
        registerAddComputerItem({
            id: 'fl-17.cloud',
            order: 40,
            epic: 'FL-17',
            flag: 'FLEET_CLOUD_ENABLED',
            labelKey: 'fleet.cloud.addItem',
            href: '/fleet/computers?add=cloud',
            icon: 'cloud',
        });
        registerAddComputerItem({
            id: 'fl-16.virtual',
            order: 30,
            epic: 'FL-16',
            flag: 'FLEET_VIRTUAL_ENABLED',
            labelKey: 'fleet.virtual.addItem',
            href: '/fleet/computers?add=virtual',
            icon: 'virtual',
        });
        render(
            <FleetAddComputerMenu
                flags={{ FLEET_VIRTUAL_ENABLED: true, FLEET_CLOUD_ENABLED: true }}
            />,
        );
        await openMenu();
        expect(entryIds()).toEqual([
            'fleet-add-computer-node',
            'fleet-add-computer-desktop-node',
            'fleet-add-computer-fl-16.virtual',
            'fleet-add-computer-fl-17.cloud',
        ]);
        const cloud = screen.getByTestId('fleet-add-computer-fl-17.cloud');
        expect(cloud).toHaveAttribute('href', '/fleet/computers?add=cloud');
        // The label is the registered message key, translated from the root.
        expect(cloud).toHaveTextContent('fleet.cloud.addItem');
    });

    it('hides a registered entry while its flag is off', async () => {
        registerAddComputerItem({
            id: 'fl-17.cloud',
            order: 40,
            epic: 'FL-17',
            flag: 'FLEET_CLOUD_ENABLED',
            labelKey: 'fleet.cloud.addItem',
            href: '/fleet/computers?add=cloud',
        });
        render(<FleetAddComputerMenu flags={{ FLEET_CLOUD_ENABLED: false }} />);
        await openMenu();
        expect(screen.queryByTestId('fleet-add-computer-fl-17.cloud')).toBeNull();
        expect(entryIds()).toEqual(['fleet-add-computer-node', 'fleet-add-computer-desktop-node']);
    });
});
