import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { HomeDecisionRow, HomeSummaryDto } from '@ever-works/contracts';

import messages from '../../../messages/en.json';

const refresh = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ refresh }),
}));
vi.mock('@/lib/hooks/use-active-scope', () => ({
    useActiveScope: () => ({
        slug: 'acme',
        activeOrganization: { slug: 'acme', displayName: 'Acme', legalName: null },
    }),
}));
// The composer is the `/new` prompt + chips (`HomeStartComposer`), covered by
// its own spec and by `e2e/home-start.spec.ts`. Here it is a stub, so this
// spec can pin the STACK — the order of the blocks and their states — without
// dragging the composer's chat/attachment machinery in.
vi.mock('./HomeStartComposer', () => ({
    HomeStartComposer: () => <div data-testid="home-composer" />,
}));

import { HomeMorningStack, isFirstRunSummary } from './HomeMorningStack';

const HOUR = 60 * 60 * 1000;
const COMPUTED_AT = '2026-09-14T04:04:00.000Z'; // 07:04 in Europe/Kyiv

function decision(overrides: Partial<HomeDecisionRow> = {}): HomeDecisionRow {
    return {
        id: 'item-1',
        kind: 'question',
        title: 'Which category for these items?',
        agentName: 'Research',
        createdAt: '2026-09-14T03:44:00.000Z',
        waitingMs: 20 * 60 * 1000,
        blocking: false,
        options: null,
        ...overrides,
    };
}

function summary(overrides: Partial<HomeSummaryDto> = {}): HomeSummaryDto {
    return {
        computedAt: COMPUTED_AT,
        timezone: 'Europe/Kyiv',
        timezoneFallback: false,
        day: {
            date: '2026-09-14',
            from: '2026-09-13T21:00:00.000Z',
            to: '2026-09-14T21:00:00.000Z',
        },
        needsYou: {
            status: 'ok',
            data: {
                rows: [
                    decision({
                        id: 'esc',
                        kind: 'escalation',
                        title: 'Merge refused on T-241',
                        waitingMs: 4 * 24 * HOUR,
                    }),
                    decision({
                        id: 'appr',
                        kind: 'approval',
                        title: 'Publish the September notes',
                        waitingMs: 2 * HOUR,
                    }),
                    decision(),
                ],
                total: 3,
                overdueCount: 1,
                blockingCount: 0,
            },
        },
        glance: {
            status: 'ok',
            data: { needsYou: 3, workingNow: 2, doneToday: 7, failedToday: 1 },
        },
        today: { status: 'ok', data: { ran: [], due: [], dueTotal: 0 } },
        thisWeek: {
            status: 'ok',
            data: {
                windowDays: 7,
                totalCents: 1842,
                currency: 'usd',
                runsCount: 61,
                avgPerRunCents: 30,
                scope: { kind: 'organization' },
                accountCap: {
                    periodSpendCents: 3910,
                    periodCapCents: 5000,
                    percentUsed: 78.2,
                    blocked: false,
                    allowOverage: true,
                },
                everSpent: true,
            },
        },
        workingNow: {
            status: 'ok',
            data: {
                rows: [
                    {
                        runId: 'run-1',
                        agentId: 'a-1',
                        agentName: 'Research',
                        activity: 'Reading the September changelog',
                        startedAt: '2026-09-14T03:50:00.000Z',
                        elapsedMs: 14 * 60 * 1000,
                    },
                    {
                        runId: 'run-2',
                        agentId: 'a-2',
                        agentName: 'Writer',
                        activity: null,
                        startedAt: '2026-09-14T01:00:00.000Z',
                        elapsedMs: 3 * HOUR,
                    },
                ],
                total: 2,
            },
        },
        recentActivity: { status: 'ok', data: { entries: [] } },
        ...overrides,
    };
}

function renderStack(
    value: HomeSummaryDto | null,
    attentionItems = [] as Parameters<typeof HomeMorningStack>[0]['attentionItems'],
) {
    const errors: unknown[] = [];
    const utils = render(
        <NextIntlClientProvider
            locale="en"
            messages={messages}
            timeZone="UTC"
            onError={(e) => errors.push(e)}
        >
            <HomeMorningStack
                summary={value}
                attentionItems={attentionItems}
                jobRuntimeConfigured
                // The stats card is page data rather than morning-read data, so
                // the page passes it in; here it is a marker for the ordering.
                workspaceStats={<div data-testid="home-workspace-stats" />}
            />
        </NextIntlClientProvider>,
    );
    return { ...utils, errors };
}

