import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { TaskDeliveryState, TaskDeliveryView } from '@ever-works/contracts';
import messages from '../../../messages/en.json';

/**
 * APW-08 T27 (ACC-08-17, 21, 22, 28) — the Task page's **Delivery** section, through the REAL
 * English catalogue:
 *
 *  - the timeline, with the Build and Deployment links, the live URL, warnings and follow-ups;
 *  - the poll: every 10 s while the chain is open, stopping at a terminal state and 30 minutes
 *    after the page opened;
 *  - **Close anyway**: confirmed first, and focus goes back where it came from (the button, or
 *    the heading once the change is closed and the button is gone); a refusal by its code;
 *  - **Try once more**: only while the change's delivery-failed Inbox item is open.
 */

const { getDelivery, closeDelivery, followUp } = vi.hoisted(() => ({
    getDelivery: vi.fn(),
    closeDelivery: vi.fn(),
    followUp: vi.fn(),
}));

vi.mock('@/app/actions/tasks', () => ({
    getTaskDeliveryAction: getDelivery,
    closeDeliveryAction: closeDelivery,
    openDeliveryFollowUpAction: followUp,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
}));

import {
    DELIVERY_POLL_INTERVAL_MS,
    DELIVERY_POLL_MAX_MS,
    TaskDeliverySection,
    deliveryErrorKey,
} from './TaskDeliverySection';

const copy = messages.dashboard.tasksPage.delivery;
const MERGE = '3f9c2ab0000000000000000000000000000000aa';

function view(
    state: TaskDeliveryState,
    overrides: Partial<TaskDeliveryView> = {},
): TaskDeliveryView {
    return {
        taskId: 'task-1',
        state,
        mergeCommitSha: MERGE,
        pullRequest: {
            number: 42,
            url: 'https://github.com/acme/bookings/pull/42',
            base: 'production',
            mergedAt: '2026-10-29T10:02:00.000Z',
        },
        build: {
            id: 'b-1',
            number: 57,
            status: 'succeeded',
            commitSha: MERGE,
            logsUrl: 'https://github.com/acme/bookings/actions/runs/57',
        },
        deployment: { id: 'd-1', number: 31, status: 'READY', outcome: null },
        liveUrl: null,
        liveWithWarnings: false,
        carriedByLaterChange: false,
        followUps: [],
        history: [{ state: 'merged', at: '2026-10-29T10:02:00.000Z', activityId: null }],
        ...overrides,
    };
}

const ready = (v: TaskDeliveryView, retryEscalationId: string | null = null) => ({
    ok: true as const,
    view: v,
    retryEscalationId,
});

function renderSection() {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <TaskDeliverySection taskId="task-1" workId="work-1" />
        </NextIntlClientProvider>,
    );
}

/** Let the pending server-action promises settle under fake timers. */
async function flush(ms = 0) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

