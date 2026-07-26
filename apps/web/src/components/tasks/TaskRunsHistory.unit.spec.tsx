import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
