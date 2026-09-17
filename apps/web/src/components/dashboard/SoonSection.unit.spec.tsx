import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { HomeScheduleKind, HomeScheduleRow, HomeToday } from '@ever-works/contracts';

import messages from '../../../messages/en.json';
import { SoonSection } from './SoonSection';

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

function row(overrides: Partial<HomeScheduleRow> = {}): HomeScheduleRow {
    return {
        id: 'agent_heartbeat:a-1',
        kind: 'agent_heartbeat',
        name: 'Daily sweep',
        href: '/agents/a-1',
        at: '2026-09-14T15:00:00.000Z',
        state: 'due',
        status: 'active',
        ...overrides,
    };
}

function renderSection(props: Parameters<typeof SoonSection>[0]) {
    const errors: unknown[] = [];
    const utils = render(
        <NextIntlClientProvider
            locale="en"
            messages={messages}
            timeZone="UTC"
            onError={(e) => errors.push(e)}
        >
            <SoonSection {...props} />
        </NextIntlClientProvider>,
    );
    return { ...utils, errors };
}

describe('SoonSection — Today panel', () => {
    it('labels every one of the seven schedule kinds', () => {
        const kinds: Array<[HomeScheduleKind, string]> = [
            ['recurring_task', 'recurring task'],
            ['agent_heartbeat', 'heartbeat'],
            ['work_schedule', 'work schedule'],
            ['mission_tick', 'mission tick'],
            ['source_validation', 'source check'],
            ['data_sync', 'data sync'],
            ['inbound_trigger', 'trigger'],
        ];
        const today: HomeToday = {
            ran: [],
            due: kinds.map(([kind], index) => row({ id: `${kind}:x`, kind, name: `Row ${index}` })),
            dueTotal: 7,
        };
        const { errors } = renderSection({ today, timeZone: 'UTC' });

        const rows = screen.getAllByTestId('dashboard-soon-today-row');
        expect(rows).toHaveLength(7);
        kinds.forEach(([, label], index) => {
            expect(rows[index]).toHaveTextContent(label);
        });
        expect(errors).toEqual([]);
    });

    it('lists what ran above a rule, then what is due, with local times', () => {
        const today: HomeToday = {
            ran: [
                row({
                    id: 'sweep',
                    name: 'Daily sweep',
                    at: '2026-09-14T06:15:00.000Z',
                    state: 'ran',
                }),
            ],
            due: [row({ id: 'check', name: 'Catalog check', at: '2026-09-14T18:00:00.000Z' })],
            dueTotal: 1,
        };
        renderSection({ today, timeZone: 'UTC' });

        const ran = screen.getByRole('list', { name: 'Already ran today' });
        expect(within(ran).getByText('Daily sweep')).toBeInTheDocument();
        expect(within(ran).getByText('ran at 06:15')).toBeInTheDocument();
        const rows = screen.getAllByTestId('dashboard-soon-today-row');
        expect(rows.map((element) => element.getAttribute('data-state'))).toEqual(['ran', 'due']);
        expect(rows[1]).toHaveTextContent('18:00');
    });

    it('renders times on the wall clock of the summary timezone', () => {
        renderSection({
            today: { ran: [], due: [row({ at: '2026-09-14T15:00:00.000Z' })], dueTotal: 1 },
            timeZone: 'Europe/Kyiv',
        });
        expect(screen.getByTestId('dashboard-soon-today-row')).toHaveTextContent('18:00');
    });

    it('links to the full schedule view with the exact remainder', () => {
        const due = Array.from({ length: 6 }, (_, index) => row({ id: `d-${index}` }));
        renderSection({ today: { ran: [], due, dueTotal: 8 }, timeZone: 'UTC' });

        expect(screen.getByTestId('dashboard-soon-today-more')).toHaveTextContent('+2 more');
        expect(screen.getByTestId('dashboard-soon-today-more')).toHaveAttribute(
            'href',
            '/activity?view=schedules',
        );
    });

    it('shows paused and error chips as text', () => {
        renderSection({
            today: {
                ran: [],
                due: [row({ id: 'p', status: 'paused' }), row({ id: 'e', status: 'error' })],
                dueTotal: 2,
            },
            timeZone: 'UTC',
        });
        const rows = screen.getAllByTestId('dashboard-soon-today-row');
        expect(rows[0]).toHaveTextContent('paused');
        expect(rows[1]).toHaveTextContent('error');
    });

    it('says nothing is scheduled today when nothing ran and nothing is due', () => {
        renderSection({ today: { ran: [], due: [], dueTotal: 0 }, timeZone: 'UTC' });
        expect(screen.getByTestId('home-block-today-empty')).toHaveTextContent(
            'Nothing scheduled today.',
        );
        expect(screen.getByRole('link', { name: /Set something up/ })).toHaveAttribute(
            'href',
            '/activity?view=schedules',
        );
    });

    it('says nothing else is scheduled when something ran but nothing remains', () => {
        renderSection({
            today: { ran: [row({ state: 'ran' })], due: [], dueTotal: 0 },
            timeZone: 'UTC',
        });
        expect(screen.getByText('Nothing else scheduled today.')).toBeInTheDocument();
    });

    it('renders the error card when the schedule read failed (S10)', () => {
        renderSection({ today: null, failed: true });
        expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load today's schedule.");
    });
});

describe('SoonSection — upcoming runs', () => {
    it('still renders the soonest runs when given items, and nothing when empty', () => {
        const { container, unmount } = renderSection({ items: [], total: 0 });
        expect(container).toBeEmptyDOMElement();
        unmount();

        renderSection({
            items: [
                {
                    id: 'work_schedule:w-1',
                    sourceKind: 'work-schedule',
                    title: 'Weekly refresh',
                    nextRunAt: '2026-09-20T09:00:00.000Z',
                    href: '/works/w-1',
                },
            ],
            total: 1,
        });
        expect(screen.getByTestId('dashboard-soon')).toHaveTextContent('Coming up');
        expect(screen.getByText('Weekly refresh')).toBeInTheDocument();
    });
});
