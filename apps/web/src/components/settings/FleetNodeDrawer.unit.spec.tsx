import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
    FleetJobView,
    FleetNodeDetailView,
    FleetNodeJobHistoryEntry,
    FleetNodeView,
} from '@ever-works/contracts';
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
        onSaveCostCeiling?: (cents: number | null) => void;
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
            onSaveCostCeiling={over.onSaveCostCeiling ?? (() => undefined)}
            onRotate={() => undefined}
            onDrain={() => undefined}
        />,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('FleetNodeDrawer — billing identity and daily ceiling (fleet cost accounting, EW-777)', () => {
    it('shows the seat the machine is billed to, and says so when it never reported one', () => {
        const { unmount } = renderDrawer({
            node: node({ modelIdentity: 'claude-code: ops@example.com (Acme, max)' }),
            detail: detail({
                node: node({ modelIdentity: 'claude-code: ops@example.com (Acme, max)' }),
            }),
        });
        expect(screen.getByTestId('fleet-node-drawer-identity')).toHaveTextContent(
            'claude-code: ops@example.com (Acme, max)',
        );
        unmount();

        renderDrawer();
        expect(screen.getByTestId('fleet-node-drawer-identity')).toHaveTextContent(
            'table.identityUnknown',
        );
    });

    it('shows the ceiling in force, the day it last tripped, and seeds the editor in dollars', () => {
        const tripped = node({ dailyCostCeilingCents: 2_500, dailyCostTrippedOn: '2026-09-04' });
        renderDrawer({ node: tripped, detail: detail({ node: tripped }) });

        expect(screen.getByTestId('fleet-node-drawer-ceiling')).toHaveTextContent('$25.00');
        expect(screen.getByTestId('fleet-node-drawer-ceiling')).toHaveTextContent(
            'costCeiling.nodeTripped:2026-09-04',
        );
        expect(screen.getByTestId('fleet-node-cost-ceiling-input')).toHaveValue('25.00');
    });

    it('reads "inherit" with an empty editor when the node has no ceiling of its own', () => {
        renderDrawer();
        expect(screen.getByTestId('fleet-node-drawer-ceiling')).toHaveTextContent(
            'costCeiling.nodeInherit',
        );
        expect(screen.getByTestId('fleet-node-cost-ceiling-input')).toHaveValue('');
        expect(screen.getByTestId('fleet-node-cost-ceiling-clear')).toBeDisabled();
    });

    it('saves the typed dollars as whole cents, and clears with null', async () => {
        const onSaveCostCeiling = vi.fn();
        const capped = node({ dailyCostCeilingCents: 1_000 });
        renderDrawer({ node: capped, detail: detail({ node: capped }), onSaveCostCeiling });
        const user = userEvent.setup();

        const input = screen.getByTestId('fleet-node-cost-ceiling-input');
        await user.clear(input);
        await user.type(input, '12.5');
        await user.click(screen.getByTestId('fleet-node-cost-ceiling-save'));
        expect(onSaveCostCeiling).toHaveBeenCalledWith(1_250);

        await user.click(screen.getByTestId('fleet-node-cost-ceiling-clear'));
        expect(onSaveCostCeiling).toHaveBeenLastCalledWith(null);
    });

    it('refuses a figure the API would refuse instead of sending it', async () => {
        const onSaveCostCeiling = vi.fn();
        renderDrawer({ onSaveCostCeiling });
        const user = userEvent.setup();

        await user.type(screen.getByTestId('fleet-node-cost-ceiling-input'), '-5');
        await user.click(screen.getByTestId('fleet-node-cost-ceiling-save'));
        expect(onSaveCostCeiling).not.toHaveBeenCalled();
    });
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
                onSaveCostCeiling={() => undefined}
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

/**
 * Fleet health signals (EW-776) — the three truths slices B and E left
 * open, plus the one thing the drawer must never do.
 *
 * The mocked `useTranslations` renders `key:value1,value2`, so the
 * assertions below read the KEY the component chose — which is exactly
 * what is under test here: whether the drawer picks "quarantined" for a
 * machine that is refusing work, and "failed" for a job whose RUN failed.
 */
describe('FleetNodeDrawer — worker state', () => {
    it('shows a quarantine with its reason and when it started', () => {
        // The defect: `status: 'online'` on a machine refusing every job.
        // Both facts are now on screen at once.
        const quarantined = node({
            status: 'online',
            workerState: 'quarantined',
            workerStateReason: 'process tree for job 42 could not be proven terminated',
            workerStateChangedAt: '2026-09-01T03:14:00.000Z',
        });
        renderDrawer({ node: quarantined, detail: detail({ node: quarantined }) });

        expect(screen.getByTestId('fleet-node-drawer-worker-state')).toHaveTextContent(
            'workerStates.quarantined',
        );
        expect(screen.getByTestId('fleet-node-drawer-worker-reason')).toHaveTextContent(
            'process tree for job 42 could not be proven terminated',
        );
        expect(screen.getByTestId('fleet-node-drawer-worker-since')).toHaveTextContent(
            'workerStateSince',
        );
    });

    it('says unknown — not idle — for a node that has never reported', () => {
        renderDrawer();

        expect(screen.getByTestId('fleet-node-drawer-worker-state')).toHaveTextContent(
            'workerStates.unknown',
        );
        expect(screen.queryByTestId('fleet-node-drawer-worker-reason')).toBeNull();
        expect(screen.queryByTestId('fleet-node-drawer-worker-since')).toBeNull();
    });

    it('shows a throttle reason so an idle-looking machine explains itself', () => {
        const throttled = node({ workerState: 'throttled', workerStateReason: 'CPU ceiling' });
        renderDrawer({ node: throttled, detail: detail({ node: throttled }) });

        expect(screen.getByTestId('fleet-node-drawer-worker-state')).toHaveTextContent(
            'workerStates.throttled',
        );
        expect(screen.getByTestId('fleet-node-drawer-worker-reason')).toHaveTextContent(
            'CPU ceiling',
        );
    });
});

/**
 * Node housekeeping (EW-803).
 *
 * The two facts that used to be invisible from Fleet: the floor a machine
 * enforces on itself (without which a free-space figure means nothing),
 * and whether its reaper has run at all.
 */
describe('FleetNodeDrawer — housekeeping', () => {
    const GIB = 1024 ** 3;

    it('shows a node below its own floor, with both figures', () => {
        // "Online, no jobs, 200 MB free, floor 2 GiB" is the whole story
        // in one line — previously the operator saw only "online".
        const starved = node({
            status: 'online',
            diskFreeBytes: 200 * 1024 ** 2,
            minFreeDiskBytes: 2 * GIB,
        });
        renderDrawer({ node: starved, detail: detail({ node: starved }) });

        expect(screen.getByTestId('fleet-node-drawer-disk-state')).toHaveTextContent(
            'housekeeping.disk.below',
        );
        // Rendered through `formatBytes`, which is base-1000 SI on
        // purpose: the node's owner compares this against what Explorer
        // or Finder shows them, so 200 MiB reads as 210 MB.
        const figures = screen.getByTestId('fleet-node-drawer-disk-figures');
        expect(figures).toHaveTextContent('210 MB');
        expect(figures).toHaveTextContent('2.1 GB');
    });

    it('shows the workspaces retained and the last reclaim', () => {
        const swept = node({
            diskFreeBytes: 40 * GIB,
            minFreeDiskBytes: 2 * GIB,
            workspaceCount: 12,
            workspaceBytes: 30 * GIB,
            lastReclaimAt: '2026-09-05T09:30:00.000Z',
            lastReclaimFreedBytes: 3 * GIB,
        });
        renderDrawer({ node: swept, detail: detail({ node: swept }) });

        expect(screen.getByTestId('fleet-node-drawer-disk-state')).toHaveTextContent(
            'housekeeping.disk.ok',
        );
        expect(screen.getByTestId('fleet-node-drawer-workspaces')).toHaveTextContent('12');
        expect(screen.getByTestId('fleet-node-drawer-last-reclaim')).toHaveTextContent(
            'housekeeping.lastReclaim',
        );
        expect(screen.queryByTestId('fleet-node-drawer-never-reclaimed')).toBeNull();
    });

    it('says a node holding workspaces has never reclaimed, which is the finding', () => {
        // Workspaces reported, no sweep ever reported: the reaper is not
        // running on this machine. That is exactly the state that took a
        // PC to 38 MB free, and it must not read as an absence of data.
        const hoarding = node({
            diskFreeBytes: 3 * GIB,
            minFreeDiskBytes: 2 * GIB,
            workspaceCount: 210,
            workspaceBytes: 180 * GIB,
            lastReclaimAt: null,
        });
        renderDrawer({ node: hoarding, detail: detail({ node: hoarding }) });

        expect(screen.getByTestId('fleet-node-drawer-never-reclaimed')).toBeInTheDocument();
        expect(screen.queryByTestId('fleet-node-drawer-last-reclaim')).toBeNull();
        expect(screen.queryByTestId('fleet-node-drawer-housekeeping-unreported')).toBeNull();
    });

    it('says "not reported" ONCE for a node that has never told us anything', () => {
        // An older daemon, or a visibility-only node. Four dashes would
        // read as four separate faults instead of one silent machine.
        renderDrawer();

        expect(screen.getByTestId('fleet-node-drawer-disk-state')).toHaveTextContent(
            'housekeeping.disk.unknown',
        );
        expect(screen.getByTestId('fleet-node-drawer-housekeeping-unreported')).toBeInTheDocument();
        expect(screen.queryByTestId('fleet-node-drawer-workspaces')).toBeNull();
        expect(screen.queryByTestId('fleet-node-drawer-never-reclaimed')).toBeNull();
    });

    it('never claims a verdict for a node with free space but no floor', () => {
        // The floor is off, or the daemon predates the field. Plenty of
        // space is not the same as "above the line", because there is no
        // line — and saying so would be a reassurance nobody earned.
        const noFloor = node({ diskFreeBytes: 400_000_000_000, minFreeDiskBytes: null });
        renderDrawer({ node: noFloor, detail: detail({ node: noFloor }) });

        expect(screen.getByTestId('fleet-node-drawer-disk-state')).toHaveTextContent(
            'housekeeping.disk.unknown',
        );
        const figures = screen.getByTestId('fleet-node-drawer-disk-figures');
        expect(figures).toHaveTextContent('400 GB');
        // …and says the floor is OFF rather than printing a bare dash,
        // which would look like a missing reading.
        expect(figures).toHaveTextContent('housekeeping.noFloor');
    });
});

describe('FleetNodeDrawer — reconciled job outcome', () => {
    const historyRow = (over: Partial<FleetNodeJobHistoryEntry>): FleetNodeJobHistoryEntry => ({
        ...job(),
        error: null,
        summary: null,
        reconciled: null,
        ...over,
    });

    const withHistory = (rows: FleetNodeJobHistoryEntry[]) =>
        renderDrawer({
            detail: detail({
                recentJobs: rows,
                failures: rows.filter((row) => row.status === 'failed'),
            }),
        });

    it('shows a FAILED run behind a job the node called done', () => {
        withHistory([
            historyRow({
                id: 'job-mixed',
                status: 'done',
                reconciled: {
                    runId: 'run-1',
                    status: 'failed',
                    summary: null,
                    error: 'model refused the plan',
                },
            }),
        ]);

        // The job badge still says what the JOB did — both facts, no lie.
        expect(screen.getByTestId('fleet-node-job-status-job-mixed')).toHaveTextContent(
            'jobs.statuses.done',
        );
        expect(screen.getByTestId('fleet-node-job-outcome-job-mixed')).toHaveTextContent(
            'jobs.outcomes.failed',
        );
        expect(screen.getByTestId('fleet-node-job-outcome-text-job-mixed')).toHaveTextContent(
            'model refused the plan',
        );
    });

    it("shows a failed job's own error text", () => {
        // Previously a red badge with no reason, whose next step was
        // "open a database".
        withHistory([
            historyRow({ id: 'job-red', status: 'failed', error: 'pnpm install exploded' }),
        ]);

        expect(screen.getByTestId('fleet-node-job-outcome-text-job-red')).toHaveTextContent(
            'pnpm install exploded',
        );
    });

    it('shows the run summary for a clean completion', () => {
        withHistory([
            historyRow({
                id: 'job-green',
                reconciled: {
                    runId: 'run-1',
                    status: 'completed',
                    summary: 'Added the missing guard',
                    error: null,
                },
            }),
        ]);

        expect(screen.getByTestId('fleet-node-job-outcome-job-green')).toHaveTextContent(
            'jobs.outcomes.completed',
        );
        expect(screen.getByTestId('fleet-node-job-outcome-text-job-green')).toHaveTextContent(
            'Added the missing guard',
        );
    });

    it('renders the ids-only summary, and NEVER the payload', () => {
        // The load-bearing assertion of this whole file: `payload` is
        // executor input composed from user content. The API sends it as
        // null, and nothing here may start reading it.
        withHistory([
            historyRow({
                id: 'job-ids',
                payload: { instructions: 'PAYLOAD-SENTINEL' } as never,
                summary: {
                    kind: 'agent-task',
                    taskId: 'task-77',
                    runId: 'run-88',
                    agentId: 'agent-99',
                },
            }),
        ]);

        const summary = screen.getByTestId('fleet-node-job-summary-job-ids');
        expect(summary).toHaveTextContent('task-77');
        expect(summary).toHaveTextContent('run-88');
        expect(summary).toHaveTextContent('agent-99');
        expect(document.body.textContent).not.toContain('PAYLOAD-SENTINEL');
    });

    it('renders no outcome line when there is nothing to explain', () => {
        withHistory([historyRow({ id: 'job-quiet' })]);

        expect(screen.getByTestId('fleet-node-job-outcome-job-quiet')).toHaveTextContent(
            'jobs.outcomes.completed',
        );
        expect(screen.queryByTestId('fleet-node-job-outcome-text-job-quiet')).toBeNull();
        expect(screen.queryByTestId('fleet-node-job-summary-job-quiet')).toBeNull();
    });
});
