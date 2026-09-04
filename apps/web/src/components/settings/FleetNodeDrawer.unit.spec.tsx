import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FleetJobView, FleetNodeDetailView, FleetNodeView } from '@ever-works/contracts';
import { FleetNodeDrawer } from './FleetNodeDrawer';

/**
 * Node drawer — the job-history rendering.
 *
 * The derivations (filter, duration, formatting) are pinned by
 * `fleet-node-drawer.shared.unit.spec.ts`; this spec pins that every
 * `FleetJobView` fact the drawer promises to show actually reaches the
 * row, and that the filter chips switch the list and its empty state.
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));

// `Button` pulls in the locale-aware `Link`; next-intl's navigation
// factory needs a Next runtime that jsdom does not provide.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

// The dialog primitive (Headless UI transitions, focus traps, portals)
// is not what is under test; render its children in place.
vi.mock('@/components/ui/dialog', () => ({
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
        open ? <div>{children}</div> : null,
    DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    DialogClose: ({ onClose }: { onClose: () => void }) => (
        <button type="button" onClick={onClose}>
            close
        </button>
    ),
}));

function node(over: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: 'node-1',
        name: 'Office PC',
        kind: 'desktop-node',
        status: 'online',
        platform: 'win32/x64',
        version: '0.1.0',
        capabilities: ['terminal'],
        lastHeartbeatAt: '2026-09-01T10:00:00.000Z',
        createdAt: null,
        persisted: true,
        capabilitiesPinned: false,
        ...over,
    };
}

function job(over: Partial<FleetJobView> = {}): FleetJobView {
    return {
        id: 'job-done',
        kind: 'agent-task',
        status: 'done',
        nodeId: 'node-1',
        targetNodeId: null,
        requiredCapabilities: [],
        payload: null,
        leaseExpiresAt: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: '2026-09-01T10:00:00.000Z',
        startedAt: '2026-09-01T10:00:05.000Z',
        completedAt: '2026-09-01T10:01:17.000Z',
        queuedReason: null,
        ...over,
    };
}

const JOBS: FleetJobView[] = [
    job({
        id: 'job-queued',
        status: 'queued',
        attempts: 0,
        startedAt: null,
        completedAt: null,
        queuedReason: 'waiting-for-runner',
        targetNodeId: 'node-1',
    }),
    job({ id: 'job-running', status: 'running', completedAt: null }),
    job(),
    job({ id: 'job-failed', kind: 'acceptance-checks', status: 'failed', attempts: 3 }),
];

function detail(over: Partial<FleetNodeDetailView> = {}): FleetNodeDetailView {
    return {
        node: node(),
        recentJobs: JOBS,
        failures: JOBS.filter((entry) => entry.status === 'failed'),
        historyUnavailable: false,
        ...over,
    };
}

function renderDrawer(
    over: {
        detail?: FleetNodeDetailView | null;
        loading?: boolean;
        node?: FleetNodeView | null;
    } = {},
) {
    return render(
        <FleetNodeDrawer
            node={over.node === undefined ? node() : over.node}
            detail={over.detail === undefined ? detail() : over.detail}
            loading={over.loading ?? false}
            error={null}
            isPending={false}
            onClose={() => undefined}
            onSaveCapabilities={() => undefined}
            onRotate={() => undefined}
            onDrain={() => undefined}
        />,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('FleetNodeDrawer — job history rows', () => {
    it('renders every recent job, newest first, with kind and status', () => {
        renderDrawer();

        const rows = screen.getAllByTestId(/^fleet-node-job-job-/);
        expect(rows.map((row) => row.getAttribute('data-status'))).toEqual([
            'queued',
            'running',
            'done',
            'failed',
        ]);
        expect(screen.getByTestId('fleet-node-job-job-failed')).toHaveTextContent(
            'acceptance-checks',
        );
        expect(screen.getByTestId('fleet-node-job-status-job-failed')).toHaveTextContent(
            'jobs.statuses.failed',
        );
        expect(screen.getByTestId('fleet-node-history-count')).toHaveTextContent(
            'history.recentCount:4',
        );
    });

    it('shows attempts, started / completed times and the duration of a finished job', () => {
        renderDrawer();

        const row = screen.getByTestId('fleet-node-job-job-done');
        expect(row).toHaveTextContent('jobs.attempts:1,3');
        expect(screen.getByTestId('fleet-node-job-started-job-done')).toHaveTextContent(
            /^jobs\.startedValue:/,
        );
        expect(screen.getByTestId('fleet-node-job-completed-job-done')).toHaveTextContent(
            /^jobs\.completedValue:/,
        );
        expect(screen.getByTestId('fleet-node-job-duration-job-done')).toHaveTextContent(
            'jobs.durationValue:1m 12s',
        );
    });

    it('reports elapsed time, not a completion, for a job still running', () => {
        renderDrawer();

        expect(screen.getByTestId('fleet-node-job-completed-job-running')).toHaveTextContent(
            'jobs.notCompleted',
        );
        expect(screen.getByTestId('fleet-node-job-duration-job-running')).toHaveTextContent(
            /^jobs\.elapsedValue:/,
        );
    });

    it('explains why a queued job has not started and marks it pinned to this node', () => {
        renderDrawer();

        expect(screen.getByTestId('fleet-node-job-started-job-queued')).toHaveTextContent(
            'jobs.notStarted',
        );
        expect(screen.getByTestId('fleet-node-job-duration-job-queued')).toHaveTextContent('-');
        expect(screen.getByTestId('fleet-node-job-queued-reason-job-queued')).toHaveTextContent(
            'jobs.queuedReason:jobs.queuedReasons.waitingForRunner',
        );
        expect(screen.getByTestId('fleet-node-job-job-queued')).toHaveTextContent('jobs.pinned');
        expect(screen.getByTestId('fleet-node-job-job-done')).not.toHaveTextContent('jobs.pinned');
    });

    it('passes an unrecognised queued reason through verbatim', () => {
        renderDrawer({
            detail: detail({
                recentJobs: [
                    job({
                        id: 'job-odd',
                        status: 'queued',
                        startedAt: null,
                        completedAt: null,
                        queuedReason: 'capacity-hold',
                    }),
                ],
                failures: [],
            }),
        });
        expect(screen.getByTestId('fleet-node-job-queued-reason-job-odd')).toHaveTextContent(
            'jobs.queuedReason:capacity-hold',
        );
    });
});

describe('FleetNodeDrawer — job filter', () => {
    it('starts on All and narrows to failed jobs only', async () => {
        const user = userEvent.setup();
        renderDrawer();

        expect(screen.getByTestId('fleet-node-jobs-filter-all')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await user.click(screen.getByTestId('fleet-node-jobs-filter-failed'));

        const rows = screen.getAllByTestId(/^fleet-node-job-job-/);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toHaveAttribute('data-status', 'failed');
        // The count line reports the whole history, not the filtered view.
        expect(screen.getByTestId('fleet-node-history-count')).toHaveTextContent(
            'history.recentCount:4',
        );
    });

    it('"Running" shows the jobs a node holds a claim on', async () => {
        const user = userEvent.setup();
        renderDrawer();

        await user.click(screen.getByTestId('fleet-node-jobs-filter-running'));

        const rows = screen.getAllByTestId(/^fleet-node-job-job-/);
        expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['running']);
    });

    it('renders a filter-specific empty state', async () => {
        const user = userEvent.setup();
        renderDrawer({
            detail: detail({ recentJobs: [job()], failures: [] }),
        });

        await user.click(screen.getByTestId('fleet-node-jobs-filter-failed'));
        expect(screen.getByTestId('fleet-node-jobs-empty')).toHaveTextContent('jobs.emptyFailed');

        await user.click(screen.getByTestId('fleet-node-jobs-filter-running'));
        expect(screen.getByTestId('fleet-node-jobs-empty')).toHaveTextContent('jobs.emptyRunning');
    });

    it('resets to All when a different node is opened', async () => {
        const user = userEvent.setup();
        const { rerender } = renderDrawer();

        await user.click(screen.getByTestId('fleet-node-jobs-filter-failed'));
        expect(screen.getByTestId('fleet-node-jobs-filter-failed')).toHaveAttribute(
            'aria-pressed',
            'true',
        );

        const other = node({ id: 'node-2', name: 'Laptop' });
        rerender(
            <FleetNodeDrawer
                node={other}
                detail={detail({ node: other, recentJobs: [job()], failures: [] })}
                loading={false}
                error={null}
                isPending={false}
                onClose={() => undefined}
                onSaveCapabilities={() => undefined}
                onRotate={() => undefined}
                onDrain={() => undefined}
            />,
        );

        expect(screen.getByTestId('fleet-node-jobs-filter-all')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(screen.getAllByTestId(/^fleet-node-job-job-/)).toHaveLength(1);
    });
});

describe('FleetNodeDrawer — history states', () => {
    it('shows the loading note before the detail arrives', () => {
        renderDrawer({ detail: null, loading: true });
        expect(screen.getByText('history.loading')).toBeInTheDocument();
        expect(screen.queryByTestId('fleet-node-history-count')).toBeNull();
    });

    it('says the history is unavailable without pretending the node has no jobs', () => {
        renderDrawer({
            detail: detail({ recentJobs: [], failures: [], historyUnavailable: true }),
        });
        expect(screen.getByText('history.unavailable')).toBeInTheDocument();
        expect(screen.queryByTestId('fleet-node-jobs-empty')).toBeNull();
    });

    it('renders the all-jobs empty state for a node with no history', () => {
        renderDrawer({ detail: detail({ recentJobs: [], failures: [] }) });
        expect(screen.getByTestId('fleet-node-jobs-empty')).toHaveTextContent('jobs.emptyAll');
    });
});
