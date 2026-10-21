import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FleetNodeView } from '@ever-works/contracts';
import type { FleetComputerActionProps } from '../registry';

/**
 * Fleet hub (FL-01, CONTRACTS §11.1 revision 6, FR-21) — what other epics
 * register into the computer page's header: an action that `replaces` the
 * disabled "New session" or "Desktop" placeholder renders in its place, other
 * header actions sit after the placeholders and before ⋯, an action whose flag
 * is off renders nothing, and every one receives the page's mirror of the
 * family check (`viewerRole`, `allowed`).
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
    useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/components/ui/tooltip', () => ({
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../modules', () => ({}));

import { registerComputerAction, resetFleetRegistryForTests } from '../registry';
import { ComputerHeader } from './ComputerHeader';

const node = (over: Partial<FleetNodeView> = {}): FleetNodeView =>
    ({
        id: 'n1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '1.0.0',
        capabilities: [],
        lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
        createdAt: null,
        persisted: true,
        viewerRole: 'owner',
        controlPolicy: 'owner',
        controlPolicyFamilies: null,
        ...over,
    }) as FleetNodeView;

/** A registered action that shows what the page handed it. */
function probe(testId: string) {
    return async () => ({
        default: ({ node: viewed, viewerRole, allowed }: FleetComputerActionProps) => (
            <button
                type="button"
                data-testid={testId}
                data-node={viewed.id}
                data-role={viewerRole}
                data-allowed={String(allowed)}
                disabled={!allowed}
            >
                {testId}
            </button>
        ),
    });
}

// RegisteredComponent caches one lazy component per id for the module's life,
// so every test registers its own ids.
let seq = 0;
const uid = (name: string) => `${name}-${(seq += 1)}`;

afterEach(() => resetFleetRegistryForTests());

describe('ComputerHeader — registered actions', () => {
    it('renders an action that replaces "New session" in its place, with the verdict', async () => {
        const id = uid('fl-04.new-session');
        registerComputerAction({
            id,
            placement: 'header',
            order: 10,
            epic: 'FL-04',
            family: 'sessions',
            flag: 'FLEET_SESSIONS_ENABLED',
            replaces: 'new-session',
            load: probe('stub-new-session'),
        });
        render(
            <ComputerHeader
                node={node()}
                flags={{ FLEET_SESSIONS_ENABLED: true }}
                menu={<button data-testid="stub-menu">⋯</button>}
            />,
        );
        const replaced = await screen.findByTestId('stub-new-session');
        expect(screen.queryByTestId('fleet-computer-new-session')).toBeNull();
        // The Desktop placeholder stays, naming its epic.
        expect(screen.getByTestId('fleet-computer-desktop')).toBeDisabled();
        expect(replaced).toHaveAttribute('data-node', 'n1');
        expect(replaced).toHaveAttribute('data-role', 'owner');
        expect(replaced).toHaveAttribute('data-allowed', 'true');
        // In the placeholder's slot: first in the action row.
        expect(screen.getByTestId('fleet-computer-actions').firstElementChild).toBe(replaced);
    });

    it('keeps the placeholder while the replacing action’s flag is off', () => {
        registerComputerAction({
            id: uid('fl-07.desktop'),
            placement: 'header',
            order: 10,
            epic: 'FL-07',
            family: 'desktop',
            flag: 'FLEET_DESKTOP_ENABLED',
            replaces: 'desktop',
            load: probe('stub-desktop-off'),
        });
        render(<ComputerHeader node={node()} flags={{}} />);
        expect(screen.getByTestId('fleet-computer-desktop')).toBeDisabled();
        expect(screen.queryByTestId('stub-desktop-off')).toBeNull();
    });

    it('puts an action that replaces nothing after the placeholders and before ⋯', async () => {
        registerComputerAction({
            id: uid('fl-10.open-port'),
            placement: 'header',
            order: 10,
            epic: 'FL-10',
            family: 'ports',
            load: probe('stub-extra'),
        });
        render(<ComputerHeader node={node()} menu={<button data-testid="stub-menu">⋯</button>} />);
        const extra = await screen.findByTestId('stub-extra');
        const row = Array.from(screen.getByTestId('fleet-computer-actions').children);
        const desktop = screen.getByTestId('fleet-computer-desktop');
        const menu = screen.getByTestId('stub-menu');
        const indexOf = (element: Element) =>
            row.findIndex((child) => child === element || child.contains(element));
        expect(indexOf(extra)).toBeGreaterThan(indexOf(desktop));
        expect(indexOf(extra)).toBeLessThan(indexOf(menu));
    });

    it('tells an action the viewer’s family does not admit them, never hiding the decision', async () => {
        registerComputerAction({
            id: uid('fl-09.restart'),
            placement: 'header',
            order: 10,
            epic: 'FL-09',
            family: 'services',
            load: probe('stub-denied'),
        });
        render(
            <ComputerHeader
                node={node({
                    viewerRole: 'org-member',
                    controlPolicyFamilies: {
                        view: 'org-members',
                    } as FleetNodeView['controlPolicyFamilies'],
                })}
            />,
        );
        const denied = await screen.findByTestId('stub-denied');
        expect(denied).toHaveAttribute('data-role', 'org-member');
        expect(denied).toHaveAttribute('data-allowed', 'false');
        expect(denied).toBeDisabled();
    });
});
