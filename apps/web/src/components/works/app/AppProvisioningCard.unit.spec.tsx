import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../../messages/en.json';
import type {
    AppProvisioningState,
    AppProvisioningTaskView,
} from '@/lib/works/app-provisioning.shared';

/**
 * APW-04 T25/T27/T36 — the Provisioning card on the App Work Overview.
 *
 * Rendered with the REAL English catalogue, so the copy a member reads is what is
 * asserted, and with the three server actions mocked at their module boundary.
 */

const { getMock, startMock, cancelMock, toastMock } = vi.hoisted(() => ({
    getMock: vi.fn(),
    startMock: vi.fn(),
    cancelMock: vi.fn(),
    toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/app/actions/dashboard/app-provisioning', () => ({
    getAppProvisioningAction: getMock,
    startAppProvisioningAction: startMock,
    cancelAppProvisioningAction: cancelMock,
}));

vi.mock('sonner', () => ({ toast: toastMock }));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));

import { AppProvisioningCard } from './AppProvisioningCard';
import {
    APP_PROVISIONING_POLL_MS,
    provisioningHeadline,
    provisioningRefusalKey,
} from '@/lib/works/app-provisioning.shared';

function task(over: Partial<AppProvisioningTaskView> = {}): AppProvisioningTaskView {
    return {
        taskId: 't1',
        taskSlug: 'T-1',
        title: 'Provision: make Helpdesk build and run',
        status: 'in_progress',
        agentId: 'a1',
        prUrl: null,
        prState: null,
        createdAt: '2026-10-27T00:00:00.000Z',
        updatedAt: '2026-10-27T00:00:00.000Z',
        trigger: 'auto-create',
        awaitingOwner: false,
        ...over,
    };
}

function state(over: Partial<AppProvisioningState> = {}): AppProvisioningState {
    const active = over.active === undefined ? task() : over.active;
    return {
        active,
        recent: active ? [active] : [],
        canEdit: true,
        upstreamSmokeBroken: false,
        notStartedReason: null,
        ...over,
    };
}

function renderCard(initial: AppProvisioningState | null) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <AppProvisioningCard workId="w1" initialState={initial} />
        </NextIntlClientProvider>,
    );
}

const copy = (messages as any).dashboard.workDetail.appProvisioning;

