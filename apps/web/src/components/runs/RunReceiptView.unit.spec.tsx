import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { RunReceipt } from '@ever-works/contracts';
import { RunReceiptView } from './RunReceiptView';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
    useLocale: () => 'en-US',
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

/**
 * Run receipt (AW-09) — the itemised account of one run.
 *
 * What a screenshot cannot prove: an unknown cost never prints as $0.00, a
 * run with no summary or no Mission says so instead of leaving a hole, the
 * error block exists only for failures, an open run is labelled "so far",
 * aged-out usage shows the retention notice while the total stays, and run
 * text reaches the DOM as text.
 */

const RUN = '9f9f9f9f-6f6a-4c55-9a4c-1f2b3c4d5e6f';
const AGENT = '0b7e7c1e-6f6a-4c55-9a4c-1f2b3c4d5e6f';

function receipt(over: Partial<RunReceipt> = {}, row: Partial<RunReceipt['row']> = {}): RunReceipt {
    return {
        row: {
            id: RUN,
            agentId: AGENT,
            agentName: 'Ops',
            agentArchived: false,
            triggerKind: 'task',
            status: 'completed',
            startedAt: '2026-09-08T09:04:00.000Z',
            createdAt: '2026-09-08T09:03:59.000Z',
            finishedAt: '2026-09-08T09:08:55.000Z',
            durationMs: 295_000,
            costCents: 31,
            totalTokens: 81_094,
            summary: 'Reviewed 14 open pull requests, left review notes on 3 and merged 1.',
            errorMessage: null,
            currentActivity: null,
            taskId: 'task-1',
            taskTitle: 'Review open pull requests',
            missionId: 'mission-1',
            missionTitle: 'Ship the September release',
            workId: null,
            workName: null,
            scheduleKey: null,
            awaitingInput: false,
            queuedReason: null,
            attentionReason: null,
            ...row,
        },
        cost: {
            settledCents: 31,
            meteredCents: 31,
            soFar: false,
            creditsDebited: 12,
            detailRetained: true,
            tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: 81_094 },
            lines: [
                { capability: 'ai', modelId: 'model-a', calls: 3, units: 81_000, costCents: 29 },
                { capability: 'search', modelId: null, calls: 2, units: 2, costCents: 2 },
            ],
        },
        counts: { messages: 12, toolCalls: 5, filesTouched: 2 },
        filesTouched: ['docs/CHANGELOG.md', 'package.json'],
        captureTruncated: false,
        knowledge: [],
        ...over,
    };
}