beforeEach(() => {
    getDelivery.mockReset();
    closeDelivery.mockReset();
    followUp.mockReset();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('TaskDeliverySection — the timeline (APW-08 T27)', () => {
    it('shows the merge, the Build with its links, the Deployment, the live URL and warnings', async () => {
        getDelivery.mockResolvedValue(
            ready(
                view('live', {
                    liveUrl: 'https://bookings.example.app',
                    liveWithWarnings: true,
                    followUps: [
                        { taskId: 'f-1', slug: 'T-121', status: 'cancelled', automatic: true },
                    ],
                }),
            ),
        );
        renderSection();

        await waitFor(() => expect(screen.getByTestId('task-delivery-timeline')).toBeTruthy());
        expect(screen.getByTestId('task-delivery-row-merged').textContent).toContain(
            'Pull request #42 merged into production',
        );
        expect(screen.getByTestId('task-delivery-row-build').textContent).toContain(
            'Build #57 of 3f9c2ab',
        );
        expect(screen.getByTestId('task-delivery-build-logs').getAttribute('href')).toBe(
            'https://github.com/acme/bookings/actions/runs/57',
        );
        expect(screen.getByTestId('task-delivery-builds-link').getAttribute('href')).toBe(
            '/works/work-1/builds',
        );
        expect(screen.getByTestId('task-delivery-row-deployment').textContent).toContain(
            'Deployment #31',
        );
        expect(screen.getByTestId('task-delivery-deployments-link').getAttribute('href')).toBe(
            '/works/work-1/deploy',
        );
        expect(screen.getByTestId('task-delivery-live-url').getAttribute('href')).toBe(
            'https://bookings.example.app',
        );
        expect(screen.getByTestId('task-delivery-live-url').textContent).toContain(
            'Live at https://bookings.example.app',
        );
        expect(screen.getByTestId('task-delivery-warnings').textContent).toBe(copy.warnings);
        expect(screen.getByTestId('task-delivery-chip').textContent).toContain(
            copy.chipLiveWarnings,
        );
        // The follow-up a later live deployment made unnecessary, with its Task status label.
        const followUpRow = screen.getByTestId('task-delivery-follow-up');
        expect(followUpRow.textContent).toContain('Follow-up: T-121 (Cancelled)');
        expect(followUpRow.textContent).toContain(copy.followUpCancelled);
        expect(followUpRow.querySelector('a')?.getAttribute('href')).toBe('/tasks/f-1');
        // A live change is not closable and offers no retry.
        expect(screen.queryByTestId('task-delivery-close')).toBeNull();
        expect(screen.queryByTestId('task-delivery-retry')).toBeNull();
    });

    it('a failed deployment names its outcome; an unsafe link is rendered as text', async () => {
        getDelivery.mockResolvedValue(
            ready(
                view('deploy_failed', {
                    deployment: {
                        id: 'd-1',
                        number: null,
                        status: 'ROLLED_BACK',
                        outcome: 'rolled_back',
                    },
                    build: {
                        id: 'b-1',
                        number: null,
                        status: 'succeeded',
                        commitSha: MERGE,
                        logsUrl: 'javascript:alert(1)',
                    },
                }),
            ),
        );
        renderSection();
        await waitFor(() => expect(screen.getByTestId('task-delivery-chip')).toBeTruthy());
        expect(screen.getByTestId('task-delivery-chip').textContent).toBe(
            'Deploy failed ✗ (rolled back)',
        );
        expect(screen.getByTestId('task-delivery-row-build').textContent).toContain(
            'Build of 3f9c2ab',
        );
        expect(screen.queryByTestId('task-delivery-build-logs')).toBeNull();
        expect(screen.getByTestId('task-delivery-row-deployment').textContent).toContain(
            copy.deploymentUnnumbered,
        );
        expect(screen.getByTestId('task-delivery-row-deployment').getAttribute('data-step')).toBe(
            'failed',
        );
    });

    it('says so when the first read fails', async () => {
        getDelivery.mockResolvedValue({ ok: false, code: 'DELIVERY_READ_FAILED' });
        renderSection();
        await waitFor(() => expect(screen.getByTestId('task-delivery-unavailable')).toBeTruthy());
        expect(screen.getByTestId('task-delivery-unavailable').textContent).toBe(copy.unavailable);
    });
});

describe('TaskDeliverySection — polling (APW-08 T27)', () => {
    it('re-reads every 10 s while the chain is open', async () => {
        vi.useFakeTimers();
        getDelivery.mockResolvedValue(ready(view('deploying')));
        renderSection();
        await flush();
        expect(getDelivery).toHaveBeenCalledTimes(1);

        await flush(DELIVERY_POLL_INTERVAL_MS - 1);
        expect(getDelivery).toHaveBeenCalledTimes(1);
        await flush(1);
        expect(getDelivery).toHaveBeenCalledTimes(2);
        await flush(DELIVERY_POLL_INTERVAL_MS);
        expect(getDelivery).toHaveBeenCalledTimes(3);
    });

    it('stops at a terminal state', async () => {
        vi.useFakeTimers();
        getDelivery
            .mockResolvedValueOnce(ready(view('deploying')))
            .mockResolvedValue(ready(view('live', { liveUrl: 'https://bookings.example.app' })));
        renderSection();
        await flush();
        await flush(DELIVERY_POLL_INTERVAL_MS);
        expect(getDelivery).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId('task-delivery-section').getAttribute('data-state')).toBe('live');

        await flush(DELIVERY_POLL_INTERVAL_MS * 10);
        expect(getDelivery).toHaveBeenCalledTimes(2);
        expect(screen.queryByTestId('task-delivery-polling-stopped')).toBeNull();
    });

    it('never polls a Task that is already closed without deploying', async () => {
        vi.useFakeTimers();
        getDelivery.mockResolvedValue(ready(view('closed_without_deploy')));
        renderSection();
        await flush();
        await flush(DELIVERY_POLL_INTERVAL_MS * 5);
        expect(getDelivery).toHaveBeenCalledTimes(1);
    });

    it('stops 30 minutes after the page opened, even while still open, and says so', async () => {
        vi.useFakeTimers();
        getDelivery.mockResolvedValue(ready(view('building')));
        renderSection();
        await flush();
        // One tick per act: React re-arms the timer after each read's render.
        const ticks = DELIVERY_POLL_MAX_MS / DELIVERY_POLL_INTERVAL_MS;
        for (let i = 0; i < ticks; i++) await flush(DELIVERY_POLL_INTERVAL_MS);
        const calls = getDelivery.mock.calls.length;
        // One read on open plus one every 10 s for 30 minutes — then nothing.
        expect(calls).toBe(1 + ticks);
        expect(screen.getByTestId('task-delivery-polling-stopped').textContent).toBe(
            copy.pollingStopped,
        );

        for (let i = 0; i < 30; i++) await flush(DELIVERY_POLL_INTERVAL_MS);
        expect(getDelivery).toHaveBeenCalledTimes(calls);
        expect(screen.getByTestId('task-delivery-polling-stopped').textContent).toBe(
            copy.pollingStopped,
        );
    });

    it('a failed poll keeps the last answer and still schedules the next read', async () => {
        vi.useFakeTimers();
        getDelivery
            .mockResolvedValueOnce(ready(view('deploying')))
            .mockResolvedValueOnce({ ok: false, code: 'DELIVERY_READ_FAILED' })
            .mockResolvedValue(ready(view('deploying')));
        renderSection();
        await flush();
        await flush(DELIVERY_POLL_INTERVAL_MS);
        expect(screen.getByTestId('task-delivery-section').getAttribute('data-state')).toBe(
            'deploying',
        );
        await flush(DELIVERY_POLL_INTERVAL_MS);
        expect(getDelivery).toHaveBeenCalledTimes(3);
    });
});

describe('TaskDeliverySection — Close anyway (APW-08 T27)', () => {
    async function openConfirm() {
        await waitFor(() => expect(screen.getByTestId('task-delivery-close')).toBeTruthy());
        const trigger = screen.getByTestId('task-delivery-close');
        trigger.focus();
        fireEvent.click(trigger);
        await screen.findByTestId('task-delivery-confirm-close');
        return trigger;
    }

    it('is labelled by the state: Close anyway for a failure, Close without deploying while waiting', async () => {
        getDelivery.mockResolvedValue(ready(view('build_failed')));
        renderSection();
        await waitFor(() =>
            expect(screen.getByTestId('task-delivery-close').textContent).toBe(copy.closeAnyway),
        );
        cleanup();

        getDelivery.mockResolvedValue(ready(view('built')));
        renderSection();
        await waitFor(() =>
            expect(screen.getByTestId('task-delivery-close').textContent).toBe(
                copy.closeWithoutDeploying,
            ),
        );
    });

    it('asks first; Keep open closes nothing and returns focus to the button', async () => {
        getDelivery.mockResolvedValue(ready(view('deploy_failed')));
        renderSection();
        const trigger = await openConfirm();

        expect(screen.getByText(copy.closeConfirm)).toBeTruthy();
        fireEvent.click(screen.getByTestId('task-delivery-keep-open'));

        await waitFor(() => expect(screen.queryByTestId('task-delivery-confirm-close')).toBeNull());
        expect(closeDelivery).not.toHaveBeenCalled();
        await waitFor(() => expect(document.activeElement).toBe(trigger));
    });

    it('confirming closes the change, and focus lands on the section heading once the button is gone', async () => {
        getDelivery.mockResolvedValue(ready(view('deploy_failed')));
        closeDelivery.mockResolvedValue({ ok: true, view: view('closed_without_deploy') });
        renderSection();
        await openConfirm();

        fireEvent.click(screen.getByTestId('task-delivery-confirm-close'));

        await waitFor(() => expect(closeDelivery).toHaveBeenCalledWith('task-1'));
        await waitFor(() =>
            expect(screen.getByTestId('task-delivery-chip').textContent).toBe(copy.chipClosed),
        );
        expect(screen.queryByTestId('task-delivery-close')).toBeNull();
        await waitFor(() =>
            expect(document.activeElement).toBe(
                screen.getByRole('heading', { name: copy.sectionTitle }),
            ),
        );
    });

    it('a refusal shows its copy by code, keeps the button and returns focus to it', async () => {
        getDelivery.mockResolvedValue(ready(view('deploy_failed')));
        closeDelivery.mockResolvedValue({ ok: false, code: 'notClosable', statusCode: 422 });
        renderSection();
        const trigger = await openConfirm();

        fireEvent.click(screen.getByTestId('task-delivery-confirm-close'));

        await waitFor(() =>
            expect(screen.getByTestId('task-delivery-error').textContent).toBe(
                copy.errors.notClosable,
            ),
        );
        expect(screen.getByTestId('task-delivery-close')).toBe(trigger);
        await waitFor(() => expect(document.activeElement).toBe(trigger));
    });

    it('maps only the known refusal codes to their copy', () => {
        expect(deliveryErrorKey('notClosable')).toBe('notClosable');
        expect(deliveryErrorKey('followUpLimit')).toBe('followUpLimit');
        expect(deliveryErrorKey('CLOSE_FAILED')).toBe('generic');
        expect(deliveryErrorKey(undefined)).toBe('generic');
    });
});

describe('TaskDeliverySection — Try once more (APW-08 T27)', () => {
    it('is offered only while the delivery-failed Inbox item is open', async () => {
        getDelivery.mockResolvedValue(ready(view('build_failed')));
        renderSection();
        await waitFor(() => expect(screen.getByTestId('task-delivery-close')).toBeTruthy());
        expect(screen.queryByTestId('task-delivery-retry')).toBeNull();
        cleanup();

        // An escalation id on a state that is not failed is ignored.
        getDelivery.mockResolvedValue(ready(view('built'), 'esc-1'));
        renderSection();
        await waitFor(() => expect(screen.getByTestId('task-delivery-close')).toBeTruthy());
        expect(screen.queryByTestId('task-delivery-retry')).toBeNull();
    });

    it('opens one more follow-up for that Inbox item and re-reads the chain', async () => {
        getDelivery.mockResolvedValue(ready(view('deploy_failed'), 'esc-1'));
        followUp.mockResolvedValue({ ok: true, taskId: 'f-2' });
        renderSection();

        fireEvent.click(await screen.findByTestId('task-delivery-retry'));

        await waitFor(() => expect(followUp).toHaveBeenCalledWith('task-1', 'esc-1'));
        await waitFor(() =>
            expect(screen.getByTestId('task-delivery-follow-up-opened').textContent).toBe(
                copy.followUpOpened,
            ),
        );
        expect(getDelivery).toHaveBeenCalledTimes(2);
    });

    it('past the limit it says so by code', async () => {
        getDelivery.mockResolvedValue(ready(view('deploy_failed'), 'esc-1'));
        followUp.mockResolvedValue({ ok: false, code: 'followUpLimit', statusCode: 422 });
        renderSection();

        fireEvent.click(await screen.findByTestId('task-delivery-retry'));

        await waitFor(() =>
            expect(screen.getByTestId('task-delivery-error').textContent).toBe(
                copy.errors.followUpLimit,
            ),
        );
    });
});
