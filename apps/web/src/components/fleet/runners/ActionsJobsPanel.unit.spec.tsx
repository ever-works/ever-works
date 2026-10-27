import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FleetActionsJobView, FleetActionsJobsView } from '@ever-works/contracts';

// The REAL English strings: a key a component asks for that `en.json` lacks
// fails the test instead of echoing (see `fleet-test-intl.ts`).
vi.mock('next-intl', async () => {
    const { testTranslations } = await import('../health/fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});

const jobs = vi.fn();
const cancelRun = vi.fn();
const setWatched = vi.fn();
vi.mock('@/app/actions/fleet/runners', () => ({
    listFleetActionsJobsAction: (...args: unknown[]) => jobs(...args),
    cancelFleetActionsRunAction: (...args: unknown[]) => cancelRun(...args),
    setFleetActionsWatchedTargetsAction: (...args: unknown[]) => setWatched(...args),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => search }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import ActionsJobsPanel from './ActionsJobsPanel';

/** Actions jobs (FL-18 P2, spec §5.4, T-25) — the hub Overview's Actions jobs panel. */

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function job(overrides: Partial<FleetActionsJobView> = {}): FleetActionsJobView {
    return {
        repository: 'acme/api',
        runId: 4822,
        runNumber: 4822,
        jobId: 1,
        name: 'e2e · windows',
        workflowName: 'CI',
        labels: ['self-hosted', 'windows'],
        status: 'queued',
        runnerName: null,
        startedAt: null,
        queuedAt: minutesAgo(6),
        url: 'https://github.com/acme/api/actions/runs/4822/job/1',
        diagnosis: null,
        diagnosisDetail: null,
        unassignable: false,
        ...overrides,
    };
}

function view(overrides: Partial<FleetActionsJobsView> = {}): FleetActionsJobsView {
    return {
        jobs: [],
        busyRunners: 2,
        totalRunners: 3,
        watched: [
            { scope: 'repo', target: 'acme/api' },
            { scope: 'repo', target: 'acme/web' },
        ],
        watchedSaved: false,
        available: [
            { scope: 'repo', target: 'acme/api' },
            { scope: 'repo', target: 'acme/web' },
            { scope: 'repo', target: 'acme/docs' },
            { scope: 'org', target: 'acme' },
        ],
        unreadable: [],
        checkedAt: new Date(2026, 9, 27, 9, 41).toISOString(),
        rateLimitedUntil: null,
        killSwitch: false,
        canCancel: true,
        ...overrides,
    };
}

const panel = () => render(<ActionsJobsPanel nodes={[]} flags={{}} />);

beforeEach(() => {
    jobs.mockReset();
    cancelRun.mockReset();
    setWatched.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
    search = new URLSearchParams();
});

describe('ActionsJobsPanel', () => {
    it('renders nothing while runners are switched off (the API answers 404)', async () => {
        jobs.mockResolvedValue({ ok: false, error: { code: 'not_found', hint: '' } });
        const { container } = panel();
        await waitFor(() => expect(jobs).toHaveBeenCalled());
        await waitFor(() => expect(container).toBeEmptyDOMElement());
    });

    it('renders nothing for someone with no runners, no watched list and no jobs', async () => {
        jobs.mockResolvedValue({
            ok: true,
            data: view({ totalRunners: 0, busyRunners: 0, watched: [], watchedSaved: false }),
        });
        const { container } = panel();
        await waitFor(() => expect(jobs).toHaveBeenCalled());
        await waitFor(() => expect(container).toBeEmptyDOMElement());
    });

    it('says when nothing is queued or running, what it watches, and offers Change', async () => {
        jobs.mockResolvedValue({ ok: true, data: view() });
        panel();
        const empty = await screen.findByTestId('fleet-actions-jobs-empty');
        expect(empty).toHaveTextContent('No queued or running jobs on your runners');
        expect(empty).toHaveTextContent('watching acme/api, acme/web');
        expect(within(empty).getByText('Change')).toBeInTheDocument();
        expect(screen.getByTestId('fleet-actions-jobs-counts')).toHaveTextContent(
            '0 queued · 0 running · 2 of 3 runners busy',
        );
        expect(screen.getByTestId('fleet-actions-jobs-checked')).toHaveTextContent('checked 09:41');
    });

    it('says every diagnosis in plain words, and that waiting for a busy runner is not a problem', async () => {
        jobs.mockResolvedValue({
            ok: true,
            data: view({
                jobs: [
                    job({
                        jobId: 1,
                        diagnosis: 'missing-label',
                        diagnosisDetail: 'windows',
                        unassignable: true,
                    }),
                    job({
                        jobId: 2,
                        diagnosis: 'offline-matching-runner',
                        diagnosisDetail: 'build-01-1',
                    }),
                    job({
                        jobId: 3,
                        repository: 'other/app',
                        diagnosis: 'wrong-scope',
                        diagnosisDetail: 'other/app',
                    }),
                    job({ jobId: 4, diagnosis: 'all-busy', diagnosisDetail: 'build-01-2' }),
                    job({
                        jobId: 5,
                        runId: 4821,
                        runNumber: 4821,
                        name: 'test · ubuntu',
                        status: 'in_progress',
                        runnerName: 'build-01-2',
                        startedAt: minutesAgo(4),
                        queuedAt: minutesAgo(5),
                    }),
                ],
            }),
        });
        panel();
        const lines = (await screen.findAllByTestId('fleet-actions-job-diagnosis')).map(
            (line) => line.textContent,
        );
        expect(lines).toEqual([
            'no runner can take it — no runner has the label windows',
            'no runner can take it — the only matching runner is offline',
            'no runner can take it — no runner is registered to other/app',
            'waiting for build-01-2',
        ]);
        const rows = screen.getAllByTestId('fleet-actions-job');
        expect(within(rows[0]).getByTestId('fleet-actions-job-where')).toHaveTextContent(
            'queued 6 min',
        );
        expect(rows[0]).toHaveTextContent('CI · e2e · windows');
        expect(rows[0]).toHaveTextContent('#4822');
        expect(within(rows[4]).getByTestId('fleet-actions-job-where')).toHaveTextContent(
            'build-01-2 · running 4 min',
        );
        expect(within(rows[0]).getByTestId('fleet-actions-job-open')).toHaveAttribute(
            'href',
            'https://github.com/acme/api/actions/runs/4822/job/1',
        );
        expect(screen.getByTestId('fleet-actions-jobs-counts')).toHaveTextContent(
            '4 queued · 1 running',
        );
    });

    it('hides Cancel workflow run… from viewers who may not cancel', async () => {
        jobs.mockResolvedValue({ ok: true, data: view({ jobs: [job()], canCancel: false }) });
        panel();
        await screen.findByTestId('fleet-actions-job');
        expect(screen.queryByTestId('fleet-actions-job-cancel')).toBeNull();
    });

    it('cancels a whole workflow run after the contracts’ confirmation', async () => {
        jobs.mockResolvedValue({ ok: true, data: view({ jobs: [job()] }) });
        cancelRun.mockResolvedValue({ ok: true, data: {} });
        panel();
        fireEvent.click(await screen.findByTestId('fleet-actions-job-cancel'));
        expect(
            await screen.findByText('Cancel workflow run #4822 of acme/api?'),
        ).toBeInTheDocument();
        expect(
            screen.getByText('Every job in it stops. This cannot be undone.'),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('fleet-machine-confirm'));
        await waitFor(() =>
            expect(cancelRun).toHaveBeenCalledWith({
                repository: 'acme/api',
                runId: 4822,
                runNumber: 4822,
                confirm: true,
            }),
        );
        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith(
                'Cancelling workflow run #4822 of acme/api…',
            ),
        );
    });

    it('shows the server’s hint when a cancel is refused', async () => {
        jobs.mockResolvedValue({ ok: true, data: view({ jobs: [job()] }) });
        cancelRun.mockResolvedValue({
            ok: false,
            error: {
                code: 'permission_denied',
                hint: 'Only the owner can cancel runs of acme/api',
            },
        });
        panel();
        fireEvent.click(await screen.findByTestId('fleet-actions-job-cancel'));
        fireEvent.click(await screen.findByTestId('fleet-machine-confirm'));
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith('Only the owner can cancel runs of acme/api'),
        );
    });

    it('says GitHub is rate-limiting with the next check time', async () => {
        jobs.mockResolvedValue({
            ok: true,
            data: view({ rateLimitedUntil: new Date(2026, 9, 27, 9, 52).toISOString() }),
        });
        panel();
        expect(await screen.findByTestId('fleet-actions-jobs-checked')).toHaveTextContent(
            'checked 09:41 · GitHub is rate-limiting; next check 09:52',
        );
    });

    it('says runners keep running under the kill switch and pauses Cancel', async () => {
        jobs.mockResolvedValue({ ok: true, data: view({ jobs: [job()], killSwitch: true }) });
        panel();
        expect(await screen.findByTestId('fleet-actions-jobs-kill-switch')).toHaveTextContent(
            'All computers are stopped — runners keep running; installing and cancelling are paused.',
        );
        expect(screen.getByTestId('fleet-actions-job-cancel')).toBeDisabled();
    });

    it('names each target that could not be read, with Grant access when GitHub’s permission is missing', async () => {
        jobs.mockResolvedValue({
            ok: true,
            data: view({
                unreadable: [
                    {
                        scope: 'org',
                        target: 'acme',
                        reason: 'the GitHub App needs “Self-hosted runners: Read and write”',
                        grantUrl: 'https://github.com/organizations/acme/settings/installations/1',
                    },
                ],
            }),
        });
        panel();
        const line = await screen.findByTestId('fleet-actions-jobs-unreadable');
        expect(line).toHaveTextContent('Could not read acme: the GitHub App needs');
        expect(within(line).getByText('Grant access').closest('a')).toHaveAttribute(
            'href',
            'https://github.com/organizations/acme/settings/installations/1',
        );
    });

    it('highlights the workflow run a needs-a-look item points at', async () => {
        search = new URLSearchParams({ actionsJob: 'acme/api#4822' });
        jobs.mockResolvedValue({
            ok: true,
            data: view({
                jobs: [
                    job({ runId: 4821, runNumber: 4821, jobId: 7 }),
                    job({ runId: 4822, jobId: 8 }),
                ],
            }),
        });
        panel();
        const rows = await screen.findAllByTestId('fleet-actions-job');
        expect(rows[0]).not.toHaveAttribute('data-highlighted');
        expect(rows[1]).toHaveAttribute('data-highlighted', 'true');
        expect(rows[1]).toHaveAttribute('aria-current', 'true');
    });

    it('says when the run it was pointed at is no longer queued or running', async () => {
        search = new URLSearchParams({ actionsJob: 'acme/api#9999' });
        jobs.mockResolvedValue({ ok: true, data: view({ jobs: [job()] }) });
        panel();
        expect(
            await screen.findByText('That workflow run is no longer queued or running.'),
        ).toBeInTheDocument();
    });

    it('edits the watched list: remove one, add one the App covers, save', async () => {
        jobs.mockResolvedValue({ ok: true, data: view() });
        setWatched.mockResolvedValue({
            ok: true,
            data: {
                watched: [
                    { scope: 'repo', target: 'acme/api' },
                    { scope: 'repo', target: 'acme/docs' },
                ],
            },
        });
        panel();
        fireEvent.click(await screen.findByTestId('fleet-actions-jobs-change'));
        expect(
            await screen.findByText('Watched repositories and organisations'),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Stop watching acme/web' }));
        fireEvent.change(screen.getByTestId('fleet-actions-watched-add-select'), {
            target: { value: 'repo:acme/docs' },
        });
        fireEvent.click(screen.getByTestId('fleet-actions-watched-add'));
        fireEvent.click(screen.getByTestId('fleet-actions-watched-save'));
        await waitFor(() =>
            expect(setWatched).toHaveBeenCalledWith([
                { scope: 'repo', target: 'acme/api' },
                { scope: 'repo', target: 'acme/docs' },
            ]),
        );
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved the watched list.'));
        // The panel re-reads after a save.
        await waitFor(() => expect(jobs.mock.calls.length).toBeGreaterThan(1));
    });

    it('goes back to the default watched list with an empty list', async () => {
        jobs.mockResolvedValue({ ok: true, data: view({ watchedSaved: true }) });
        setWatched.mockResolvedValue({ ok: true, data: { watched: [] } });
        panel();
        fireEvent.click(await screen.findByTestId('fleet-actions-jobs-change'));
        fireEvent.click(await screen.findByTestId('fleet-actions-watched-default'));
        await waitFor(() => expect(setWatched).toHaveBeenCalledWith([]));
    });
});
