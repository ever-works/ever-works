import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FleetNodeView } from '@ever-works/contracts';
import { FleetPanicControls } from './FleetPanicControls';

/**
 * Panic controls (EW-778) — the two owner controls stay two decisions.
 *
 * Pins that draining never opens (let alone triggers) the cancel, that
 * each confirm calls its own action with the right payload, that the
 * cancel copy says it aborts running work, and that the parent receives
 * the drained node views.
 */

const drainAllFleetNodesAction = vi.fn();
const cancelFleetInFlightAction = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
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
vi.mock('@/app/actions/settings/fleet', () => ({
    drainAllFleetNodesAction: (...args: unknown[]) => drainAllFleetNodesAction(...args),
    cancelFleetInFlightAction: (...args: unknown[]) => cancelFleetInFlightAction(...args),
}));
// The dialog primitive is not what is under test; render children in place.
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

function node(over: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: 'node-1',
        name: 'PC',
        kind: 'node',
        status: 'online',
        platform: 'win32/x64',
        version: '1.0.0',
        capabilities: [],
        lastHeartbeatAt: null,
        createdAt: null,
        persisted: true,
        capabilitiesPinned: false,
        ...over,
    } as FleetNodeView;
}

beforeEach(() => {
    drainAllFleetNodesAction.mockReset();
    cancelFleetInFlightAction.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    drainAllFleetNodesAction.mockResolvedValue({
        success: true,
        data: {
            drainedNodes: 1,
            skippedNodes: 0,
            releasedJobs: 2,
            nodes: [node({ status: 'disabled' })],
            auditFailed: false,
        },
        error: null,
    });
    cancelFleetInFlightAction.mockResolvedValue({
        success: true,
        data: {
            requested: 2,
            cancelled: 2,
            runsCancelled: 2,
            byState: { 'queued-dropped': 0, 'cancel-requested': 2, terminal: 0, 'not-found': 0 },
            jobIds: ['job-1', 'job-2'],
            auditFailed: false,
        },
        error: null,
    });
});

describe('FleetPanicControls', () => {
    it('drain-all opens ITS dialog only, and confirming calls only the drain action', async () => {
        const user = userEvent.setup();
        const onNodesDrained = vi.fn();
        render(<FleetPanicControls nodes={[node()]} onNodesDrained={onNodesDrained} />);

        await user.click(screen.getByTestId('fleet-drain-all'));
        expect(screen.getByTestId('fleet-drain-all-body')).toHaveTextContent(
            'drainAll.confirmBody:1',
        );
        // The cancel dialog is NOT open — draining is not cancelling.
        expect(screen.queryByTestId('fleet-cancel-in-flight-confirm')).toBeNull();

        await user.click(screen.getByTestId('fleet-drain-all-confirm'));

        await waitFor(() => expect(drainAllFleetNodesAction).toHaveBeenCalledTimes(1));
        expect(cancelFleetInFlightAction).not.toHaveBeenCalled();
        expect(onNodesDrained).toHaveBeenCalledWith([
            expect.objectContaining({ status: 'disabled' }),
        ]);
        expect(toastSuccess).toHaveBeenCalledWith('drainAll.done:1,2');
    });

    it('cancel-in-flight opens its OWN dialog with the "aborts" copy and defaults includeQueued to false', async () => {
        const user = userEvent.setup();
        render(<FleetPanicControls nodes={[node()]} onNodesDrained={vi.fn()} />);

        await user.click(screen.getByTestId('fleet-cancel-in-flight'));
        expect(screen.getByTestId('fleet-cancel-in-flight-body')).toHaveTextContent(
            'cancelInFlight.confirmBody',
        );
        expect(screen.queryByTestId('fleet-drain-all-confirm')).toBeNull();

        await user.click(screen.getByTestId('fleet-cancel-in-flight-confirm'));

        await waitFor(() => expect(cancelFleetInFlightAction).toHaveBeenCalledTimes(1));
        expect(cancelFleetInFlightAction).toHaveBeenCalledWith({ includeQueued: false });
        expect(drainAllFleetNodesAction).not.toHaveBeenCalled();
        expect(toastSuccess).toHaveBeenCalledWith('cancelInFlight.done:2,2,2');
    });

    it('ticking the checkbox sends includeQueued: true', async () => {
        const user = userEvent.setup();
        render(<FleetPanicControls nodes={[node()]} onNodesDrained={vi.fn()} />);

        await user.click(screen.getByTestId('fleet-cancel-in-flight'));
        await user.click(screen.getByTestId('fleet-cancel-include-queued'));
        await user.click(screen.getByTestId('fleet-cancel-in-flight-confirm'));

        await waitFor(() =>
            expect(cancelFleetInFlightAction).toHaveBeenCalledWith({ includeQueued: true }),
        );
    });

    it('disables drain-all when nothing can be drained (enrolling / disabled / cluster rows)', () => {
        render(
            <FleetPanicControls
                nodes={[
                    node({ id: 'a', status: 'enrolling' }),
                    node({ id: 'b', status: 'disabled' }),
                    node({ id: 'c', kind: 'k8s', persisted: false }),
                ]}
                onNodesDrained={vi.fn()}
            />,
        );
        expect(screen.getByTestId('fleet-drain-all')).toBeDisabled();
        expect(screen.getByTestId('fleet-drain-all-none')).toBeInTheDocument();
        // Cancelling is not gated on nodes: running work may belong to a node that has since gone.
        expect(screen.getByTestId('fleet-cancel-in-flight')).not.toBeDisabled();
    });

    it('surfaces an action failure as a toast and leaves the dialog open', async () => {
        const user = userEvent.setup();
        drainAllFleetNodesAction.mockResolvedValue({ success: false, data: null, error: 'nope' });
        const onNodesDrained = vi.fn();
        render(<FleetPanicControls nodes={[node()]} onNodesDrained={onNodesDrained} />);

        await user.click(screen.getByTestId('fleet-drain-all'));
        await user.click(screen.getByTestId('fleet-drain-all-confirm'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('nope'));
        expect(onNodesDrained).not.toHaveBeenCalled();
        expect(screen.getByTestId('fleet-drain-all-confirm')).toBeInTheDocument();
    });

    it('warns when the action succeeded but its audit row failed', async () => {
        const user = userEvent.setup();
        drainAllFleetNodesAction.mockResolvedValue({
            success: true,
            data: {
                drainedNodes: 1,
                skippedNodes: 0,
                releasedJobs: 0,
                nodes: [],
                auditFailed: true,
            },
            error: null,
        });
        render(<FleetPanicControls nodes={[node()]} onNodesDrained={vi.fn()} />);

        await user.click(screen.getByTestId('fleet-drain-all'));
        await user.click(screen.getByTestId('fleet-drain-all-confirm'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('auditFailed'));
    });
});
