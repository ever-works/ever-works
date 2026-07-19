import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AgentApprovalsService } from '../agent-approvals.service';
import type { AgentActionProposal } from '../../entities/agent-action-proposal.entity';

/**
 * Service-level tests. Mock the two raw TypeORM repositories. Focus on
 * the business rules: agent-ownership gate on create, risk scoring
 * pass-through, the idempotent decide (409 on re-decide), and
 * cross-user 404 posture.
 */
function makeProposalsRepo() {
    return {
        create: jest.fn((v: Partial<AgentActionProposal>) => v as AgentActionProposal),
        save: jest.fn(
            async (v: AgentActionProposal) => ({ id: 'p1', ...v }) as AgentActionProposal,
        ),
        find: jest.fn(),
        findOne: jest.fn(),
        findAndCount: jest.fn(),
    };
}

function makeAgentsRepo() {
    return {
        findOne: jest.fn(),
    };
}

function makeProposal(overrides: Partial<AgentActionProposal> = {}): AgentActionProposal {
    return {
        id: 'p1',
        userId: 'u1',
        agentId: 'a1',
        runId: null,
        actionType: 'send_message',
        title: 'Ping the ops channel',
        payload: {},
        riskFlags: [],
        status: 'pending',
        decidedById: null,
        decidedAt: null,
        tenantId: null,
        organizationId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...overrides,
    } as AgentActionProposal;
}

