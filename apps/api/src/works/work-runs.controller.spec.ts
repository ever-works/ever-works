// Short-circuit the transitive `@ever-works/agent/*` import chains so the
// test doesn't pull `@src/entities` (which only resolves inside apps/api)
// through the agent-package barrels. House pattern — mirrors
// agents.controller.runtime.spec.ts.
jest.mock('@ever-works/agent/agents', () => ({
    __esModule: true,
    AgentRunRepository: class {},
}));
jest.mock('@ever-works/agent/services', () => ({
    __esModule: true,
    WorkOwnershipService: class {},
}));

import { NotFoundException } from '@nestjs/common';
import { WorkRunsController } from './work-runs.controller';

/**
 * Run orchestration (Wave 4 M3) — per-Work runs-summary endpoint.
 * The scope-guard test is the load-bearing one: the summary counts are
 * Work-scoped, so `ensureAccess` MUST gate the Work before any count
 * query runs (cross-user Works 404, no existence leak).
 */
describe('WorkRunsController', () => {
    const auth = { userId: 'u1' } as any;
    const workId = '00000000-0000-0000-0000-0000000000cc';

    let ownership: any;
    let agentRuns: any;
    let controller: WorkRunsController;

    beforeEach(() => {
        ownership = { ensureAccess: jest.fn().mockResolvedValue({ work: { id: workId } }) };
        agentRuns = {
            summarizeForWork: jest.fn().mockResolvedValue({
                running: 2,
                queued: 3,
                awaiting: 1,
                failedLast24h: 4,
            }),
        };
        controller = new WorkRunsController(ownership, agentRuns);
    });

    it('returns the grouped summary counts for an accessible Work', async () => {
        await expect(controller.runsSummary(auth, workId)).resolves.toEqual({
            running: 2,
            queued: 3,
            awaiting: 1,
            failedLast24h: 4,
        });
        expect(agentRuns.summarizeForWork).toHaveBeenCalledWith(workId);
    });

    it('gates the Work through ensureAccess with the ACTING user before counting', async () => {
        await controller.runsSummary(auth, workId);
        expect(ownership.ensureAccess).toHaveBeenCalledWith(workId, 'u1');
        // Order matters: the guard must run before the count query.
        expect(ownership.ensureAccess.mock.invocationCallOrder[0]).toBeLessThan(
            agentRuns.summarizeForWork.mock.invocationCallOrder[0],
        );
    });

    it('propagates the ownership 404 and never touches the repository (no cross-user leak)', async () => {
        ownership.ensureAccess.mockRejectedValueOnce(new NotFoundException('Work not found'));
        await expect(controller.runsSummary(auth, workId)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(agentRuns.summarizeForWork).not.toHaveBeenCalled();
    });
});
