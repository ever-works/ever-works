import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NeedsALookItem } from '@ever-works/contracts';
import { NeedsALookList } from './NeedsALookList';
import {
    registerNeedsALookCommand,
    resetNeedsALookCommandsForTests,
} from './needs-a-look-commands';

/**
 * Fleet hub (FL-01, FR-5, FR-6, U11, ACC-FL01-03) — the "needs a look" list:
 * order, one action per row, the empty sentence, and the failure that never
 * hides anything else.
 */

const fetchFleetNeedsALookAction = vi.fn();

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
vi.mock('@/app/actions/settings/fleet', () => ({
    fetchFleetNeedsALookAction: (...args: unknown[]) => fetchFleetNeedsALookAction(...args),
}));

const item = (over: Partial<NeedsALookItem> = {}): NeedsALookItem => ({
    id: 'disk-low:n1',
    nodeId: 'n1',
    severity: 'warn',
    kind: 'disk-low',
    title: 'Disk is 94% full',
    detail: '6 GB left',
    since: '2026-10-18T09:00:00.000Z',
    ...over,
});

const nodes = [
    { id: 'n1', name: 'design-mac' },
    { id: 'n2', name: 'build-02' },
];

beforeEach(() => {
    fetchFleetNeedsALookAction.mockReset();
});
afterEach(() => resetNeedsALookCommandsForTests());

describe('NeedsALookList', () => {
    it('lists critical before warn before info, naming each computer, with its count', () => {
        render(
            <NeedsALookList
                initial={{
                    items: [
                        item({ id: 'a', severity: 'info', title: 'An upgrade is available' }),
                        item({ id: 'b', severity: 'critical', nodeId: 'n2', title: 'Quarantined' }),
                        item({ id: 'c', severity: 'warn' }),
                    ],
                    partial: false,
                }}
                initialError={null}
                nodes={nodes}
            />,
        );
        const rows = screen.getAllByRole('listitem');
        expect(rows.map((row) => row.getAttribute('data-severity'))).toEqual([
            'critical',
            'warn',
            'info',
        ]);
        expect(within(rows[0]).getByText('build-02')).toBeInTheDocument();
        expect(within(rows[1]).getByText('design-mac')).toBeInTheDocument();
        expect(screen.getByRole('region')).toHaveTextContent('(3)');
    });

    it('says "Nothing needs a look." for an empty, complete answer', () => {
        render(
            <NeedsALookList
                initial={{ items: [], partial: false }}
                initialError={null}
                nodes={nodes}
            />,
        );
        expect(screen.getByTestId('fleet-needs-a-look-empty')).toHaveTextContent('empty');
    });

    it('never claims nothing needs a look when a producer was skipped', () => {
        render(
            <NeedsALookList
                initial={{ items: [], partial: true }}
                initialError={null}
                nodes={nodes}
            />,
        );
        expect(screen.getByTestId('fleet-needs-a-look-empty')).toHaveTextContent('partial');
    });

    it('offers a route action as a link, and no button for a command nobody registered', () => {
        render(
            <NeedsALookList
                initial={{
                    items: [
                        item({ id: 'r', action: { label: 'Open', route: '/fleet/computers/n1' } }),
                        item({
                            id: 'x',
                            nodeId: 'n2',
                            action: { label: 'Fix', command: 'not-registered' },
                        }),
                    ],
                    partial: false,
                }}
                initialError={null}
                nodes={nodes}
            />,
        );
        const actions = screen.getAllByTestId('fleet-needs-a-look-action');
        expect(actions).toHaveLength(1);
        expect(actions[0]).toHaveAttribute('href', '/fleet/computers/n1');
    });

    it('runs a registered command and re-reads the list', async () => {
        const handler = vi.fn(async () => ({ ok: true }));
        registerNeedsALookCommand('clear-model-throttle', handler);
        fetchFleetNeedsALookAction.mockResolvedValue({
            success: true,
            data: { items: [], partial: false },
            error: null,
        });
        render(
            <NeedsALookList
                initial={{
                    items: [
                        item({
                            kind: 'node-throttled',
                            action: { label: 'Clear limit now', command: 'clear-model-throttle' },
                        }),
                    ],
                    partial: false,
                }}
                initialError={null}
                nodes={nodes}
            />,
        );
        await userEvent.click(screen.getByRole('button', { name: 'Clear limit now' }));
        await waitFor(() => expect(fetchFleetNeedsALookAction).toHaveBeenCalled());
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ kind: 'node-throttled' }));
        await waitFor(() =>
            expect(screen.getByTestId('fleet-needs-a-look-empty')).toBeInTheDocument(),
        );
    });

    it('says it could not load, offers Try again, and recovers (U11)', async () => {
        fetchFleetNeedsALookAction.mockResolvedValue({
            success: true,
            data: { items: [item()], partial: false },
            error: null,
        });
        render(<NeedsALookList initial={null} initialError="boom" nodes={nodes} />);
        expect(screen.getByTestId('fleet-needs-a-look-failed')).toHaveTextContent('failed');
        await userEvent.click(screen.getByTestId('fleet-needs-a-look-retry'));
        await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    });

    it('names an unknown computer generically rather than leaking its id', () => {
        render(
            <NeedsALookList
                initial={{ items: [item({ nodeId: 'gone' })], partial: false }}
                initialError={null}
                nodes={nodes}
            />,
        );
        expect(screen.getByText('unknownComputer')).toBeInTheDocument();
        expect(screen.queryByText('gone')).toBeNull();
    });
});

