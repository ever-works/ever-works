import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskRunControls } from './TaskRunControls';
import type { AgentRunSession } from '@/lib/api/agents.shared';

/**
 * Run cockpit on Task detail (Wave 4 M5/M8) — the self-build slice Q
 * state: a run a FLEET node parked on an owner question. The Inbox reply
 * is the one path that delivers the answer, so the strip must show the
 * question and send the human there INSTEAD of the free-text Resume,
 * while every pre-existing state keeps rendering exactly as before.
 */

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...props}>
            {children}
        </a>
    ),
}));

vi.mock('@/app/actions/agents', () => ({
    interruptAgentRunAction: vi.fn(),
    resumeAgentRunAction: vi.fn(),
    steerAgentRunAction: vi.fn(),
}));

const run = (overrides: Partial<AgentRunSession> = {}): AgentRunSession =>
    ({
        id: 'run-1',
        agentId: 'agent-1',
        status: 'completed',
        triggerKind: 'task',
        taskId: 't1',
        workId: 'w1',
        awaitingInput: true,
        queuedReason: null,
        runnerKind: 'node',
        startedAt: '2026-09-03T10:00:00.000Z',
        finishedAt: '2026-09-03T10:05:00.000Z',
        durationMs: 300_000,
        summary: 'Paused with a question for the owner: Use Postgres?',
        errorMessage: null,
        currentActivity: null,
        totalTokens: null,
        changedFilesCount: 2,
        costCents: null,
        gateStatus: null,
        gateAttempts: 0,
        resolvedChecks: null,
        checkResults: null,
        persistent: false,
        terminalState: null,
        terminalEndedReason: null,
        terminalProviderId: null,
        sessionAttachable: false,
        createdAt: '2026-09-03T09:59:00.000Z',
        ...overrides,
    }) as AgentRunSession;

const QUESTION = { id: 'i1', title: 'Use Postgres or SQLite for the new store?' };

describe('TaskRunControls — parked on a fleet question (slice Q)', () => {
    it('shows the question and the Inbox link instead of the Resume form', () => {
        render(<TaskRunControls run={run()} openQuestion={QUESTION} />);

        const banner = screen.getByTestId('task-run-open-question');
        expect(banner.textContent).toContain(
            'dashboard.tasksPage.detail.runControls.waitingForAnswer',
        );
        expect(screen.getByTestId('task-run-open-question-title').textContent).toBe(QUESTION.title);
        expect(banner.textContent).toContain(
            'dashboard.tasksPage.detail.runControls.parkedHintQuestion',
        );

        const link = screen.getByTestId('task-run-open-question-link');
        expect(link.getAttribute('href')).toContain('/inbox?id=i1');
        expect(link.textContent).toContain('dashboard.tasksPage.detail.runControls.answerInInbox');

        // The free-text Resume is HIDDEN: a resume from here would start a
        // run that never sees the Inbox answer and leave the item open.
        expect(screen.queryByTestId('task-run-steer-input')).toBeNull();
        expect(screen.queryByTestId('task-run-resume')).toBeNull();
        expect(screen.queryByText('dashboard.tasksPage.detail.runControls.parkedHint')).toBeNull();

        // The awaiting badge is unchanged.
        expect(screen.getByTestId('task-run-awaiting-badge')).toBeTruthy();
    });

    it('URL-encodes the Inbox item id in the deep link', () => {
        render(<TaskRunControls run={run()} openQuestion={{ id: 'a b&c', title: 'q' }} />);
        expect(screen.getByTestId('task-run-open-question-link').getAttribute('href')).toBe(
            '/inbox?id=a%20b%26c',
        );
    });

    it('keeps the classic Resume form for an awaiting run with no known question', () => {
        render(<TaskRunControls run={run()} />);
        expect(screen.queryByTestId('task-run-open-question')).toBeNull();
        expect(screen.getByTestId('task-run-steer-input')).toBeTruthy();
        expect(screen.getByTestId('task-run-resume')).toBeTruthy();
        expect(screen.getByText('dashboard.tasksPage.detail.runControls.parkedHint')).toBeTruthy();

        // An explicit null behaves identically to the prop being absent.
        const explicit = render(<TaskRunControls run={run({ id: 'run-2' })} openQuestion={null} />);
        expect(explicit.queryByTestId('task-run-open-question')).toBeNull();
    });

    it('keeps the steer controls on a LIVE run even when a question is listed', () => {
        // The resumed run is already going; a stale open question in the
        // list must not hide the controls that steer it.
        render(
            <TaskRunControls
                run={run({ status: 'running', awaitingInput: false, finishedAt: null })}
                openQuestion={QUESTION}
            />,
        );
        expect(screen.queryByTestId('task-run-open-question')).toBeNull();
        expect(screen.getByTestId('task-run-steer-input')).toBeTruthy();
        expect(screen.getByTestId('task-run-steer-submit')).toBeTruthy();
        expect(screen.getByTestId('task-run-interrupt')).toBeTruthy();
        expect(screen.getByText('dashboard.tasksPage.detail.runControls.liveHint')).toBeTruthy();
    });

    it('ignores the question on a finished run that is not awaiting input', () => {
        // Answered already, or dismissed: the run row no longer waits, so
        // the strip falls back to its usual "nothing actionable" verdict.
        const { container } = render(
            <TaskRunControls run={run({ awaitingInput: false })} openQuestion={QUESTION} />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('still renders the Attach link next to the question banner when the session is joinable', () => {
        render(<TaskRunControls run={run({ sessionAttachable: true })} openQuestion={QUESTION} />);
        expect(screen.getByTestId('task-run-open-question')).toBeTruthy();
        expect(screen.getByTestId('task-run-attach').getAttribute('href')).toContain(
            '/agents/agent-1/terminal?run=run-1',
        );
    });

    it('renders nothing without a run', () => {
        const { container } = render(<TaskRunControls run={null} openQuestion={QUESTION} />);
        expect(container.firstChild).toBeNull();
    });
});
