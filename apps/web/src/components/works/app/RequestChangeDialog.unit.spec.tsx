import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../../messages/en.json';

/**
 * APW-08 T27 — **Request a change** on the App Work overview. Before this lane the web reached
 * `POST /api/works/:id/evolve` only through chat; these pin the dialog's three outcomes (filed,
 * held for the owner, refused by the API's own code) and that a refusal never throws.
 */

const { requestMock, costMock } = vi.hoisted(() => ({
    requestMock: vi.fn(),
    costMock: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/app-changes', () => ({
    requestAppChangeAction: requestMock,
    getWorkCostAction: costMock,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));

import { RequestChangeDialog, appChangeErrorKey } from './RequestChangeDialog';
import { WorkCostSummary, formatCents } from './WorkCostSummary';

const renderWithIntl = (node: React.ReactNode) =>
    render(
        <NextIntlClientProvider locale="en" messages={messages}>
            {node}
        </NextIntlClientProvider>,
    );

afterEach(() => {
    cleanup();
    requestMock.mockReset();
    costMock.mockReset();
});

async function openAndSubmit(text: string) {
    fireEvent.click(screen.getByTestId('app-change-open'));
    fireEvent.change(screen.getByTestId('app-change-text'), { target: { value: text } });
    fireEvent.click(screen.getByTestId('app-change-submit'));
}

describe('RequestChangeDialog (APW-08 T27)', () => {
    it('files the change and links its Task', async () => {
        requestMock.mockResolvedValue({
            success: true,
            data: { taskId: 't-1', taskSlug: 'TSK-9', awaitingOwner: false, warnings: [] },
        });
        renderWithIntl(<RequestChangeDialog workId="w-1" />);

        await openAndSubmit('  Add a dark mode toggle.  ');

        await waitFor(() => expect(screen.getByTestId('app-change-filed')).toBeTruthy());
        expect(requestMock).toHaveBeenCalledWith('w-1', 'Add a dark mode toggle.');
        expect(screen.getByText('Change filed as TSK-9.')).toBeTruthy();
        expect(screen.getByTestId('app-change-task-link').getAttribute('href')).toContain('t-1');
    });

    it('says when the change was held for the owner and when only a computer run can publish it', async () => {
        requestMock.mockResolvedValue({
            success: true,
            data: {
                taskId: 't-2',
                taskSlug: 'TSK-10',
                awaitingOwner: true,
                warnings: ['cloudPushOff'],
            },
        });
        renderWithIntl(<RequestChangeDialog workId="w-1" />);

        await openAndSubmit('Rename the settings page.');

        await waitFor(() =>
            expect(
                screen.getByText(messages.dashboard.workDetail.appChange.awaitingOwner),
            ).toBeTruthy(),
        );
        expect(screen.getByText(messages.dashboard.workDetail.appChange.cloudPushOff)).toBeTruthy();
    });

    it('shows the operator pause by its code, never by a message', async () => {
        requestMock.mockResolvedValue({ success: false, code: 'switchOff', statusCode: 503 });
        renderWithIntl(<RequestChangeDialog workId="w-1" />);

        await openAndSubmit('Anything.');

        await waitFor(() => expect(screen.getByTestId('app-change-error')).toBeTruthy());
        expect(screen.getByTestId('app-change-error').getAttribute('data-code')).toBe('switchOff');
        expect(screen.getByRole('alert').textContent).toBe(
            messages.dashboard.workDetail.appChange.errors.switchOff,
        );
    });

    it('cannot submit an empty request', () => {
        renderWithIntl(<RequestChangeDialog workId="w-1" />);
        fireEvent.click(screen.getByTestId('app-change-open'));
        fireEvent.change(screen.getByTestId('app-change-text'), { target: { value: '   ' } });
        expect((screen.getByTestId('app-change-submit') as HTMLButtonElement).disabled).toBe(true);
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('maps every refusal code to copy that exists, and unknown codes to the generic line', () => {
        const errors = messages.dashboard.workDetail.appChange.errors as Record<string, string>;
        for (const code of [
            'agentRequired',
            'switchOff',
            'appSpecMissing',
            'agentNotEligible',
            'notAppWork',
            'invalid_request',
            'invalidRequest',
            'taskCreateFailed',
            undefined,
        ]) {
            expect(typeof errors[appChangeErrorKey(code)]).toBe('string');
        }
        expect(appChangeErrorKey('taskCreateFailed')).toBe('generic');
    });
});

describe('WorkCostSummary (APW-08 T56)', () => {
    it('shows spend, budget, remaining and the alert', async () => {
        costMock.mockResolvedValue({
            success: true,
            data: {
                workId: 'w-1',
                month: '2026-10',
                periodStart: '2026-10-01T00:00:00.000Z',
                periodEnd: '2026-11-01T00:00:00.000Z',
                currency: 'usd',
                spendCents: 9_200,
                capCents: 10_000,
                remainingCents: 800,
                percentUsed: 92,
                allowOverage: false,
                alert: '90',
            },
        });
        renderWithIntl(<WorkCostSummary workId="w-1" />);

        await waitFor(() => expect(screen.getByTestId('work-cost-spend')).toBeTruthy());
        expect(screen.getByTestId('work-cost-spend').textContent).toBe('$92.00');
        expect(screen.getByTestId('work-cost-cap').textContent).toBe('$100.00');
        expect(screen.getByTestId('work-cost-remaining').textContent).toBe('$8.00');
        expect(screen.getByTestId('work-cost-alert').textContent).toBe('90% of the budget used');
    });

    it('says when no budget is set, and when the read failed', async () => {
        costMock.mockResolvedValueOnce({
            success: true,
            data: {
                workId: 'w-1',
                month: '2026-10',
                periodStart: '',
                periodEnd: '',
                currency: 'usd',
                spendCents: 0,
                capCents: null,
                remainingCents: null,
                percentUsed: null,
                allowOverage: false,
                alert: 'none',
            },
        });
        renderWithIntl(<WorkCostSummary workId="w-1" />);
        await waitFor(() => expect(screen.getByTestId('work-cost-no-budget')).toBeTruthy());
        cleanup();

        costMock.mockResolvedValueOnce({ success: false, code: 'not_found', statusCode: 404 });
        renderWithIntl(<WorkCostSummary workId="w-1" />);
        await waitFor(() =>
            expect(screen.getByTestId('work-cost-summary').getAttribute('data-state')).toBe(
                'unavailable',
            ),
        );
    });

    it('every alert state has copy', () => {
        const alerts = messages.dashboard.workDetail.appCost.alert as Record<string, string>;
        for (const alert of ['none', '75', '90', '100', 'overage']) {
            expect(typeof alerts[alert]).toBe('string');
        }
        expect(formatCents(123_456, 'usd', 'en')).toBe('$1,234.56');
    });
});
