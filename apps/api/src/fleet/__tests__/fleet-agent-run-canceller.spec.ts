import { createFleetAwareAgentRunCanceller } from '../fleet-agent-run-canceller';

/**
 * Agent execution v2 (slice B) — the composite run canceller.
 *
 * `agent_runs.triggerRunId` holds a Trigger.dev id (`run_…`) or a fleet
 * job id (uuid). The adapter must reach the right runtime by the SHAPE
 * of the id, fall through on a fleet miss, and never throw.
 */
const FLEET_JOB = '55555555-5555-4555-8555-555555555555';

describe('createFleetAwareAgentRunCanceller', () => {
    let trigger: { cancel: jest.Mock };
    let fleetJobs: { cancel: jest.Mock };

    beforeEach(() => {
        trigger = { cancel: jest.fn().mockResolvedValue('cancelled') };
        fleetJobs = { cancel: jest.fn() };
    });

    const build = () => createFleetAwareAgentRunCanceller(trigger as never, fleetJobs as never);

    it('cancels a fleet job for a uuid id and never touches Trigger.dev', async () => {
        fleetJobs.cancel.mockResolvedValue({ cancelled: true, state: 'cancel-requested' });
        await expect(build().cancel(FLEET_JOB)).resolves.toBe('cancelled');
        expect(fleetJobs.cancel).toHaveBeenCalledWith(FLEET_JOB);
        expect(trigger.cancel).not.toHaveBeenCalled();
    });

    it('reports a terminal fleet job as failed (nothing left to cancel)', async () => {
        fleetJobs.cancel.mockResolvedValue({ cancelled: false, state: 'terminal' });
        await expect(build().cancel(FLEET_JOB)).resolves.toBe('failed');
        expect(trigger.cancel).not.toHaveBeenCalled();
    });

    it('falls through to Trigger.dev when the fleet has no such job', async () => {
        fleetJobs.cancel.mockResolvedValue({ cancelled: false, state: 'not-found' });
        await expect(build().cancel(FLEET_JOB)).resolves.toBe('cancelled');
        expect(trigger.cancel).toHaveBeenCalledWith(FLEET_JOB);
    });

    it('sends a Trigger.dev-shaped id straight to Trigger.dev', async () => {
        await expect(build().cancel('run_abc123')).resolves.toBe('cancelled');
        expect(fleetJobs.cancel).not.toHaveBeenCalled();
        expect(trigger.cancel).toHaveBeenCalledWith('run_abc123');
    });

    it('survives a fleet store failure by falling through', async () => {
        fleetJobs.cancel.mockRejectedValue(new Error('db down'));
        trigger.cancel.mockResolvedValue('failed');
        await expect(build().cancel(FLEET_JOB)).resolves.toBe('failed');
        expect(trigger.cancel).toHaveBeenCalledWith(FLEET_JOB);
    });
});
