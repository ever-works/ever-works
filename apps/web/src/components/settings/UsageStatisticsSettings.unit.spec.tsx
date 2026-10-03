import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstanceStatsOperatorStatus, InstanceStatsReportView } from '@ever-works/contracts';
import { UsageStatisticsSettings } from './UsageStatisticsSettings';

/**
 * Settings → Ever Platform → Anonymous usage statistics.
 *
 * Pins the two views (a member, the operator — with the module switched off
 * by the configuration the page itself is a 404), who manages statistics,
 * that the operator's *Last payload* is the stored bytes verbatim with the
 * fields a receiver refused, that an unencrypted key is said, that the switch
 * and *Send now* call their actions, that *Send now* is disabled while
 * statistics are off, and that the reset asks first.
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
        managedBy: 'operator',
        reason: 'on',
        uiEnabled: true,
        installSource: 'self-hosted',
        country: 'ZZ',
        statsApiUrl: 'https://api.ever.co',
        instanceId: '41b54444-0795-416c-bdb8-72fe2925a157',
        resetCount: 0,
        nextSendAt: '2026-10-16T08:00:00.000Z',
        sinkAvailable: true,
        keyStoredEncrypted: true,
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

    it('says when the status could not be read', () => {
        render(
            <UsageStatisticsSettings state="unavailable" initialStatus={null} initialLast={null} />,
        );
        expect(screen.getByTestId('usage-statistics-unavailable').textContent).toBe(
            'statistics.unavailable',
        );
        expect(screen.queryByTestId('usage-statistics-operator')).toBeNull();
    });

    it('shows a member whether statistics are on and who manages them — no controls, no payload', () => {
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={{ enabled: true, managedBy: 'operator' }}
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

    it('tells a member of a cloud installation that Ever Cloud manages statistics', () => {
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={{ enabled: true, managedBy: 'cloud' }}
                initialLast={null}
            />,
        );
        const notice = screen.getByTestId('usage-statistics-member').textContent;
        expect(notice).toContain('statistics.managedByCloud');
        expect(notice).not.toContain('statistics.managedByOperator');
    });

    it('lists the fields a receiver refused under the last payload', () => {
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={operator()}
                initialLast={{
                    ...LAST,
                    status: 'rejected',
                    httpStatus: 422,
                    errorCode: 'schema_violation',
                    errors: [
                        { path: '/counts/works_by_kind/app', code: 'unknown_field' },
                        { path: '/country', code: null },
                    ],
                }}
            />,
        );
        const errors = screen.getByTestId('usage-statistics-last-errors').textContent;
        expect(errors).toContain('last.refusedFields');
        expect(errors).toContain('/counts/works_by_kind/app — unknown_field');
        expect(errors).toContain('/country');
        // The stored bytes are still shown verbatim.
        expect(screen.getByTestId('usage-statistics-last-body').textContent).toBe(LAST.payload);
    });

    it('shows no refused-fields list for an accepted report', () => {
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={operator()}
                initialLast={LAST}
            />,
        );
        expect(screen.queryByTestId('usage-statistics-last-errors')).toBeNull();
    });

    it('says when the statistics key is stored unencrypted, and only then', () => {
        const { unmount } = render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={operator({ keyStoredEncrypted: false })}
                initialLast={null}
            />,
        );
        expect(screen.getByTestId('usage-statistics-key-unencrypted').textContent).toBe(
            'keyUnencrypted',
        );
        unmount();
        render(
            <UsageStatisticsSettings
                state="loaded"
                initialStatus={operator()}
                initialLast={null}
            />,
        );
        expect(screen.queryByTestId('usage-statistics-key-unencrypted')).toBeNull();
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
