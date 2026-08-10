import { ConflictException, NotFoundException } from '@nestjs/common';
import { WorkProposalService } from '../work-proposal.service';
import { WorkProposalStatus } from '../../entities/work-proposal.entity';

/**
 * `WorkProposalService.delete` — the guarded hard-delete behind
 * `DELETE /me/work-proposals/:id`.
 *
 * The guards are the whole point of the endpoint: `agents.ideaId` and
 * `tasks.ideaId` are FK-less columns, so an unguarded delete strands
 * them. Each refusal must carry a machine-readable `reason` so the web
 * confirm dialog can name the blocker rather than showing a generic
 * failure.
 */
function makeService(
    overrides: {
        proposal?: Record<string, unknown> | null;
        linkedWorks?: number;
        ideaAgents?: number;
        deleted?: boolean;
    } = {},
) {
    const proposal =
        overrides.proposal === undefined
            ? { id: 'p1', userId: 'u1', title: 'An Idea', status: WorkProposalStatus.PENDING }
            : overrides.proposal;

    const repo = {
        findByIdForUser: jest.fn().mockResolvedValue(proposal),
        deleteForUser: jest.fn().mockResolvedValue(overrides.deleted ?? true),
    };
    const ideaWorks = {
        countForIdea: jest.fn().mockResolvedValue(overrides.linkedWorks ?? 0),
    };
    const agentsRepo = {
        count: jest.fn().mockResolvedValue(overrides.ideaAgents ?? 0),
    };
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };

    const service = new WorkProposalService(
        {} as never, // users
        {} as never, // works
        {} as never, // registry
        {} as never, // aiFacade
        repo as never,
        ideaWorks as never,
        {} as never, // titler
        undefined, // proposalAttachments
        undefined, // uploadsRepo
        activityLog as never,
        undefined, // visionContext
        agentsRepo as never,
    );

    return { service, repo, ideaWorks, agentsRepo, activityLog };
}

/** Pull the structured 409 body out of a thrown ConflictException. */
function conflictBody(error: unknown): { reason?: string; count?: number } {
    expect(error).toBeInstanceOf(ConflictException);
    return (error as ConflictException).getResponse() as { reason?: string; count?: number };
}

describe('WorkProposalService.delete', () => {
    it('deletes an Idea with no Works, Agents or live build', async () => {
        const { service, repo, activityLog } = makeService();

        await expect(service.delete('u1', 'p1')).resolves.toEqual({ deleted: true });
        expect(repo.deleteForUser).toHaveBeenCalledWith('p1', 'u1');
        expect(activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ actionType: 'idea_deleted', userId: 'u1' }),
        );
    });

    it("404s an id that isn't the caller's (existence-leak safe)", async () => {
        const { service, repo } = makeService({ proposal: null });

        await expect(service.delete('u1', 'someone-elses')).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(repo.deleteForUser).not.toHaveBeenCalled();
    });

    it.each([WorkProposalStatus.QUEUED, WorkProposalStatus.BUILDING])(
        'refuses while a build is in flight (%s)',
        async (status) => {
            const { service, repo } = makeService({
                proposal: { id: 'p1', userId: 'u1', title: 'An Idea', status },
            });

            const error = await service.delete('u1', 'p1').catch((e) => e);
            expect(conflictBody(error).reason).toBe('build-in-flight');
            expect(repo.deleteForUser).not.toHaveBeenCalled();
        },
    );

    it('refuses when the Idea still has linked Works, reporting the count', async () => {
        const { service, repo } = makeService({ linkedWorks: 2 });

        const error = await service.delete('u1', 'p1').catch((e) => e);
        expect(conflictBody(error)).toMatchObject({ reason: 'linked-works', count: 2 });
        expect(repo.deleteForUser).not.toHaveBeenCalled();
    });

    it('refuses when Idea-scoped Agents still point at it', async () => {
        const { service, repo } = makeService({ ideaAgents: 3 });

        const error = await service.delete('u1', 'p1').catch((e) => e);
        expect(conflictBody(error)).toMatchObject({ reason: 'idea-agents', count: 3 });
        expect(repo.deleteForUser).not.toHaveBeenCalled();
    });

    it('404s when the row vanished between the guard read and the delete', async () => {
        const { service } = makeService({ deleted: false });

        await expect(service.delete('u1', 'p1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('skips the Agent guard when the Agent repository is not wired', async () => {
        // Hand-rolled constructors (the older specs in this package) omit the
        // trailing agents repo — the delete must still work off its other guards.
        const repo = {
            findByIdForUser: jest.fn().mockResolvedValue({
                id: 'p1',
                userId: 'u1',
                title: 'An Idea',
                status: WorkProposalStatus.PENDING,
            }),
            deleteForUser: jest.fn().mockResolvedValue(true),
        };
        const ideaWorks = { countForIdea: jest.fn().mockResolvedValue(0) };
        const service = new WorkProposalService(
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            repo as never,
            ideaWorks as never,
            {} as never,
        );

        await expect(service.delete('u1', 'p1')).resolves.toEqual({ deleted: true });
    });
});
