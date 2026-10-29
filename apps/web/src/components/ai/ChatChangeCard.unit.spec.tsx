import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en.json';
import {
    createUserConfirmationCheck,
    type PendingConfirmation,
} from '@/lib/ai/tools/generated/confirmation';
import type { TaskChangeChain } from '@/app/actions/tasks';

/**
 * APW-08 T26 (ACC-08-24, spec §6.4, FR-44) — the chat's `request_app_change` card, through the
 * REAL English catalogue:
 *
 *  - the confirmation copy ("Start a change on Bookings? · Wren will work on it. An agent run
 *    will start; runs are billed to your workspace.") with Cancel / Start, whose Start message
 *    the server-side confirmation check honours for THIS card;
 *  - the reply and the chain states Run → Pull request → Build → Deployment → Live;
 *  - the poll: every 10 s, stopping at a settled chain and after 30 minutes without a change.
 */

const { getChain, getTarget, sendMessage } = vi.hoisted(() => ({
    getChain: vi.fn(),
    getTarget: vi.fn(),
    sendMessage: vi.fn(),
}));

vi.mock('@/app/actions/tasks', () => ({ getTaskChangeChainAction: getChain }));
vi.mock('@/app/actions/dashboard/app-changes', () => ({ getAppChangeTargetAction: getTarget }));
vi.mock('./ChatProvider', () => ({ useChatContext: () => ({ sendMessage }) }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
}));

import {
    CHANGE_CARD_IDLE_MAX_MS,
    CHANGE_CARD_POLL_INTERVAL_MS,
    ChatChangeCard,
    changeChainSteps,
    isAppChangeCardOutput,
    isChangeChainSettled,
} from './ChatChangeCard';

const confirmCopy = messages.dashboard.workDetail.requestChange;
const copy = messages.dashboard.aiChat.changeCard;
const WORK = '6f1d2c3b-0000-4000-8000-000000000001';
const AGENT = '6f1d2c3b-0000-4000-8000-0000000000a1';
const CALL = 'call_abc123';

const args = {
    id: WORK,
    body: {
        request: 'Add an SMS reminder the day before a booking.',
        agentId: AGENT,
        channel: 'chat',
    },
};
const confirmation = {
    __confirmationRequired: true,
    toolName: 'request_app_change',
    action: 'Ask an agent to change an App Work',
    target: WORK,
    args,
    confirmationKind: 'destructive',
};
const answer = {
    success: true,
    data: {
        status: 'accepted',
        taskId: 'task-118',
        taskSlug: 'T-118',
        taskUrl: '/tasks/task-118',
        warnings: [],
    },
};

function chain(overrides: Partial<TaskChangeChain> = {}): TaskChangeChain {
    return {
        taskId: 'task-118',
        slug: 'T-118',
        title: 'Add an SMS reminder',
        status: 'in_progress',
        runStatus: 'running',
        prNumber: null,
        prState: null,
        deliveryState: null,
        ...overrides,
    };
}

function show(output: unknown, input: unknown = args) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <ChatChangeCard toolCallId={CALL} output={output} input={input} />
        </NextIntlClientProvider>,
    );
}

async function flush(ms = 0) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

const stepState = (step: string) =>
    screen.getByTestId(`chat-change-step-${step}`).getAttribute('data-state');

