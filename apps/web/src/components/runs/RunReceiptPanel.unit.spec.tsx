import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunReceipt } from '@ever-works/contracts';
import { RunReceiptPanel } from './RunReceiptPanel';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
    useLocale: () => 'en-US',
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

const getRunReceiptAction = vi.fn();
vi.mock('@/app/actions/runs', () => ({
    getRunReceiptAction: (...args: unknown[]) => getRunReceiptAction(...args),
}));

/**
 * Run receipt drawer (AW-09). Opens over the ledger, loads the receipt for
 * the run in the URL, and treats "not yours" exactly like "does not exist".
 */

const RUN = '9f9f9f9f-6f6a-4c55-9a4c-1f2b3c4d5e6f';

const RECEIPT: RunReceipt = {
    row: {
        id: RUN,
        agentId: '0b7e7c1e-6f6a-4c55-9a4c-1f2b3c4d5e6f',
        agentName: 'Research',
        agentArchived: false,
        triggerKind: 'heartbeat',
        status: 'failed',
        startedAt: '2026-09-08T09:12:00.000Z',
        createdAt: '2026-09-08T09:11:59.000Z',
        finishedAt: '2026-09-08T09:42:00.000Z',
        durationMs: 1_800_000,
        costCents: 94,
        totalTokens: 1200,
        summary: null,
        errorMessage: 'Run exceeded its time limit and was stopped.',
        currentActivity: null,
        taskId: null,
        taskTitle: null,
        missionId: null,
        missionTitle: null,
        workId: null,
        workName: null,
        scheduleKey: 'agent_heartbeat:0b7e7c1e-6f6a-4c55-9a4c-1f2b3c4d5e6f',
        awaitingInput: false,
        queuedReason: null,
        attentionReason: null,
    },
    cost: {
        settledCents: 94,
        meteredCents: 94,
        soFar: false,
        creditsDebited: 38,
        detailRetained: true,
        tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: 1200 },
        lines: [],
    },
    counts: { messages: 4, toolCalls: 7, filesTouched: 0 },
    filesTouched: [],
    captureTruncated: false,
    knowledge: [],
};

describe('RunReceiptPanel', () => {
    beforeEach(() => {
        getRunReceiptAction.mockReset();
    });

    it('renders nothing and fetches nothing while no run is open', () => {
        render(<RunReceiptPanel runId={null} timeZone="UTC" onClose={vi.fn()} />);

        expect(screen.queryByTestId('run-receipt')).toBeNull();
        expect(getRunReceiptAction).not.toHaveBeenCalled();
    });

    it('loads the receipt for the open run and shows its outcome header and blocks', async () => {
        getRunReceiptAction.mockResolvedValue(RECEIPT);
        render(<RunReceiptPanel runId={RUN} timeZone="UTC" onClose={vi.fn()} />);

        expect(screen.getByTestId('run-receipt-loading')).toBeDefined();
        await waitFor(() => expect(screen.getByTestId('run-receipt')).toBeDefined());

        expect(getRunReceiptAction).toHaveBeenCalledWith(RUN);
        const header = screen.getByTestId('run-receipt-header');
        expect(header.textContent).toContain('failed');
        expect(header.textContent).toContain('Research');
        expect(header.textContent).toContain('heartbeat');
        expect(header.textContent).toContain('30m 00s');
        expect(screen.getByTestId('run-receipt-error').textContent).toContain(
            'Run exceeded its time limit and was stopped.',
        );
    });

    it('shows the same copy for a missing run and a run the viewer cannot read', async () => {
        getRunReceiptAction.mockResolvedValue(null);
        render(<RunReceiptPanel runId={RUN} timeZone="UTC" onClose={vi.fn()} />);

        await waitFor(() =>
            expect(screen.getByTestId('run-receipt-missing').textContent).toBe('errors.notFound'),
        );
    });

    it('treats a failed fetch as not found rather than crashing', async () => {
        getRunReceiptAction.mockRejectedValue(new Error('network'));
        render(<RunReceiptPanel runId={RUN} timeZone="UTC" onClose={vi.fn()} />);

        await waitFor(() => expect(screen.getByTestId('run-receipt-missing')).toBeDefined());
    });

    it('closes from its close control', async () => {
        getRunReceiptAction.mockResolvedValue(RECEIPT);
        const onClose = vi.fn();
        render(<RunReceiptPanel runId={RUN} timeZone="UTC" onClose={onClose} />);

        await userEvent.setup().click(screen.getByRole('button', { name: 'receipt.close' }));

        expect(onClose).toHaveBeenCalled();
    });
});