describe('HomeMorningStack', () => {
    beforeEach(() => {
        refresh.mockReset();
    });

    it('renders the stack in the owner’s order, composer first and recent activity last', () => {
        const { errors } = renderStack(summary());

        // Owner 2026-09-18 — no greeting, no subtitle, no date line, no
        // "Times shown in UTC." footnote anywhere on the page.
        expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
        expect(screen.queryByTestId('home-greeting')).toBeNull();
        expect(screen.queryByTestId('home-score-line')).toBeNull();
        expect(screen.queryByTestId('home-timezone-footnote')).toBeNull();

        const order = [
            'home-composer',
            'home-workspace-stats',
            'home-block-needsYou',
            'home-block-workingNow',
            'home-block-today',
            'home-block-thisWeek',
            'home-block-recentActivity',
        ].map((id) => screen.getByTestId(id));

        for (let index = 1; index < order.length; index += 1) {
            expect(
                order[index - 1].compareDocumentPosition(order[index]) &
                    Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
        }
        expect(errors).toEqual([]);
    });

    it('shows each decision with its kind, waiting chip tone and the overdue suffix (S16)', () => {
        renderStack(summary());

        const rows = screen.getAllByTestId('home-decision-row');
        expect(rows[0]).toHaveTextContent('Escalation');
        expect(within(rows[0]).getByText('waiting 4d')).toHaveAttribute('data-tone', 'danger');
        expect(within(rows[1]).getByText('waiting 2h')).toHaveAttribute('data-tone', 'neutral');
        expect(within(rows[2]).getByText('waiting 20m')).toBeInTheDocument();
        expect(screen.getByTestId('home-needs-you-overdue')).toHaveTextContent(
            '1 waiting over 3 days',
        );
        expect(screen.getByTestId('home-needs-you-open-all')).toHaveTextContent('Open all (3)');
        expect(screen.getByTestId('home-needs-you-open-all')).toHaveAttribute(
            'href',
            '/inbox?view=decisions',
        );
    });

    it('keeps the exact total over the preview cap (S17)', () => {
        const base = summary();
        const rows = Array.from({ length: 5 }, (_, index) => decision({ id: `d-${index}` }));
        renderStack({
            ...base,
            needsYou: {
                status: 'ok',
                data: { rows, total: 14, overdueCount: 0, blockingCount: 0 },
            },
            glance: {
                status: 'ok',
                data: { needsYou: 14, workingNow: 0, doneToday: 0, failedToday: 0 },
            },
        });

        expect(screen.getAllByTestId('home-decision-row')).toHaveLength(5);
        expect(screen.getByTestId('home-needs-you-open-all')).toHaveTextContent('Open all (14)');
        expect(screen.getByText('9 more waiting')).toBeInTheDocument();
    });

    it('renders the platform failures under Also broken, outside the decision count', () => {
        renderStack(summary(), [
            {
                id: 'agent:a',
                kind: 'agent-error',
                severity: 'danger',
                label: 'Scraper',
                href: '/agents/a',
            },
        ]);
        const broken = screen.getByTestId('home-also-broken');
        expect(within(broken).getByRole('heading', { name: 'Also broken' })).toBeInTheDocument();
        expect(screen.getByTestId('home-needs-you-open-all')).toHaveTextContent('Open all (3)');
    });

    it('lists working runs with a fallback line, elapsed time and staleness chips (S6)', () => {
        renderStack(summary());
        const rows = screen.getAllByTestId('home-working-now-row');
        expect(rows[0]).toHaveTextContent('Research');
        expect(rows[0]).toHaveTextContent('14m');
        expect(rows[1]).toHaveTextContent('Working…');
        expect(rows[1]).toHaveTextContent('3h 0m');
        expect(within(rows[1]).getByText('still going')).toHaveAttribute('data-tone', 'warning');
        expect(screen.getByRole('region', { name: 'Working now (2)' })).toBeInTheDocument();
    });

    it('fails one block without touching the others, and retries by re-reading (S10)', () => {
        renderStack(summary({ today: { status: 'failed', errorKey: 'timeout', data: null } }));

        expect(screen.getByTestId('home-block-today')).toHaveAttribute('data-state', 'failed');
        expect(screen.getByTestId('home-block-needsYou')).toHaveAttribute('data-state', 'ready');
        within(screen.getByTestId('home-block-today'))
            .getByRole('button', { name: 'Retry' })
            .click();
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('keeps the composer usable when the whole summary failed (S11)', () => {
        renderStack(null, [
            {
                id: 'task:t',
                kind: 'task-blocked',
                severity: 'warning',
                label: 'Reconcile',
                href: '/tasks/t',
            },
        ]);
        expect(screen.getByTestId('home-summary-error')).toHaveTextContent(
            "We couldn't load your morning report.",
        );
        expect(screen.getByTestId('home-composer')).toBeInTheDocument();
        // The stats card is page data and survives a failed morning read.
        expect(screen.getByTestId('home-workspace-stats')).toBeInTheDocument();
        expect(screen.getByTestId('dashboard-attention')).toBeInTheDocument();
    });

    it('shows the first-run card for an account with nothing at all (S9)', () => {
        const empty = summary({
            needsYou: {
                status: 'ok',
                data: { rows: [], total: 0, overdueCount: 0, blockingCount: 0 },
            },
            glance: {
                status: 'ok',
                data: { needsYou: 0, workingNow: 0, doneToday: 0, failedToday: 0 },
            },
            thisWeek: { status: 'ok', data: { ...summary().thisWeek!.data!, everSpent: false } },
            workingNow: { status: 'ok', data: { rows: [], total: 0 } },
        });
        expect(isFirstRunSummary(empty)).toBe(true);
        renderStack(empty);

        expect(screen.getByTestId('home-first-run')).toHaveTextContent('Nothing yet.');
        expect(screen.getByRole('link', { name: 'Set up your first agent' })).toHaveAttribute(
            'href',
            '/agents/new',
        );
        // The composer and the workspace card lead, first run or not.
        expect(screen.getByTestId('home-composer')).toBeInTheDocument();
        expect(screen.getByTestId('home-workspace-stats')).toBeInTheDocument();
    });

    it('never reads a failed block as a first run', () => {
        const partial = summary({
            needsYou: { status: 'failed', errorKey: 'error', data: null },
            glance: {
                status: 'ok',
                data: { needsYou: 0, workingNow: 0, doneToday: 0, failedToday: 0 },
            },
        });
        expect(isFirstRunSummary(partial)).toBe(false);
    });
});