beforeEach(() => {
    getChain.mockReset();
    getTarget.mockReset();
    sendMessage.mockReset();
    getTarget.mockResolvedValue({ workName: 'Bookings', agentName: 'Wren' });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('ChatChangeCard — confirmation (spec §6.4)', () => {
    it('says what will happen, by name, and shows the request being confirmed', async () => {
        show(confirmation);
        await act(async () => undefined);
        const card = screen.getByTestId('chat-change-card-confirm');
        expect(card.textContent).toContain('Start a change on Bookings?');
        expect(card.textContent).toContain(
            'Wren will work on it. An agent run will start; runs are billed to your workspace.',
        );
        expect(screen.getByTestId('chat-change-card-request').textContent).toBe(args.body.request);
        expect(getTarget).toHaveBeenCalledWith(WORK, AGENT);
        expect(screen.getByTestId('chat-change-card-start').textContent).toBe(confirmCopy.start);
        expect(screen.getByTestId('chat-change-card-cancel').textContent).toBe(confirmCopy.cancel);
    });

    it('without names it still says it, unnamed', async () => {
        getTarget.mockResolvedValue({ workName: null, agentName: null });
        show({ ...confirmation, args: { id: WORK, body: { request: 'x' } } });
        await act(async () => undefined);
        const card = screen.getByTestId('chat-change-card-confirm');
        expect(card.textContent).toContain(confirmCopy.titleUnnamed);
        expect(card.textContent).toContain(confirmCopy.bodyNoAgent);
    });

    it("Start sends the confirmation the server honours for THIS card, and only this card's call", async () => {
        show(confirmation);
        fireEvent.click(screen.getByTestId('chat-change-card-start'));
        expect(sendMessage).toHaveBeenCalledTimes(1);
        const message = sendMessage.mock.calls[0][0] as string;
        expect(message).toBe(
            `Yes, I confirm — proceed with request_app_change for ${WORK} (confirmed: true, card ${CALL}).`,
        );

        const pending: PendingConfirmation[] = [
            { toolName: 'request_app_change', target: WORK, args, toolCallId: CALL },
        ];
        const check = createUserConfirmationCheck({ latestUserText: message, pending });
        expect(check('request_app_change', args)).toBe(true);
        // Another card for the same tool is not confirmed by this click.
        const other = createUserConfirmationCheck({
            latestUserText: message,
            pending: [{ ...pending[0], toolCallId: 'call_other' }],
        });
        expect(other('request_app_change', args)).toBe(false);

        expect(screen.getByTestId('chat-change-card-resolved').textContent).toBe(copy.starting);
    });

    it('Cancel tells the assistant to stand down', () => {
        show(confirmation);
        fireEvent.click(screen.getByTestId('chat-change-card-cancel'));
        expect(sendMessage).toHaveBeenCalledWith(
            `No, cancel request_app_change for ${WORK} — do not proceed.`,
        );
        expect(screen.getByTestId('chat-change-card-resolved').textContent).toBe(copy.cancelled);
    });
});

describe('ChatChangeCard — reply and chain (spec §6.4)', () => {
    it('says what was started and links the Task', async () => {
        vi.useFakeTimers();
        getChain.mockResolvedValue({ ok: true, chain: chain() });
        show(answer);
        await flush();
        const card = screen.getByTestId('chat-change-card-chain');
        expect(card.textContent).toContain('Started T-118 on Bookings.');
        expect(card.textContent).toContain('Add an SMS reminder');
        expect(getTarget).toHaveBeenCalledWith(WORK, null);
        expect(screen.getByTestId('chat-change-card-open-task').getAttribute('href')).toBe(
            '/tasks/task-118',
        );
        expect(stepState('run')).toBe('active');
        expect(stepState('pullRequest')).toBe('pending');
        // Every step says its state in text, not colour alone.
        expect(screen.getByTestId('chat-change-step-run').textContent).toContain(
            'Run: in progress',
        );
    });

    it.each([
        [
            chain({ runStatus: 'completed', prNumber: 7, prState: 'open' }),
            ['done', 'done', 'pending', 'pending', 'pending'],
        ],
        [
            chain({ prNumber: 7, prState: 'merged', deliveryState: 'merged' }),
            ['done', 'done', 'pending', 'pending', 'pending'],
        ],
        [
            chain({ prNumber: 7, deliveryState: 'building' }),
            ['done', 'done', 'active', 'pending', 'pending'],
        ],
        [
            chain({ prNumber: 7, deliveryState: 'build_failed' }),
            ['done', 'done', 'failed', 'pending', 'pending'],
        ],
        [
            chain({ prNumber: 7, deliveryState: 'built' }),
            ['done', 'done', 'done', 'pending', 'pending'],
        ],
        [
            chain({ prNumber: 7, deliveryState: 'deploying' }),
            ['done', 'done', 'done', 'active', 'pending'],
        ],
        [
            chain({ prNumber: 7, deliveryState: 'deploy_failed' }),
            ['done', 'done', 'done', 'failed', 'pending'],
        ],
        [
            chain({ prNumber: 7, deliveryState: 'live', status: 'done' }),
            ['done', 'done', 'done', 'done', 'done'],
        ],
        [chain({ runStatus: 'failed' }), ['failed', 'pending', 'pending', 'pending', 'pending']],
        [
            chain({ prNumber: 7, prState: 'closed' }),
            ['done', 'failed', 'pending', 'pending', 'pending'],
        ],
    ])('chain states %#', (value, expected) => {
        const steps = changeChainSteps(value);
        expect([steps.run, steps.pullRequest, steps.build, steps.deployment, steps.live]).toEqual(
            expected,
        );
    });

    it('a member request held for the owner says so', async () => {
        vi.useFakeTimers();
        getChain.mockResolvedValue({
            ok: true,
            chain: chain({ status: 'backlog', runStatus: null }),
        });
        show({ ...answer, data: { ...answer.data, awaitingOwner: true } });
        await flush();
        expect(screen.getByTestId('chat-change-card-chain').textContent).toContain(
            copy.awaitingOwner,
        );
    });

    it('only the confirmation and a filed Task are its outputs; a refusal is left to the generic result', () => {
        expect(isAppChangeCardOutput(confirmation)).toBe(true);
        expect(isAppChangeCardOutput(answer)).toBe(true);
        expect(isAppChangeCardOutput({ success: false, status: 409, code: 'agentRequired' })).toBe(
            false,
        );
        expect(isAppChangeCardOutput(null)).toBe(false);
    });
});

describe('ChatChangeCard — polling (FR-44)', () => {
    it('refreshes every 10 s', async () => {
        vi.useFakeTimers();
        getChain.mockResolvedValue({ ok: true, chain: chain() });
        show(answer);
        await flush();
        expect(getChain).toHaveBeenCalledTimes(1);
        await flush(CHANGE_CARD_POLL_INTERVAL_MS - 1);
        expect(getChain).toHaveBeenCalledTimes(1);
        await flush(1);
        expect(getChain).toHaveBeenCalledTimes(2);
    });

    it('stops once the change is live', async () => {
        vi.useFakeTimers();
        getChain
            .mockResolvedValueOnce({
                ok: true,
                chain: chain({ prNumber: 7, deliveryState: 'deploying' }),
            })
            .mockResolvedValue({
                ok: true,
                chain: chain({ prNumber: 7, deliveryState: 'live', status: 'done' }),
            });
        show(answer);
        await flush();
        await flush(CHANGE_CARD_POLL_INTERVAL_MS);
        expect(stepState('live')).toBe('done');
        await flush(CHANGE_CARD_POLL_INTERVAL_MS * 10);
        expect(getChain).toHaveBeenCalledTimes(2);
        expect(screen.queryByTestId('chat-change-card-polling-stopped')).toBeNull();
    });

    it('stops after 30 minutes without a change, and says so', async () => {
        vi.useFakeTimers();
        getChain.mockResolvedValue({
            ok: true,
            chain: chain({ prNumber: 7, deliveryState: 'building' }),
        });
        show(answer);
        await flush();
        const ticks = CHANGE_CARD_IDLE_MAX_MS / CHANGE_CARD_POLL_INTERVAL_MS;
        for (let i = 0; i < ticks; i++) await flush(CHANGE_CARD_POLL_INTERVAL_MS);
        const calls = getChain.mock.calls.length;
        expect(calls).toBe(1 + ticks);
        expect(screen.getByTestId('chat-change-card-polling-stopped').textContent).toBe(
            copy.pollingStopped,
        );

        for (let i = 0; i < 30; i++) await flush(CHANGE_CARD_POLL_INTERVAL_MS);
        expect(getChain).toHaveBeenCalledTimes(calls);
    });

    it('a change resets the 30 minutes: a chain that keeps moving keeps being followed', async () => {
        vi.useFakeTimers();
        let tick = 0;
        getChain.mockImplementation(async () => {
            tick += 1;
            // The run keeps changing for the first 20 minutes, then the build sits still.
            const state = tick <= 120 ? (tick % 2 ? 'building' : 'merged') : 'building';
            return { ok: true, chain: chain({ prNumber: 7, deliveryState: state as never }) };
        });
        show(answer);
        await flush();
        const ticks = CHANGE_CARD_IDLE_MAX_MS / CHANGE_CARD_POLL_INTERVAL_MS;
        for (let i = 0; i < ticks; i++) await flush(CHANGE_CARD_POLL_INTERVAL_MS);
        // 30 minutes after the card opened it is still polling: the last change was at 20.
        expect(screen.queryByTestId('chat-change-card-polling-stopped')).toBeNull();
        for (let i = 0; i < ticks; i++) await flush(CHANGE_CARD_POLL_INTERVAL_MS);
        expect(screen.getByTestId('chat-change-card-polling-stopped')).toBeTruthy();
    });

    it('settled: live, closed without deploying, cancelled, or done untracked', () => {
        expect(isChangeChainSettled(chain({ deliveryState: 'live' }))).toBe(true);
        expect(isChangeChainSettled(chain({ deliveryState: 'closed_without_deploy' }))).toBe(true);
        expect(isChangeChainSettled(chain({ status: 'cancelled' }))).toBe(true);
        expect(isChangeChainSettled(chain({ status: 'done', deliveryState: null }))).toBe(true);
        expect(isChangeChainSettled(chain({ status: 'in_review', deliveryState: 'merged' }))).toBe(
            false,
        );
        expect(isChangeChainSettled(chain({ status: 'done', deliveryState: 'deploying' }))).toBe(
            false,
        );
    });
});
