import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstanceStatsOperatorStatus, InstanceStatsReportView } from '@ever-works/contracts';
import { UsageStatisticsSettings } from './UsageStatisticsSettings';

/**
 * Settings → Ever Platform → Anonymous usage statistics.
 *
 * Pins the three views (switched off by configuration, a member, the
 * operator), that the operator's *Last payload* is the stored bytes verbatim,
 * that the switch and *Send now* call their actions, that *Send now* is
 * disabled while statistics are off, and that the reset asks first.
 */

const actions = {
    getInstanceStatsStatusAction: vi.fn(),
    getInstanceStatsLastAction: vi.fn(),
    previewInstanceStatsAction: vi.fn(),
    resetInstanceStatsIdentityAction: vi.fn(),
    sendInstanceStatsNowAction: vi.fn(),
    setInstanceStatsEnabledAction: vi.fn(),
};
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
    useFormatter: () => ({ dateTime: (date: Date) => date.toISOString() }),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('sonner', () => ({
    toast: {
        error: (...args: unknown[]) => toastError(...args),
        success: (...args: unknown[]) => toastSuccess(...args),
    },
}));
vi.mock('@/app/actions/settings/instance-stats', () => ({
    getInstanceStatsStatusAction: (...args: unknown[]) =>
        actions.getInstanceStatsStatusAction(...args),
    getInstanceStatsLastAction: (...args: unknown[]) => actions.getInstanceStatsLastAction(...args),
    previewInstanceStatsAction: (...args: unknown[]) => actions.previewInstanceStatsAction(...args),
    resetInstanceStatsIdentityAction: (...args: unknown[]) =>
        actions.resetInstanceStatsIdentityAction(...args),
    sendInstanceStatsNowAction: (...args: unknown[]) => actions.sendInstanceStatsNowAction(...args),
    setInstanceStatsEnabledAction: (...args: unknown[]) =>
        actions.setInstanceStatsEnabledAction(...args),
}));
vi.mock('@/components/ui/dialog', () => ({
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
        open ? <div>{children}</div> : null,
    DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogClose: ({ onClose }: { onClose: () => void }) => (
        <button type="button" onClick={onClose}>
            close
        </button>
    ),
}));

function operator(over: Partial<InstanceStatsOperatorStatus> = {}): InstanceStatsOperatorStatus {
    return {
        operator: true,
        enabled: true,
        reason: 'on',
        uiEnabled: true,
        installSource: 'self-hosted',
        country: 'ZZ',
        statsApiUrl: 'https://api.ever.co',
        instanceId: '41b54444-0795-416c-bdb8-72fe2925a157',
        resetCount: 0,
        nextSendAt: '2026-10-16T08:00:00.000Z',
        sinkAvailable: true,
        lastReport: null,
        sendNowAvailableAt: null,
        ...over,
    };
}

const LAST: InstanceStatsReportView = {
    reportId: '63d8c277-7fa0-4f5d-a5a7-c88fc94e6186',
    period: '2026-10',
    final: false,
    status: 'sent',
    httpStatus: 202,
    errorCode: null,
    errors: [],
    attemptedAt: '2026-10-15T08:00:00.000Z',
    bytes: 31,
    payload: '{"schema":"ever.stats.v1","x":1}',
};

