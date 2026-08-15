import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionDetailClient } from './SessionDetailClient';
import type { AgentRunSessionDetail, AgentRunTimelineEntry } from '@/lib/api/agents.shared';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

const getRunSessionDetailAction = vi.fn();
const steerAgentRunAction = vi.fn();
const interruptAgentRunAction = vi.fn();
const cancelAgentRunAction = vi.fn();
vi.mock('@/app/actions/agents', () => ({
    getRunSessionDetailAction: (...args: unknown[]) => getRunSessionDetailAction(...args),
    steerAgentRunAction: (...args: unknown[]) => steerAgentRunAction(...args),
    interruptAgentRunAction: (...args: unknown[]) => interruptAgentRunAction(...args),
    cancelAgentRunAction: (...args: unknown[]) => cancelAgentRunAction(...args),
}));

/**
 * Session detail (Feature K) — the drill-in client.
 *
 * The behaviours worth pinning are the ones a screenshot cannot show: the
 * captured previews reach the DOM as TEXT, pagination appends rather than
 * replaces, the live-follow poll only runs while the run is open and
 * follows from the last row it already holds, and the steering controls
 * are gated on the run still being steerable.
 */
const RUN_ID = '00000000-0000-0000-0000-0000000000aa';
const AGENT_ID = '00000000-0000-0000-0000-000000000001';

function entry(over: Partial<AgentRunTimelineEntry> = {}): AgentRunTimelineEntry {
    return {
        id: 'e1',
        kind: 'assistant-message',
        createdAt: '2026-08-14T10:00:00.000Z',
        text: 'Working on it.',
        toolName: null,
        callId: null,
        argsPreview: null,
        resultPreview: null,
        durationMs: null,
        isError: false,
        truncated: false,
        ...over,
    };
}