beforeEach(() => {
    getMock.mockReset();
    startMock.mockReset();
    cancelMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('AppProvisioningCard', () => {
    it('renders nothing when the first read failed', () => {
        const { container } = renderCard(null);
        expect(container.querySelector('[data-testid="app-provisioning-card"]')).toBeNull();
    });

    it('shows the running headline, the trigger and the Task link', () => {
        renderCard(state({ active: task({ prUrl: 'https://github.com/me/app/pull/7' }) }));
        expect(screen.getByTestId('app-provisioning-headline').textContent).toBe(
            copy.headline.running,
        );
        expect(screen.getByText(copy.trigger.autoCreate)).toBeTruthy();
        expect(screen.getByTestId('app-provisioning-task-link').getAttribute('href')).toBe(
            '/tasks/t1',
        );
        expect(screen.getByTestId('app-provisioning-pr-link').getAttribute('href')).toBe(
            'https://github.com/me/app/pull/7',
        );
    });

    // C-12 (stored XSS): the provisioning Task's `prUrl` is written by the agent run, so
    // only a plain `https:` URL becomes the "Open pull request" link.
    it.each([
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox(1)',
        'https://user:pw@evil.invalid/pull/1',
    ])('shows no pull request link for a hostile prUrl %j', (prUrl) => {
        const { container } = renderCard(state({ active: task({ prUrl }) }));
        expect(screen.getByTestId('app-provisioning-task-link')).toBeTruthy();
        expect(screen.queryByTestId('app-provisioning-pr-link')).toBeNull();
        for (const anchor of container.querySelectorAll('a')) {
            const href = anchor.getAttribute('href') ?? '';
            expect(href).not.toMatch(/^\s*(javascript|data|vbscript):/i);
            expect(href).not.toContain('evil.invalid');
        }
    });

    it('a viewer sees the state and no action (ACC-04-32)', () => {
        renderCard(state({ canEdit: false }));
        expect(screen.getByTestId('app-provisioning-headline')).toBeTruthy();
        expect(screen.queryByTestId('app-provisioning-cancel')).toBeNull();
        expect(screen.queryByTestId('app-provisioning-restart')).toBeNull();
        expect(screen.queryByTestId('app-provisioning-start')).toBeNull();
    });

    it('shows the upstream-broke banner (T36) and the owner hold', () => {
        renderCard(
            state({
                active: task({ trigger: 'smoke-failed', awaitingOwner: true }),
                upstreamSmokeBroken: true,
            }),
        );
        expect(screen.getByTestId('app-provisioning-banner').textContent).toContain(
            copy.banner.upstreamBroke,
        );
        expect(screen.getByTestId('app-provisioning-headline').textContent).toBe(
            copy.headline.awaitingOwner,
        );
        expect(screen.getByTestId('app-provisioning-awaiting-owner')).toBeTruthy();
    });

    it('Provision asks first, then starts WITHOUT restart', async () => {
        startMock.mockResolvedValue({ success: true, data: { started: true } });
        getMock.mockResolvedValue({ success: true, data: state() });
        renderCard(state({ active: null, recent: [] }));

        fireEvent.click(screen.getByTestId('app-provisioning-start'));
        expect(screen.getByTestId('app-provisioning-dialog').getAttribute('data-kind')).toBe(
            'start',
        );
        expect(startMock).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.click(screen.getByTestId('app-provisioning-confirm'));
        });
        expect(startMock).toHaveBeenCalledWith('w1', {});
        expect(toastMock.success).toHaveBeenCalledWith(copy.toasts.start);
    });

    it('the running variant is the only one that sends restart: true', async () => {
        startMock.mockResolvedValue({ success: true, data: { started: true } });
        getMock.mockResolvedValue({ success: true, data: state() });
        renderCard(state());

        fireEvent.click(screen.getByTestId('app-provisioning-restart'));
        expect(screen.getByTestId('app-provisioning-dialog').getAttribute('data-kind')).toBe(
            'restart',
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-provisioning-confirm'));
        });
        expect(startMock).toHaveBeenCalledWith('w1', { restart: true });
    });

    it('a start refused as alreadyProvisioning reopens the running variant', async () => {
        startMock.mockResolvedValue({ success: false, code: 'alreadyProvisioning' });
        getMock.mockResolvedValue({ success: true, data: state() });
        renderCard(state({ active: null, recent: [task({ status: 'done' })] }));

        fireEvent.click(screen.getByTestId('app-provisioning-start'));
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-provisioning-confirm'));
        });
        await waitFor(() =>
            expect(screen.getByTestId('app-provisioning-dialog').getAttribute('data-kind')).toBe(
                'restart',
            ),
        );
        expect(startMock).toHaveBeenCalledWith('w1', {});
    });

    it('Cancel asks first, cancels, and says so', async () => {
        cancelMock.mockResolvedValue({ success: true, data: { status: 'cancelled' } });
        getMock.mockResolvedValue({
            success: true,
            data: state({ active: null, recent: [task({ status: 'cancelled' })] }),
        });
        renderCard(state());

        fireEvent.click(screen.getByTestId('app-provisioning-cancel'));
        expect(cancelMock).not.toHaveBeenCalled();
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-provisioning-confirm'));
        });
        expect(cancelMock).toHaveBeenCalledWith('w1');
        expect(toastMock.success).toHaveBeenCalledWith(copy.toasts.cancel);
        await waitFor(() =>
            expect(screen.getByTestId('app-provisioning-headline').textContent).toBe(
                copy.headline.cancelled,
            ),
        );
    });

    it('a refused cancel shows its own copy', async () => {
        cancelMock.mockResolvedValue({ success: false, code: 'nothingToCancel' });
        renderCard(state());
        fireEvent.click(screen.getByTestId('app-provisioning-cancel'));
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-provisioning-confirm'));
        });
        expect(toastMock.error).toHaveBeenCalledWith(copy.errors.nothingToCancel);
    });

    it(`polls every ${APP_PROVISIONING_POLL_MS} ms while open and stops once terminal (ACC-04-26)`, async () => {
        vi.useFakeTimers();
        getMock.mockResolvedValue({
            success: true,
            data: state({ active: null, recent: [task({ status: 'done' })] }),
        });
        renderCard(state());

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_PROVISIONING_POLL_MS);
        });
        expect(getMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('app-provisioning-headline').textContent).toBe(
            copy.headline.succeeded,
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_PROVISIONING_POLL_MS * 3);
        });
        expect(getMock).toHaveBeenCalledTimes(1);
    });

    it('never polls a terminal state', async () => {
        vi.useFakeTimers();
        renderCard(state({ active: null, recent: [task({ status: 'done' })] }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_PROVISIONING_POLL_MS * 3);
        });
        expect(getMock).not.toHaveBeenCalled();
    });
});

describe('app-provisioning.shared', () => {
    it('explains a Work that was never provisioned', () => {
        expect(provisioningHeadline(state({ active: null, recent: [] }))).toBe('notStarted');
        expect(
            provisioningHeadline(
                state({ active: null, recent: [], notStartedReason: 'blueprintSpec' }),
            ),
        ).toBe('blueprintSpec');
        expect(
            provisioningHeadline(
                state({ active: null, recent: [], notStartedReason: 'autoProvisionOff' }),
            ),
        ).toBe('autoProvisionOff');
    });

    it('maps every headline and refusal to a leaf that exists', () => {
        for (const status of [
            'backlog',
            'todo',
            'in_progress',
            'in_review',
            'blocked',
            'done',
            'cancelled',
        ]) {
            const key = provisioningHeadline(state({ active: task({ status }) }));
            expect(copy.headline[key]).toEqual(expect.any(String));
        }
        for (const code of [
            'alreadyProvisioning',
            'nothingToCancel',
            'cancelRefused',
            'notAppWork',
            'not_found',
            'weird',
            undefined,
        ]) {
            const leaf = provisioningRefusalKey(code);
            expect(leaf).not.toContain('.');
            expect(copy.errors[leaf]).toEqual(expect.any(String));
        }
    });
});