describe('UsageStatisticsSettings', () => {
    beforeEach(() => {
        Object.values(actions).forEach((fn) => fn.mockReset());
        toastError.mockReset();
        toastSuccess.mockReset();
        actions.getInstanceStatsStatusAction.mockResolvedValue({ success: true, data: operator() });
        actions.getInstanceStatsLastAction.mockResolvedValue({ success: true, data: LAST });
    });

    it('names the configuration switch when the API has the module off', () => {
        render(<UsageStatisticsSettings state="off" initialStatus={null} initialLast={null} />);
        expect(screen.getByTestId('usage-statistics-env-off').textContent).toBe(
            'statistics.offByConfiguration',
        );
        expect(screen.queryByTestId('usage-statistics-operator')).toBeNull();
    });

    it('shows a member whether statistics are on and who manages them — no controls, no payload', () => {
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={{ enabled: true }}
                initialLast={null}
            />,
        );
        expect(screen.getByTestId('usage-statistics-member').textContent).toContain(
            'statistics.memberOn',
        );
        expect(screen.getByTestId('usage-statistics-member').textContent).toContain(
            'statistics.managedByOperator',
        );
        expect(screen.queryByTestId('usage-statistics-toggle')).toBeNull();
        expect(screen.queryByTestId('usage-statistics-last-body')).toBeNull();
    });

    it('shows the operator the exact last payload and the reason', () => {
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={operator()}
                initialLast={LAST}
            />,
        );
        expect(screen.getByTestId('usage-statistics-last-body').textContent).toBe(LAST.payload);
        expect(screen.getByTestId('usage-statistics-reason').textContent).toContain('reasons.on');
        // The never-included list and the docs link are always there.
        expect(screen.getByText('neverIncluded.items.emails')).toBeTruthy();
    });

    it('switches statistics off through its action', async () => {
        actions.setInstanceStatsEnabledAction.mockResolvedValue({
            success: true,
            data: { enabled: false },
        });
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={operator()}
                initialLast={null}
            />,
        );
        await userEvent.click(screen.getByTestId('usage-statistics-toggle'));
        await waitFor(() =>
            expect(actions.setInstanceStatsEnabledAction).toHaveBeenCalledWith(false),
        );
        expect(toastSuccess).toHaveBeenCalledWith('toggle.turnedOff');
    });

    it('disables Send now while statistics are switched off', () => {
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={operator({
                    uiEnabled: false,
                    enabled: false,
                    reason: 'ui',
                    nextSendAt: null,
                })}
                initialLast={null}
            />,
        );
        expect(
            (screen.getByTestId('usage-statistics-send-now') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(screen.getByText('sendNow.disabledOff')).toBeTruthy();
    });

    it('sends now and refreshes the last payload', async () => {
        actions.sendInstanceStatsNowAction.mockResolvedValue({
            success: true,
            data: [{ status: 'sent', httpStatus: 202, errorCode: null }],
        });
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={operator()}
                initialLast={null}
            />,
        );
        await userEvent.click(screen.getByTestId('usage-statistics-send-now'));
        await waitFor(() =>
            expect(screen.getByTestId('usage-statistics-last-body').textContent).toBe(LAST.payload),
        );
        expect(toastSuccess).toHaveBeenCalledWith('sendNow.sent');
    });

    it('translates a refusal by its code', async () => {
        actions.sendInstanceStatsNowAction.mockResolvedValue({
            success: false,
            code: 'rate_limited',
        });
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={operator()}
                initialLast={null}
            />,
        );
        await userEvent.click(screen.getByTestId('usage-statistics-send-now'));
        await waitFor(() => expect(toastError).toHaveBeenCalledWith('errors.rate_limited'));
    });

    it('asks before resetting the identity', async () => {
        actions.resetInstanceStatsIdentityAction.mockResolvedValue({
            success: true,
            data: { instanceId: 'new', resetCount: 1 },
        });
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={operator()}
                initialLast={null}
            />,
        );
        await userEvent.click(screen.getByTestId('usage-statistics-reset'));
        expect(actions.resetInstanceStatsIdentityAction).not.toHaveBeenCalled();
        await userEvent.click(screen.getByTestId('usage-statistics-reset-confirm'));
        await waitFor(() =>
            expect(actions.resetInstanceStatsIdentityAction).toHaveBeenCalledTimes(1),
        );
    });

    it('previews what would be sent without sending it', async () => {
        actions.previewInstanceStatsAction.mockResolvedValue({
            success: true,
            data: { schema: 'ever.stats.v1' },
        });
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={operator()}
                initialLast={null}
            />,
        );
        await userEvent.click(screen.getByTestId('usage-statistics-preview'));
        await waitFor(() =>
            expect(screen.getByTestId('usage-statistics-preview-body').textContent).toContain(
                'ever.stats.v1',
            ),
        );
        expect(actions.sendInstanceStatsNowAction).not.toHaveBeenCalled();
    });
});
