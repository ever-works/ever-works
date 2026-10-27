import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../../../../../../messages/en.json';
import type { AppStatusView } from '@/lib/api/app-runtime.types';

/**
 * Lane aw-ops (APW-06 T38/T39) — the live card of the Deploy tab.
 *
 * Pinned: a viewer sees components, smoke results and jobs but no Refresh, Run smoke checks,
 * Run now or Logs (S28); Refresh queues once and a 429 becomes a countdown (FR-46); Run now needs
 * the ticked confirmation before anything is sent, a first-deploy job carries its warning, and a
 * refusal stays in the dialog (FR-51); the out-of-memory line shows only within 24 hours.
 */

const { client, toastSuccess, toastError } = vi.hoisted(() => ({
    client: {
        getStatus: vi.fn(),
        refreshStatus: vi.fn(),
        requestLogs: vi.fn(),
        readLogs: vi.fn(),
        runJob: vi.fn(),
        runSmoke: vi.fn(),
        listDeployments: vi.fn(),
    },
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('@/lib/api/app-runtime-ops.client', () => ({ appRuntimeOpsClient: client }));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { AppLiveCard } from './AppLiveCard';

const WORK_ID = '6f1c1b6e-2f7a-4c55-9a0e-2a1d4c8b9e10';
const REQUEST_ID = 'b5e1c7a0-3333-4c4d-9e5f-607182930415';

function status(over: Partial<AppStatusView> = {}): AppStatusView {
    return {
        state: 'live',
        target: 'your-cluster',
        stale: false,
        observedAt: new Date().toISOString(),
        url: 'https://book.example.com',
        sourceOffer: null,
        currentDeployment: { id: 'd-1', state: 'READY' },
        snapshot: {
            observedAt: new Date().toISOString(),
            components: [
                { name: 'web', role: 'web', desired: 2, ready: 2, restarts: 0 },
                {
                    name: 'worker',
                    role: 'worker',
                    desired: 1,
                    ready: 1,
                    restarts: 3,
                    lastTerminationReason: 'OOMKilled',
                    oomKilledAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                },
            ],
            jobs: [
                {
                    name: 'migrate',
                    last: {
                        name: 'migrate',
                        when: 'pre-deploy',
                        runName: 'migrate-1',
                        status: 'succeeded',
                        startedAt: '2026-10-27T00:00:00.000Z',
                        completedAt: '2026-10-27T00:00:38.000Z',
                    },
                },
                {
                    name: 'create-admin',
                    last: {
                        name: 'create-admin',
                        when: 'first-deploy',
                        runName: 'create-admin-1',
                        status: 'succeeded',
                        startedAt: '2026-10-27T00:00:00.000Z',
                    },
                },
            ],
            cron: [],
            isolationEnforced: true,
        },
        smoke: {
            deploymentId: 'd-1',
            observedAt: '2026-10-27T00:01:00.000Z',
            inCluster: [{ name: 'health', status: 'passed' }],
            public: [{ name: 'home', status: 'failed', classification: 'tls_not_ready' }],
            hairpin: null,
        },
        requests: [],
        ...over,
    };
}

function renderCard(view: AppStatusView, canEdit = true) {
    const onReload = vi.fn();
    render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <AppLiveCard workId={WORK_ID} status={view} canEdit={canEdit} onReload={onReload} />
        </NextIntlClientProvider>,
    );
    return { onReload };
}

describe('AppLiveCard', () => {
    beforeEach(() => {
        Object.values(client).forEach((fn) => fn.mockReset());
    });
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it('shows a viewer the components, smoke results and jobs, and no action at all (S28)', () => {
        renderCard(status(), false);
        expect(screen.getAllByTestId('app-component-row')).toHaveLength(2);
        expect(screen.getByTestId('app-smoke-results')).toHaveAttribute('data-failing', '1');
        expect(screen.getByText(/certificate isn't ready yet/)).toBeInTheDocument();
        expect(screen.getAllByTestId('app-job-row')).toHaveLength(2);
        for (const id of [
            'app-live-refresh',
            'app-live-smoke',
            'app-component-logs',
            'app-job-logs',
            'app-job-run-open',
        ]) {
            expect(screen.queryByTestId(id)).toBeNull();
        }
    });

    it('marks an out-of-memory kill only within the last 24 hours', async () => {
        renderCard(status());
        await waitFor(() => expect(screen.getAllByTestId('app-component-oom')).toHaveLength(1));
        cleanup();
        const old = status();
        old.snapshot!.components[1].oomKilledAt = new Date(Date.now() - 48 * 3_600_000).toISOString();
        renderCard(old);
        await waitFor(() => expect(screen.queryByTestId('app-component-oom')).toBeNull());
    });

    it('refreshes once and turns a 429 into a countdown', async () => {
        client.refreshStatus.mockResolvedValueOnce({
            ok: true,
            status: 202,
            data: { status: 'accepted', op: 'status-refresh', requestId: REQUEST_ID, dispatched: true },
        });
        const { onReload } = renderCard(status());
        fireEvent.click(screen.getByTestId('app-live-refresh'));
        await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
        expect(client.refreshStatus).toHaveBeenCalledWith(WORK_ID);

        client.refreshStatus.mockResolvedValueOnce({ ok: false, status: 429, code: 'refresh_too_soon', retryAfterSeconds: 12 });
        fireEvent.click(screen.getByTestId('app-live-refresh'));
        await waitFor(() => expect(screen.getByTestId('app-live-refresh')).toBeDisabled());
        expect(screen.getByTestId('app-live-refresh')).toHaveTextContent('Refresh in 12s');
    });

    it('runs a job only after the confirmation is ticked, and warns for a first-deploy job', async () => {
        client.runJob.mockResolvedValueOnce({
            ok: true,
            status: 202,
            data: { status: 'accepted', op: 'job-run', requestId: REQUEST_ID, dispatched: true },
        });
        const { onReload } = renderCard(status());
        const row = screen.getAllByTestId('app-job-row').find((el) => el.dataset.name === 'create-admin')!;
        fireEvent.click(within(row).getByTestId('app-job-run-open'));

        const dialog = await screen.findByTestId('app-job-run-dialog');
        expect(within(dialog).getByTestId('app-job-first-deploy-warning')).toBeInTheDocument();
        const submit = within(dialog).getByTestId('app-job-run-submit');
        expect(submit).toBeDisabled();
        fireEvent.click(submit);
        expect(client.runJob).not.toHaveBeenCalled();

        fireEvent.click(within(dialog).getByTestId('app-job-run-confirm'));
        fireEvent.click(within(dialog).getByTestId('app-job-run-submit'));
        await waitFor(() => expect(client.runJob).toHaveBeenCalledWith(WORK_ID, 'create-admin'));
        await waitFor(() => expect(onReload).toHaveBeenCalled());
    });

    it('keeps a refused run in the dialog with its reason', async () => {
        client.runJob.mockResolvedValueOnce({ ok: false, status: 409, code: 'job_active' });
        renderCard(status());
        const row = screen.getAllByTestId('app-job-row').find((el) => el.dataset.name === 'migrate')!;
        fireEvent.click(within(row).getByTestId('app-job-run-open'));
        const dialog = await screen.findByTestId('app-job-run-dialog');
        expect(within(dialog).queryByTestId('app-job-first-deploy-warning')).toBeNull();
        fireEvent.click(within(dialog).getByTestId('app-job-run-confirm'));
        fireEvent.click(within(dialog).getByTestId('app-job-run-submit'));
        expect(await within(dialog).findByTestId('app-job-run-error')).toHaveTextContent(/still going/);
    });

    it('disables Run now for a job with a queued run, and every run during a Deployment', () => {
        renderCard(
            status({
                requests: [
                    { requestId: REQUEST_ID, op: 'job-run', state: 'queued', at: '2026-10-27T00:00:00Z', jobName: 'migrate' },
                ],
            }),
        );
        const rows = screen.getAllByTestId('app-job-row');
        const migrate = rows.find((el) => el.dataset.name === 'migrate')!;
        const admin = rows.find((el) => el.dataset.name === 'create-admin')!;
        expect(within(migrate).getByTestId('app-job-run-open')).toBeDisabled();
        expect(within(admin).getByTestId('app-job-run-open')).not.toBeDisabled();
        expect(screen.getByTestId('app-live-requests')).toHaveTextContent('Run of migrate — in progress');

        cleanup();
        renderCard(status({ currentDeployment: { id: 'd-2', state: 'DEPLOYING' } }));
        for (const button of screen.getAllByTestId('app-job-run-open')) expect(button).toBeDisabled();
        expect(screen.getByTestId('app-live-smoke')).toBeDisabled();
    });
});
