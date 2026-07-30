import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskRunsHistory, formatDuration, formatTokens } from './TaskRunsHistory';
import type { AgentRunSession } from '@/lib/api/agents.shared';

/**
 * Run-driven lifecycle (kanban run cockpit M7) — the Runs history on
 * Task detail. A Task accretes many runs; this section is what makes
 * "did this ever work?" answerable without leaving the Task page.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));

const run = (overrides: Partial<AgentRunSession> = {}): AgentRunSession =>
    ({
        id: 'run-1',
        agentId: 'agent-abcdef12',
        status: 'completed',
        triggerKind: 'task',
        taskId: 't1',
        workId: 'w1',
        awaitingInput: false,
        queuedReason: null,
        runnerKind: null,
        startedAt: '2026-07-25T10:00:00.000Z',
        finishedAt: '2026-07-25T10:01:00.000Z',
        durationMs: 72_000,
        summary: 'Implemented the endpoint',
        errorMessage: null,
        currentActivity: null,
        totalTokens: 48_200,
        changedFilesCount: 3,
        costCents: null,
        gateStatus: 'green',
        gateAttempts: 1,
        resolvedChecks: null,
        checkResults: null,
        persistent: false,
        terminalState: null,
        terminalEndedReason: null,
        terminalProviderId: null,
        sessionAttachable: false,
        createdAt: '2026-07-25T09:59:00.000Z',
        ...overrides,
    }) as AgentRunSession;

describe('TaskRunsHistory', () => {
    it('renders nothing for a Task that never dispatched', () => {
        const { container } = render(<TaskRunsHistory runs={[]} />);
        expect(container.firstChild).toBeNull();
    });

    it('lists one row per run with the count', () => {
        render(<TaskRunsHistory runs={[run(), run({ id: 'run-2', status: 'failed' })]} />);
        expect(screen.getAllByTestId('task-run-history-row')).toHaveLength(2);
        expect(screen.getByTestId('task-runs-history-count').textContent).toBe('2');
    });

    it('carries the run status on the row for the board/QA to key off', () => {
        render(<TaskRunsHistory runs={[run({ status: 'failed' })]} />);
        const row = screen.getByTestId('task-run-history-row');
        expect(row.getAttribute('data-run-status')).toBe('failed');
    });

    it('shows the failure message on a failed run, not the summary', () => {
        render(
            <TaskRunsHistory
                runs={[
                    run({
                        status: 'failed',
                        errorMessage: 'Workspace finalize failed',
                        summary: 'should not be shown',
                    }),
                ]}
            />,
        );
        expect(screen.getByText('Workspace finalize failed')).toBeTruthy();
        expect(screen.queryByText('should not be shown')).toBeNull();
    });

    it('deep-links a failed run to its own row in the Agent activity log', () => {
        render(<TaskRunsHistory runs={[run({ status: 'failed', errorMessage: 'boom' })]} />);
        const link = screen.getByTestId('task-run-history-logs-link');
        expect(link.getAttribute('href')).toBe('/agents/agent-abcdef12/activity?run=run-1');
    });

    it('offers the logs link even when the failure carried no message', () => {
        render(<TaskRunsHistory runs={[run({ status: 'failed', errorMessage: null })]} />);
        expect(screen.getByTestId('task-run-history-logs-link')).toBeTruthy();
    });

    it('does not offer a logs link on a run that did not fail', () => {
        render(<TaskRunsHistory runs={[run()]} />);
        expect(screen.queryByTestId('task-run-history-logs-link')).toBeNull();
    });

    it('shows the summary on a completed run', () => {
        render(<TaskRunsHistory runs={[run()]} />);
        expect(screen.getByText('Implemented the endpoint')).toBeTruthy();
    });

    it('renders duration, tokens, changed files and the gate verdict', () => {
        render(<TaskRunsHistory runs={[run()]} />);
        const row = screen.getByTestId('task-run-history-row');
        expect(row.textContent).toContain('1m 12s');
        expect(row.textContent).toContain('48.2k tok');
        expect(row.textContent).toContain('±3');
        expect(row.textContent).toContain('gate: green');
    });

    it('omits telemetry a run never produced instead of printing zeros', () => {
        render(
            <TaskRunsHistory
                runs={[
                    run({
                        totalTokens: null,
                        changedFilesCount: null,
                        durationMs: null,
                        gateStatus: null,
                    }),
                ]}
            />,
        );
        const row = screen.getByTestId('task-run-history-row');
        expect(row.textContent).not.toContain('tok');
        expect(row.textContent).not.toContain('gate:');
        expect(row.textContent).not.toContain('±');
    });
});

describe('TaskRunsHistory paging', () => {
    const many = (count: number) =>
        Array.from({ length: count }, (_, i) => run({ id: `run-${i + 1}` }));

    it('renders every run inline while the history fits in one page', () => {
        render(<TaskRunsHistory runs={many(7)} />);
        expect(screen.getAllByTestId('task-run-history-row')).toHaveLength(7);
        expect(screen.queryByTestId('task-runs-history-tabs')).toBeNull();
    });

    it('splits into tabs of 7 past the eighth run', () => {
        render(<TaskRunsHistory runs={many(10)} />);
        expect(screen.getAllByTestId('task-runs-history-tab')).toHaveLength(2);
        expect(screen.getAllByTestId('task-run-history-row')).toHaveLength(7);
        // The count stays the TOTAL — tabs page the view, not the history.
        expect(screen.getByTestId('task-runs-history-count').textContent).toBe('10');
    });

    it('shows the remaining runs on the last tab', async () => {
        const user = userEvent.setup();
        render(<TaskRunsHistory runs={many(10)} />);
        await user.click(screen.getAllByTestId('task-runs-history-tab')[1]);
        expect(screen.getAllByTestId('task-run-history-row')).toHaveLength(3);
    });

    it('moves between tabs with the arrow keys', async () => {
        const user = userEvent.setup();
        render(<TaskRunsHistory runs={many(15)} />);
        const tabs = screen.getAllByTestId('task-runs-history-tab');
        expect(tabs).toHaveLength(3);
        tabs[0].focus();
        await user.keyboard('{ArrowRight}');
        expect(
            screen.getAllByTestId('task-runs-history-tab')[1].getAttribute('aria-selected'),
        ).toBe('true');
        // Wraps around rather than dead-ending on the last tab.
        await user.keyboard('{End}');
        expect(
            screen.getAllByTestId('task-runs-history-tab')[2].getAttribute('aria-selected'),
        ).toBe('true');
        await user.keyboard('{ArrowRight}');
        expect(
            screen.getAllByTestId('task-runs-history-tab')[0].getAttribute('aria-selected'),
        ).toBe('true');
    });

    it('keeps only the selected tab in the tab order', () => {
        render(<TaskRunsHistory runs={many(10)} />);
        const tabs = screen.getAllByTestId('task-runs-history-tab');
        expect(tabs[0].getAttribute('tabindex')).toBe('0');
        expect(tabs[1].getAttribute('tabindex')).toBe('-1');
    });
});

describe('formatTokens', () => {
    it('formats thousands and millions to 3 significant figures', () => {
        expect(formatTokens(48_200)).toBe('48.2k');
        expect(formatTokens(3_100_000)).toBe('3.1M');
        expect(formatTokens(940)).toBe('940');
    });

    it('returns null rather than "0" for absent telemetry', () => {
        expect(formatTokens(null)).toBeNull();
        expect(formatTokens(undefined)).toBeNull();
        expect(formatTokens(0)).toBeNull();
    });
});

describe('formatDuration', () => {
    it('formats sub-second, seconds and minutes', () => {
        expect(formatDuration(820)).toBe('820ms');
        expect(formatDuration(45_000)).toBe('45s');
        expect(formatDuration(72_000)).toBe('1m 12s');
    });

    it('returns null for absent or negative durations', () => {
        expect(formatDuration(null)).toBeNull();
        expect(formatDuration(-1)).toBeNull();
    });
});