function detail(over: Partial<AgentRunSessionDetail> = {}): AgentRunSessionDetail {
    const run = {
        id: RUN_ID,
        agentId: AGENT_ID,
        status: 'running',
        triggerKind: 'task',
        taskId: null,
        workId: null,
        awaitingInput: false,
        queuedReason: null,
        attentionReason: null,
        runnerKind: 'claude-code',
        startedAt: '2026-08-14T10:00:00.000Z',
        finishedAt: null,
        durationMs: null,
        summary: null,
        errorMessage: null,
        currentActivity: 'Editing files',
        totalTokens: 12400,
        changedFilesCount: 2,
        costCents: 34,
        gateStatus: null,
        gateAttempts: 0,
        resolvedChecks: null,
        checkResults: null,
        persistent: false,
        terminalState: null,
        terminalEndedReason: null,
        terminalProviderId: null,
        sessionAttachable: false,
        createdAt: '2026-08-14T09:59:00.000Z',
        chatMessageId: null,
        memorySessionId: null,
    } as AgentRunSessionDetail['run'];
    return {
        run,
        counts: { messages: 7, toolCalls: 19, filesTouched: 2 },
        filesTouched: ['src/a.ts', 'src/b.ts'],
        timeline: { entries: [entry()], nextCursor: null, limit: 100 },
        ...over,
        ...(over.run ? { run: { ...run, ...over.run } } : {}),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('SessionDetailClient', () => {
    it('renders the counts chips, the touched-file list and the captured timeline', () => {
        render(
            <SessionDetailClient
                initialDetail={detail({
                    timeline: {
                        entries: [
                            entry(),
                            entry({
                                id: 'e2',
                                kind: 'tool-call',
                                text: null,
                                toolName: 'commitToRepo',
                                callId: 'call-9',
                                argsPreview: '{"message":"feat: pages"}',
                                resultPreview: '{"sha":"abc123"}',
                                durationMs: 4100,
                            }),
                        ],
                        nextCursor: null,
                        limit: 100,
                    },
                })}
                agentName="Builder"
                taskTitle={null}
            />,
        );

        expect(screen.getByTestId('session-detail-chips').textContent).toContain(
            'messagesChip:{"count":7}',
        );
        expect(screen.getByTestId('session-detail-chips').textContent).toContain(
            'toolCallsChip:{"count":19}',
        );
        expect(screen.getByText('src/a.ts')).toBeInTheDocument();
        expect(screen.getByText('Working on it.')).toBeInTheDocument();
        // Previews land as text nodes — never interpreted as markup.
        // The args preview shows twice: the collapsed summary line and the
        // expanded pane.
        expect(screen.getAllByText('{"message":"feat: pages"}').length).toBeGreaterThan(0);
        expect(screen.getByText('{"sha":"abc123"}')).toBeInTheDocument();
        expect(screen.getByTestId('session-timeline-tool-call').textContent).toContain('call-9');
    });

    it('⭐ renders sub-second tool calls at millisecond resolution, not as "0s"', () => {
        // Most tool calls finish in tens of ms. Rendering durationMs through
        // the RUN-scale formatter collapsed every one of them to "0s", which
        // makes the captured duration unreadable exactly where it matters.
        render(
            <SessionDetailClient
                initialDetail={detail({
                    timeline: {
                        entries: [
                            entry({
                                id: 'fast',
                                kind: 'tool-call',
                                text: null,
                                toolName: 'transitionTask',
                                durationMs: 41,
                            }),
                            entry({
                                id: 'slow',
                                kind: 'tool-call',
                                text: null,
                                toolName: 'commitToRepo',
                                durationMs: 4100,
                            }),
                        ],
                        nextCursor: null,
                        limit: 100,
                    },
                })}
                agentName="Builder"
                taskTitle={null}
            />,
        );

        const rows = screen.getAllByTestId('session-timeline-tool-call');
        expect(rows[0].textContent).toContain('41ms');
        expect(rows[0].textContent).not.toContain('0s');
        // Second-scale calls keep the run-scale rendering.
        expect(rows[1].textContent).toContain('4s');
    });

    it('⭐ appends the next page instead of replacing the rows already shown', async () => {
        const user = userEvent.setup();
        getRunSessionDetailAction.mockResolvedValue({
            ...detail(),
            timeline: {
                entries: [entry({ id: 'e2', text: 'Second page.' })],
                nextCursor: null,
                limit: 1,
            },
        });

        render(
            <SessionDetailClient
                initialDetail={detail({
                    timeline: { entries: [entry()], nextCursor: '1000_e1', limit: 1 },
                })}
                agentName="Builder"
                taskTitle={null}
            />,
        );

        await user.click(screen.getByTestId('session-timeline-load-more'));

        await waitFor(() => expect(screen.getByText('Second page.')).toBeInTheDocument());
        expect(screen.getByText('Working on it.')).toBeInTheDocument();
        expect(getRunSessionDetailAction).toHaveBeenCalledWith(RUN_ID, { cursor: '1000_e1' });
        // Exhausted cursor ⇒ the button retires.
        expect(screen.queryByTestId('session-timeline-load-more')).toBeNull();
    });

    it('⭐ live-follows an open run from the last row it holds, and de-duplicates the edge', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        getRunSessionDetailAction.mockResolvedValue({
            ...detail(),
            timeline: {
                // The cursor row comes back again (inclusive-edge defence) plus one new row.
                entries: [entry(), entry({ id: 'e2', text: 'Fresh tail.' })],
                nextCursor: null,
                limit: 100,
            },
        });

        render(
            <SessionDetailClient initialDetail={detail()} agentName="Builder" taskTitle={null} />,
        );

        await vi.advanceTimersByTimeAsync(5_000);

        await waitFor(() => expect(screen.getByText('Fresh tail.')).toBeInTheDocument());
        expect(getRunSessionDetailAction).toHaveBeenCalledWith(RUN_ID, {
            cursor: `${new Date('2026-08-14T10:00:00.000Z').getTime()}_e1`,
        });
        // The re-returned cursor row is not duplicated.
        expect(screen.getAllByText('Working on it.')).toHaveLength(1);
    });

    it('⭐ the poll refreshes the header but never rewinds a reader who is mid-pagination', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        // Older pages are still unwalked (nextCursor present), so the poll
        // has no tail cursor to follow from. It must NOT reset the timeline
        // to page one — that would discard every "Load more" click.
        getRunSessionDetailAction.mockResolvedValue({
            ...detail(),
            run: { ...detail().run, currentActivity: 'Running checks' },
            counts: { messages: 9, toolCalls: 25, filesTouched: 2 },
            timeline: {
                entries: [entry({ id: 'zzz', text: 'Page one row.' })],
                nextCursor: '1000_zzz',
                limit: 1,
            },
        });

        render(
            <SessionDetailClient
                initialDetail={detail({
                    timeline: { entries: [entry()], nextCursor: '1000_e1', limit: 1 },
                })}
                agentName="Builder"
                taskTitle={null}
            />,
        );

        await vi.advanceTimersByTimeAsync(5_000);

        await waitFor(() =>
            expect(screen.getByTestId('session-detail-chips').textContent).toContain(
                'messagesChip:{"count":9}',
            ),
        );
        expect(screen.getByTestId('session-detail-activity')).toHaveTextContent('Running checks');
        expect(screen.getByText('Working on it.')).toBeInTheDocument();
        expect(screen.queryByText('Page one row.')).toBeNull();
    });

    it('⭐ fills in a timeline that was still empty when the page opened', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        // Drilling into a run whose capture rows have not landed yet (a
        // queued run, or one dispatched a second ago) is the MOST likely
        // moment to open this page. There is no tail row to follow from,
        // but there is also nothing to preserve — page one IS the tail, so
        // live-follow must adopt it rather than treating "no cursor" as
        // "the reader is mid-pagination".
        getRunSessionDetailAction.mockResolvedValue({
            ...detail(),
            timeline: {
                entries: [entry({ id: 'e1', text: 'First captured turn.' })],
                nextCursor: null,
                limit: 100,
            },
        });

        render(
            <SessionDetailClient
                initialDetail={detail({
                    timeline: { entries: [], nextCursor: null, limit: 100 },
                })}
                agentName="Builder"
                taskTitle={null}
            />,
        );

        expect(screen.getByTestId('session-timeline-empty')).toBeInTheDocument();

        await vi.advanceTimersByTimeAsync(5_000);

        await waitFor(() => expect(screen.getByText('First captured turn.')).toBeInTheDocument());
        // No row on screen ⇒ no cursor to follow from; the poll asks for page one.
        expect(getRunSessionDetailAction).toHaveBeenCalledWith(RUN_ID, {});
        expect(screen.queryByTestId('session-timeline-empty')).toBeNull();

        // …and the NEXT tick follows from the row it just adopted, so the
        // adopted page becomes a real tail rather than being re-fetched.
        getRunSessionDetailAction.mockResolvedValue({
            ...detail(),
            timeline: {
                entries: [entry({ id: 'e2', text: 'Second captured turn.' })],
                nextCursor: null,
                limit: 100,
            },
        });
        await vi.advanceTimersByTimeAsync(5_000);
        await waitFor(() => expect(screen.getByText('Second captured turn.')).toBeInTheDocument());
        expect(getRunSessionDetailAction).toHaveBeenLastCalledWith(RUN_ID, {
            cursor: `${new Date('2026-08-14T10:00:00.000Z').getTime()}_e1`,
        });
        expect(screen.getByText('First captured turn.')).toBeInTheDocument();
    });

    it('⭐ a finished run neither polls nor offers steering controls', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        render(
            <SessionDetailClient
                initialDetail={detail({
                    run: { status: 'completed' } as AgentRunSessionDetail['run'],
                })}
                agentName="Builder"
                taskTitle={null}
            />,
        );

        await vi.advanceTimersByTimeAsync(20_000);

        expect(getRunSessionDetailAction).not.toHaveBeenCalled();
        expect(screen.queryByTestId('session-detail-controls')).toBeNull();
    });

    it('steers the live run and reports what the API did with the message', async () => {
        const user = userEvent.setup();
        steerAgentRunAction.mockResolvedValue({ dispatched: 'injected', runId: RUN_ID });

        render(
            <SessionDetailClient initialDetail={detail()} agentName="Builder" taskTitle={null} />,
        );

        await user.type(screen.getByTestId('session-detail-steer-input'), 'target staging');
        await user.click(screen.getByTestId('session-detail-steer-send'));

        await waitFor(() =>
            expect(steerAgentRunAction).toHaveBeenCalledWith(AGENT_ID, RUN_ID, 'target staging'),
        );
        expect(await screen.findByTestId('session-detail-steer-notice')).toHaveTextContent(
            'steerQueued',
        );
    });

    it('surfaces a failing control action instead of swallowing it', async () => {
        const user = userEvent.setup();
        cancelAgentRunAction.mockRejectedValue(new Error('run already finished'));

        render(
            <SessionDetailClient initialDetail={detail()} agentName="Builder" taskTitle={null} />,
        );

        await user.click(screen.getByTestId('session-detail-cancel'));

        expect(await screen.findByTestId('session-detail-control-error')).toHaveTextContent(
            'run already finished',
        );
    });

    it('falls back to the changed-file COUNT when no explicit paths were captured', () => {
        render(
            <SessionDetailClient
                initialDetail={{
                    ...detail(),
                    filesTouched: [],
                    counts: { messages: 0, toolCalls: 0, filesTouched: 4 },
                }}
                agentName="Builder"
                taskTitle={null}
            />,
        );

        expect(screen.getByTestId('session-detail-files').textContent).toContain(
            'filesCountOnly:{"count":4}',
        );
    });
});
