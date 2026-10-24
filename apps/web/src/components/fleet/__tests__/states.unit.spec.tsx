import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FleetNodeView } from '@ever-works/contracts';

/**
 * Fleet hub (FL-01, FR-35, FR-36, ACC-FL01-18, T-29) — the state audit.
 *
 * Every Fleet surface renders each of its states — empty, loading,
 * unavailable with a reason, failed — as a sentence, and every word a person
 * reads comes from an i18n key under `fleet.*` (or the existing
 * `dashboard.settings.fleet.*` the moved table keeps). The translator here
 * returns `⟦key⟧`, so any text left once the keys and the data (a computer's
 * name, a command) are removed is a literal string in a component.
 */

vi.mock('next-intl', () => {
    const t = (key: string) => `⟦${key}⟧`;
    return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
    usePathname: () => '/fleet',
}));
vi.mock('@/components/ui/tooltip', () => ({
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/settings/fleet', () => ({
    fetchFleetNeedsALookAction: vi.fn(),
    updateFleetNodeAction: vi.fn(),
    setFleetNodeFavoriteAction: vi.fn(),
    drainFleetNodeAction: vi.fn(),
    deleteFleetNodeAction: vi.fn(),
    fetchFleetComputerInFlightAction: vi.fn(),
    setFleetNodePolicyFamiliesAction: vi.fn(),
}));
vi.mock('../fleet-telemetry', () => ({ captureFleetEvent: vi.fn() }));
vi.mock('../modules', () => ({}));

import { NeedsALookList } from '../overview/NeedsALookList';
import { ComputerCards } from '../overview/ComputerCards';
import { FleetEmptyState } from '../overview/FleetEmptyState';
import { ComputerTabPlaceholder } from '../computer/ComputerTabPlaceholder';
import { ComputerHeader } from '../computer/ComputerHeader';
import { ComputerActionsMenu } from '../computer/ComputerActionsMenu';
import { PolicyFamiliesEditor } from '../computer/PolicyFamiliesEditor';
import { FleetSettingsLinkCard } from '../FleetSettingsLinkCard';

const NAME = 'build-01';
const COMMAND = 'ever-works-node start --manage';

const node = (over: Partial<FleetNodeView> = {}): FleetNodeView =>
    ({
        id: 'n1',
        name: NAME,
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

/** Whatever a person would read that did NOT come from a key or from the data. */
function literalText(container: HTMLElement, data: readonly string[] = []): string[] {
    let text = container.textContent ?? '';
    text = text.replace(/⟦[^⟧]*⟧/g, ' ');
    for (const value of data) text = text.split(value).join(' ');
    return text
        .split(/[\s·()—:,.…%|/←→?]+/)
        .map((word) => word.trim())
        .filter((word) => /\p{L}/u.test(word));
}

describe('Fleet states — every variant is a sentence from a key (FR-35, FR-36)', () => {
    it('catches a literal string (the check is not vacuous)', () => {
        const { container } = render(<p>⟦fleet.x⟧ Could not load {NAME} · 94%</p>);
        expect(literalText(container, [NAME])).toEqual(['Could', 'not', 'load']);
    });

    it.each([
        ['needs a look — empty', { items: [], partial: false }, null],
        ['needs a look — partial', { items: [], partial: true }, null],
        ['needs a look — failed', null, 'boom'],
    ] as const)('%s', (_label, initial, initialError) => {
        const { container } = render(
            <NeedsALookList
                initial={initial as never}
                initialError={initialError}
                nodes={[{ id: 'n1', name: NAME }]}
            />,
        );
        expect(container.textContent).toMatch(/⟦/);
        expect(literalText(container, [NAME])).toEqual([]);
    });

    it('the empty fleet', () => {
        const { container } = render(<FleetEmptyState />);
        expect(literalText(container)).toEqual([]);
    });

    it('computer cards, including a shared and an offline computer', () => {
        const { container } = render(
            <ComputerCards
                nodes={[
                    node(),
                    node({
                        id: 'n2',
                        name: 'design-mac',
                        status: 'offline',
                        viewerRole: 'org-member',
                    }),
                ]}
            />,
        );
        expect(literalText(container, [NAME, 'design-mac'])).toEqual([]);
    });

    it.each([
        ['not shipped', { kind: 'not-shipped', epic: 'FL-08' }],
        ['switched off', { kind: 'switched-off', epic: 'FL-08' }],
        ['kind cannot', { kind: 'kind-cannot' }],
        ['consent missing', { kind: 'consent-missing', consent: 'manage', command: COMMAND }],
    ] as const)('a computer tab placeholder — %s', (_label, state) => {
        const { container } = render(
            <ComputerTabPlaceholder tab="logs" nodeName={NAME} state={state as never} />,
        );
        expect(container.querySelector('[role="status"]')).not.toBeNull();
        expect(literalText(container, [NAME, COMMAND, 'FL-08'])).toEqual([]);
    });

    it('the computer header, online and offline', () => {
        const online = render(<ComputerHeader node={node()} />);
        expect(literalText(online.container, [NAME, 'FL-04', 'FL-07'])).toEqual([]);
        online.unmount();
        const offline = render(<ComputerHeader node={node({ status: 'offline' })} />);
        expect(literalText(offline.container, [NAME, 'FL-04', 'FL-07'])).toEqual([]);
    });

    it('the ⋯ menu, opened, for the owner and for a member outside Lifecycle', async () => {
        for (const viewerRole of ['owner', 'org-member'] as const) {
            const { container, getByTestId, unmount } = render(
                <ComputerActionsMenu node={node({ viewerRole })} />,
            );
            await userEvent.click(getByTestId('fleet-computer-menu-trigger'));
            expect(literalText(document.body, [NAME])).toEqual([]);
            expect(container).toBeTruthy();
            unmount();
        }
    });

    it('who can do what — the family editor, owner and viewer', () => {
        for (const viewerRole of ['owner', 'org-member'] as const) {
            const { container, unmount } = render(
                <PolicyFamiliesEditor node={node({ viewerRole })} />,
            );
            expect(literalText(container, [NAME])).toEqual([]);
            unmount();
        }
    });

    it('Settings → Fleet’s card pointing at the hub', () => {
        const { container } = render(<FleetSettingsLinkCard />);
        expect(literalText(container)).toEqual([]);
    });
});