describe('AgentApprovalsService', () => {
    let proposals: ReturnType<typeof makeProposalsRepo>;
    let agents: ReturnType<typeof makeAgentsRepo>;
    let svc: AgentApprovalsService;

    beforeEach(() => {
        proposals = makeProposalsRepo();
        agents = makeAgentsRepo();
        svc = new AgentApprovalsService(proposals as any, agents as any);
    });

    describe('createProposal', () => {
        it('rejects an empty title', async () => {
            await expect(
                svc.createProposal('u1', { agentId: 'a1', actionType: 'other', title: '   ' }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('404s when the agent does not belong to the caller', async () => {
            agents.findOne.mockResolvedValue(null);
            await expect(
                svc.createProposal('u1', {
                    agentId: 'a1',
                    actionType: 'other',
                    title: 'do a thing',
                }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(proposals.save).not.toHaveBeenCalled();
        });

        it('computes riskFlags and persists a pending proposal', async () => {
            agents.findOne.mockResolvedValue({ id: 'a1', userId: 'u1' });
            const dto = await svc.createProposal('u1', {
                agentId: 'a1',
                actionType: 'budget_override',
                title: 'Bump the daily cap',
                payload: { destructive: true },
            });
            expect(agents.findOne).toHaveBeenCalledWith({ where: { id: 'a1', userId: 'u1' } });
            expect(dto.status).toBe('pending');
            expect(dto.riskFlags).toEqual(['budget_override', 'destructive']);
            expect(dto.decidedById).toBeNull();
            expect(dto.decidedVia).toBeNull();
        });
    });

    describe('createProposal — dispatch guardrails', () => {
        it('queues exactly as before when the agent has no guardrails', async () => {
            agents.findOne.mockResolvedValue({ id: 'a1', userId: 'u1', guardrails: null });
            const dto = await svc.createProposal('u1', {
                agentId: 'a1',
                actionType: 'send_message',
                title: 'Ping the ops channel',
            });
            expect(dto.status).toBe('pending');
            expect(dto.decidedById).toBeNull();
            expect(dto.decidedAt).toBeNull();
            expect(dto.decidedVia).toBeNull();
        });

        it('auto-approves an unflagged action for an autonomous agent (decidedVia guardrail, no decider)', async () => {
            agents.findOne.mockResolvedValue({
                id: 'a1',
                userId: 'u1',
                guardrails: { mode: 'autonomous' },
            });
            const dto = await svc.createProposal('u1', {
                agentId: 'a1',
                actionType: 'send_message',
                title: 'Ping the ops channel',
            });
            expect(dto.status).toBe('approved');
            expect(dto.decidedVia).toBe('guardrail');
            expect(dto.decidedAt).toBeInstanceOf(Date);
            expect(dto.decidedById).toBeNull();
        });

        it('saves a blocked action type as rejected (audit trail, not a silent drop)', async () => {
            agents.findOne.mockResolvedValue({
                id: 'a1',
                userId: 'u1',
                guardrails: { mode: 'autonomous', blockedActionTypes: ['spawn_agent'] },
            });
            const dto = await svc.createProposal('u1', {
                agentId: 'a1',
                actionType: 'spawn_agent',
                title: 'Spawn a sub-agent',
            });
            expect(proposals.save).toHaveBeenCalledTimes(1);
            expect(dto.status).toBe('rejected');
            expect(dto.decidedVia).toBe('guardrail');
            expect(dto.decidedAt).toBeInstanceOf(Date);
            expect(dto.decidedById).toBeNull();
        });

        it('queues a risk-flagged action even for an autonomous agent', async () => {
            agents.findOne.mockResolvedValue({
                id: 'a1',
                userId: 'u1',
                guardrails: { mode: 'autonomous' },
            });
            const dto = await svc.createProposal('u1', {
                agentId: 'a1',
                actionType: 'other',
                title: 'Purge the cache',
                payload: { destructive: true },
            });
            expect(dto.status).toBe('pending');
            expect(dto.riskFlags).toEqual(['destructive']);
            expect(dto.decidedVia).toBeNull();
        });

        it('queues an autonomous action outside the autoApproveActionTypes narrowing', async () => {
            agents.findOne.mockResolvedValue({
                id: 'a1',
                userId: 'u1',
                guardrails: { mode: 'autonomous', autoApproveActionTypes: ['schedule_task'] },
            });
            const dto = await svc.createProposal('u1', {
                agentId: 'a1',
                actionType: 'send_message',
                title: 'Ping the ops channel',
            });
            expect(dto.status).toBe('pending');
            expect(dto.decidedVia).toBeNull();
        });
    });

    describe('decide', () => {
        it('approves a pending proposal and records the decider + timestamp', async () => {
            proposals.findOne.mockResolvedValue(makeProposal());
            const dto = await svc.decide('u1', 'p1', 'approved');
            expect(dto.status).toBe('approved');
            expect(dto.decidedById).toBe('u1');
            expect(dto.decidedAt).toBeInstanceOf(Date);
            expect(dto.decidedVia).toBe('user');
        });

        it('rejects a pending proposal', async () => {
            proposals.findOne.mockResolvedValue(makeProposal());
            const dto = await svc.decide('u1', 'p1', 'rejected');
            expect(dto.status).toBe('rejected');
            expect(dto.decidedVia).toBe('user');
        });

        it('409s when re-deciding an already-decided proposal (idempotent guard)', async () => {
            proposals.findOne.mockResolvedValue(makeProposal({ status: 'approved' }));
            await expect(svc.decide('u1', 'p1', 'rejected')).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(proposals.save).not.toHaveBeenCalled();
        });

        it("404s (not 403) for another user's proposal", async () => {
            proposals.findOne.mockResolvedValue(null);
            await expect(svc.decide('u1', 'p1', 'approved')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('approveAll', () => {
        it('approves every pending row and skips already-decided ones', async () => {
            const pending1 = makeProposal({ id: 'p1' });
            const pending2 = makeProposal({ id: 'p2' });
            const decided = makeProposal({ id: 'p3', status: 'rejected' });
            proposals.find.mockResolvedValue([pending1, pending2, decided]);

            const result = await svc.approveAll('u1', ['p1', 'p2', 'p3']);

            expect(result).toEqual({ approved: 2, skipped: 1 });
            expect(proposals.find).toHaveBeenCalledWith({
                where: expect.objectContaining({ userId: 'u1' }),
            });
            expect(proposals.save).toHaveBeenCalledTimes(1);
            const saved = proposals.save.mock.calls[0][0] as unknown as AgentActionProposal[];
            expect(saved.map((r) => r.id)).toEqual(['p1', 'p2']);
            for (const row of saved) {
                expect(row.status).toBe('approved');
                expect(row.decidedById).toBe('u1');
                expect(row.decidedAt).toBeInstanceOf(Date);
                expect(row.decidedVia).toBe('user');
            }
        });

        it('approves all my pending proposals when no ids are given', async () => {
            proposals.find.mockResolvedValue([makeProposal({ id: 'p1' })]);

            const result = await svc.approveAll('u1');

            expect(result).toEqual({ approved: 1, skipped: 0 });
            expect(proposals.find).toHaveBeenCalledWith({
                where: { userId: 'u1', status: 'pending' },
            });
        });

        it('does not save when every requested row is already decided', async () => {
            proposals.find.mockResolvedValue([makeProposal({ id: 'p1', status: 'approved' })]);

            const result = await svc.approveAll('u1', ['p1']);

            expect(result).toEqual({ approved: 0, skipped: 1 });
            expect(proposals.save).not.toHaveBeenCalled();
        });

        it('short-circuits on an explicit empty subset', async () => {
            const result = await svc.approveAll('u1', []);

            expect(result).toEqual({ approved: 0, skipped: 0 });
            expect(proposals.find).not.toHaveBeenCalled();
            expect(proposals.save).not.toHaveBeenCalled();
        });
    });

    describe('listPending', () => {
        it('returns the mapped pending rows', async () => {
            proposals.findAndCount.mockResolvedValue([[makeProposal()], 1]);
            const rows = await svc.listPending('u1');
            expect(rows).toHaveLength(1);
            expect(rows[0].id).toBe('p1');
            expect(proposals.findAndCount).toHaveBeenCalledWith(
                expect.objectContaining({ where: { userId: 'u1', status: 'pending' } }),
            );
        });

        it('narrows to an organization when organizationId is given', async () => {
            proposals.findAndCount.mockResolvedValue([[], 0]);
            await svc.listPending('u1', 'org-9');
            expect(proposals.findAndCount).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { userId: 'u1', status: 'pending', organizationId: 'org-9' },
                }),
            );
        });
    });
});
