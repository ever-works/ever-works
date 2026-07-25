import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RunWithAgentMenu } from './RunWithAgentMenu';

/**
 * Board dispatch (kanban M3) — the Run affordance and its agent picker.
 *
 * The load-bearing behaviour is that the component branches on the
 * action's stable `code`, NEVER on a message: production redacts thrown
 * Server-Action messages, so a message-driven UI silently does nothing
 * once deployed.
 */

const runTaskAction = vi.fn();
const listTaskRunCandidatesAction = vi.fn();

vi.mock('@/app/actions/tasks', () => ({
    runTaskAction: (...args: unknown[]) => runTaskAction(...args),
    listTaskRunCandidatesAction: (...args: unknown[]) => listTaskRunCandidatesAction(...args),
}));

describe('RunWithAgentMenu', () => {
    beforeEach(() => {
        runTaskAction.mockReset();
        listTaskRunCandidatesAction.mockReset();
        listTaskRunCandidatesAction.mockResolvedValue([]);
    });

    it('runs with the server-resolved Agent when there is no ambiguity', async () => {
        runTaskAction.mockResolvedValue({
            ok: true,
            run: { taskId: 't1', agentId: 'a1', runId: 'r1', dispatched: true, parked: false },
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        await waitFor(() => expect(runTaskAction).toHaveBeenCalledWith('t1', null));
        expect(await screen.findByText('Run started.')).toBeTruthy();
        expect(screen.queryByTestId('task-run-agent-picker')).toBeNull();
    });

    it('opens the picker with the server-supplied candidates on RUN_AGENT_AMBIGUOUS', async () => {
        runTaskAction.mockResolvedValue({
            ok: false,
            code: 'RUN_AGENT_AMBIGUOUS',
            message: 'pick one',
            candidates: [
                { id: 'a1', name: 'Builder', source: 'assignee' },
                { id: 'a2', name: 'Reviewer', source: 'work-default' },
            ],
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        const picker = await screen.findByTestId('task-run-agent-picker');
        expect(picker).toBeTruthy();
        expect(screen.getAllByTestId('task-run-agent-option')).toHaveLength(2);
        // The candidates came off the failure body — no second round trip.
        expect(listTaskRunCandidatesAction).not.toHaveBeenCalled();
    });

    it('re-dispatches with the chosen Agent when the user picks one', async () => {
        runTaskAction.mockResolvedValueOnce({
            ok: false,
            code: 'RUN_AGENT_AMBIGUOUS',
            message: 'pick one',
            candidates: [
                { id: 'a1', name: 'Builder', source: 'assignee' },
                { id: 'a2', name: 'Reviewer', source: 'work-default' },
            ],
        });
        runTaskAction.mockResolvedValueOnce({
            ok: true,
            run: { taskId: 't1', agentId: 'a2', runId: 'r2', dispatched: true, parked: false },
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        await screen.findByTestId('task-run-agent-picker');
        fireEvent.click(screen.getAllByTestId('task-run-agent-option')[1]);
        await waitFor(() => expect(runTaskAction).toHaveBeenLastCalledWith('t1', 'a2'));
    });

    it('explains RUN_NO_AGENT instead of failing silently', async () => {
        runTaskAction.mockResolvedValue({
            ok: false,
            code: 'RUN_NO_AGENT',
            message: 'no agent',
            candidates: [],
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        expect(await screen.findByText(/No Agent is assigned to this Task/i)).toBeTruthy();
    });

    it('points at the live run on RUN_ALREADY_IN_FLIGHT rather than racing a second one', async () => {
        runTaskAction.mockResolvedValue({
            ok: false,
            code: 'RUN_ALREADY_IN_FLIGHT',
            message: 'already running',
            runId: 'r-live',
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        expect(await screen.findByText(/already in flight/i)).toBeTruthy();
        expect(screen.queryByTestId('task-run-agent-picker')).toBeNull();
    });

    it('reports a parked run as queued-for-capacity, not as a failure', async () => {
        runTaskAction.mockResolvedValue({
            ok: true,
            run: {
                taskId: 't1',
                agentId: 'a1',
                runId: 'r1',
                dispatched: false,
                parked: true,
                queuedReason: 'concurrency-limit',
            },
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        expect(await screen.findByText(/waiting for capacity/i)).toBeTruthy();
    });

    it('loads candidates lazily when the board opens the picker itself (the drag fallback)', async () => {
        listTaskRunCandidatesAction.mockResolvedValue([
            { id: 'a1', name: 'Builder', source: 'work-default' },
        ]);
        render(<RunWithAgentMenu taskId="t1" open onOpenChange={() => undefined} />);
        await waitFor(() => expect(listTaskRunCandidatesAction).toHaveBeenCalledWith('t1'));
        expect(await screen.findByText('Builder')).toBeTruthy();
    });

    it('surfaces an unknown failure code with its message instead of swallowing it', async () => {
        runTaskAction.mockResolvedValue({
            ok: false,
            code: 'RUN_FAILED',
            message: 'job runtime not configured',
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        expect(await screen.findByText('job runtime not configured')).toBeTruthy();
    });
});