describe('RunReceiptView', () => {
    it('renders the blocks in order: summary, cost, activity, files, related work', () => {
        render(<RunReceiptView receipt={receipt()} />);

        const order = [
            'run-receipt-summary',
            'run-receipt-cost',
            'run-receipt-activity',
            'run-receipt-files',
            'run-receipt-related',
        ].map((id) => screen.getByTestId(id));
        for (let i = 1; i < order.length; i += 1) {
            expect(
                order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
        }
        expect(screen.queryByTestId('run-receipt-error')).toBeNull();
        expect(screen.getByText(/Reviewed 14 open pull requests/)).toBeDefined();
    });

    it('says when no summary was recorded instead of rendering an empty block', () => {
        render(<RunReceiptView receipt={receipt({}, { summary: null })} />);
        expect(
            within(screen.getByTestId('run-receipt-summary')).getByText('noSummary'),
        ).toBeDefined();
    });

    it('shows the settled total, the metered lines and the credits from the usage records', () => {
        render(<RunReceiptView receipt={receipt()} />);
        const cost = screen.getByTestId('run-receipt-cost');

        expect(within(cost).getByText('cost')).toBeDefined();
        expect(within(cost).getAllByText('$0.31')).toHaveLength(2);
        expect(within(cost).getByText('credits:{"count":12}')).toBeDefined();
        expect(within(cost).getAllByTestId('run-receipt-cost-line')).toHaveLength(2);
        expect(within(cost).getByText('noModel')).toBeDefined();
        // The split is not reported yet — say so, do not print zeros.
        expect(within(cost).getByText('tokenSplitNotReported')).toBeDefined();
    });

    it('never prints $0.00 for a cost that was not attributed or credits that were not debited', () => {
        render(
            <RunReceiptView
                receipt={receipt({
                    cost: {
                        settledCents: null,
                        meteredCents: null,
                        soFar: false,
                        creditsDebited: null,
                        detailRetained: true,
                        tokens: {
                            input: null,
                            output: null,
                            cacheRead: null,
                            cacheWrite: null,
                            total: null,
                        },
                        lines: [],
                    },
                })}
            />,
        );
        const cost = screen.getByTestId('run-receipt-cost');

        expect(cost.textContent).not.toContain('$0.00');
        expect(within(cost).getByText('notAttributable')).toBeDefined();
        expect(within(cost).getByText('noUsage')).toBeDefined();
        expect(within(cost).getByText('noCredits')).toBeDefined();
        expect(within(cost).getByText('notReported')).toBeDefined();
    });

    it('labels the cost of a run that is still going as "so far"', () => {
        render(
            <RunReceiptView
                receipt={receipt(
                    {
                        cost: { ...receipt().cost, soFar: true, settledCents: null },
                    },
                    { status: 'running' },
                )}
            />,
        );
        expect(within(screen.getByTestId('run-receipt-cost')).getByText('costSoFar')).toBeDefined();
    });

    it('replaces the itemised lines with the retention notice and keeps the settled total', () => {
        render(
            <RunReceiptView
                receipt={receipt({
                    cost: { ...receipt().cost, detailRetained: false, lines: [] },
                })}
            />,
        );
        const cost = screen.getByTestId('run-receipt-cost');
        expect(within(cost).getByTestId('run-receipt-retention').textContent).toContain(
            'retentionNotice',
        );
        expect(within(cost).getByText('$0.31')).toBeDefined();
        expect(within(cost).queryAllByTestId('run-receipt-cost-line')).toHaveLength(0);
    });

    it('shows the exact (already redacted) error as text for a failed run only', () => {
        render(
            <RunReceiptView
                receipt={receipt(
                    {},
                    {
                        status: 'failed',
                        errorMessage: '<img src=x onerror=alert(1)> [redacted secret]',
                    },
                )}
            />,
        );
        const error = screen.getByTestId('run-receipt-error');
        expect(error.textContent).toContain('<img src=x onerror=alert(1)> [redacted secret]');
        expect(error.querySelector('img')).toBeNull();
    });

    it('says a run was not part of a Mission and still links the Agent', () => {
        render(
            <RunReceiptView
                receipt={receipt({}, { missionId: null, missionTitle: null, taskId: null })}
            />,
        );
        const related = screen.getByTestId('run-receipt-related');
        expect(within(related).getByTestId('run-receipt-no-mission').textContent).toBe('noMission');
        expect(
            within(related)
                .getAllByRole('link')
                .map((link) => link.getAttribute('href')),
        ).toEqual([`/agents/${AGENT}`]);
    });

    it('links the Mission, Task and the schedule behind a scheduled run', () => {
        render(
            <RunReceiptView receipt={receipt({}, { scheduleKey: `agent_heartbeat:${AGENT}` })} />,
        );
        const hrefs = within(screen.getByTestId('run-receipt-related'))
            .getAllByRole('link')
            .map((link) => link.getAttribute('href'));
        expect(hrefs).toEqual(
            expect.arrayContaining([
                '/missions/mission-1',
                '/tasks/task-1',
                `/agents/${AGENT}`,
                '/activity?view=schedules',
            ]),
        );
    });

    it('marks a capped capture and links the full session unless already on it', () => {
        const { rerender } = render(
            <RunReceiptView receipt={receipt({ captureTruncated: true })} />,
        );
        const activity = screen.getByTestId('run-receipt-activity');
        expect(within(activity).getByText('captureCapped')).toBeDefined();
        expect(screen.getByTestId('run-receipt-session-link').getAttribute('href')).toBe(
            `/agents/activity/${RUN}`,
        );

        rerender(<RunReceiptView receipt={receipt()} showSessionLink={false} />);
        expect(screen.queryByTestId('run-receipt-session-link')).toBeNull();
    });

    it('lists cited Knowledge Base documents only when the run cited some', () => {
        const { rerender } = render(<RunReceiptView receipt={receipt()} />);
        expect(screen.queryByTestId('run-receipt-knowledge')).toBeNull();

        rerender(
            <RunReceiptView
                receipt={receipt({
                    knowledge: [
                        {
                            documentId: 'doc-1',
                            workId: 'work-1',
                            relevanceScore: 0.82,
                            citedAt: '2026-09-08T09:05:00.000Z',
                        },
                    ],
                })}
            />,
        );
        const knowledge = screen.getByTestId('run-receipt-knowledge');
        expect(within(knowledge).getByRole('link').getAttribute('href')).toBe('/works/work-1/kb');
        expect(within(knowledge).getByText('knowledgeRelevance:{"score":"0.82"}')).toBeDefined();
    });

    it('falls back to the changed-file count when paths were not recorded', () => {
        render(
            <RunReceiptView
                receipt={receipt({
                    filesTouched: [],
                    counts: { messages: 1, toolCalls: 0, filesTouched: 4 },
                })}
            />,
        );
        expect(
            within(screen.getByTestId('run-receipt-files')).getByText('filesCountOnly:{"count":4}'),
        ).toBeDefined();
    });
});