describe('NeedsALookList failures stay in the list (U11, review of PR 2)', () => {
    const throttled = item({
        kind: 'node-throttled',
        action: { label: 'Clear limit now', command: 'clear-model-throttle' },
    });

    it('says a command that threw, keeps the rows and frees the button', async () => {
        registerNeedsALookCommand(
            'clear-model-throttle',
            vi.fn(async () => Promise.reject(new Error('network'))),
        );
        render(
            <NeedsALookList
                initial={{ items: [throttled], partial: false }}
                initialError={null}
                nodes={nodes}
            />,
        );
        const button = screen.getByRole('button', { name: 'Clear limit now' });
        await userEvent.click(button);
        await waitFor(() =>
            expect(screen.getByTestId('fleet-needs-a-look-error')).toHaveTextContent(
                'commandFailed',
            ),
        );
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
        expect(button).not.toBeDisabled();
        expect(fetchFleetNeedsALookAction).not.toHaveBeenCalled();
    });

    it('says the error a command answered instead of treating it as done', async () => {
        registerNeedsALookCommand(
            'clear-model-throttle',
            vi.fn(async () => ({ ok: false, error: 'Node is offline' })),
        );
        render(
            <NeedsALookList
                initial={{ items: [throttled], partial: false }}
                initialError={null}
                nodes={nodes}
            />,
        );
        await userEvent.click(screen.getByRole('button', { name: 'Clear limit now' }));
        await waitFor(() =>
            expect(screen.getByTestId('fleet-needs-a-look-error')).toHaveTextContent(
                'Node is offline',
            ),
        );
        expect(fetchFleetNeedsALookAction).not.toHaveBeenCalled();
    });

    it('says a re-read that failed beside the rows it already had', async () => {
        registerNeedsALookCommand(
            'clear-model-throttle',
            vi.fn(async () => ({ ok: true })),
        );
        fetchFleetNeedsALookAction.mockRejectedValue(new Error('network'));
        render(
            <NeedsALookList
                initial={{ items: [throttled], partial: false }}
                initialError={null}
                nodes={nodes}
            />,
        );
        await userEvent.click(screen.getByRole('button', { name: 'Clear limit now' }));
        await waitFor(() =>
            expect(screen.getByTestId('fleet-needs-a-look-error')).toHaveTextContent('failed'),
        );
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
    });

    it('never announces "nothing" for a failed read, and says when the list is partial', () => {
        const { unmount } = render(
            <NeedsALookList initial={null} initialError="boom" nodes={nodes} />,
        );
        expect(screen.getByRole('heading')).not.toHaveTextContent('regionLabel');
        unmount();
        render(
            <NeedsALookList
                initial={{ items: [item()], partial: true }}
                initialError={null}
                nodes={nodes}
            />,
        );
        expect(screen.getByRole('heading')).toHaveTextContent('regionLabelPartial:1');
    });
});
