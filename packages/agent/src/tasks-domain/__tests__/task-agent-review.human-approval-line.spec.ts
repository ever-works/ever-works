import 'reflect-metadata';
import { Injectable, Optional } from '@nestjs/common';
import { mergeApprovalSubjectKey } from '@ever-works/contracts';
import { MergeApprovalService } from '../../agent-approvals/merge-approval.service';
import { AgentApprovalsService } from '../../agent-approvals/agent-approvals.service';
import { InjectRepository, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentActionProposal } from '../../entities/agent-action-proposal.entity';
import { TaskRepository } from '../../database/repositories/task.repository';
import { WorkRepository } from '../../database/repositories/work.repository';
import { AgentRepository } from '../../database/repositories/agent.repository';
import { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import { TaskAgentReviewRepository } from '../../database/repositories/task-agent-review.repository';
import {
    TaskApproverRepository,
    TaskAssigneeRepository,
} from '../../database/repositories/task-side.repositories';
import { GitFacadeService } from '../../facades/git.facade';
import { TaskAgentReviewService } from '../task-agent-review.service';
import { agentReviewRunScope } from '../task-agent-review';
import { TaskStatus, type Task } from '../../entities/task.entity';

/**
 * Reviewer agent stage (slice AD, EW-811) — AN AGENT APPROVAL IS NOT A
 * HUMAN APPROVAL.
 *
 * Slice AE (EW-805) requires a recorded HUMAN approval before a merge,
 * verified as `decidedVia === 'user'` with a non-null decider. This slice
 * lets an AGENT write a `task_approvers` row. The two must not meet.
 *
 * Three things are pinned here, all against the REAL services:
 *
 *  1. The refusing layer still refuses. `MergeApprovalService.
 *     verifyMergeApproval` is driven with a proposal row carrying a
 *     non-`'user'` provenance and a real human decider, and still says
 *     `approval-not-human`. Change that check and this test goes red.
 *  2. The reviewer stage cannot reach that table. `TaskAgentReviewService`
 *     is constructed with its full dependency list; there is no proposals
 *     store in it, and its whole write surface for an approval is one
 *     `TaskApproverRepository.setState` call.
 *  3. The verifier does not read `task_approvers`. An approved agent
 *     review changes nothing about the merge verdict.
 */

const TASK_ID = '9f1c0d1e-6c1a-4c3a-9f6c-2b6a0a5d1e77';
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PR = 42;
const KEY = mergeApprovalSubjectKey({ taskId: TASK_ID, prNumber: PR, headSha: HEAD });
const QUERY = { taskId: TASK_ID, prNumber: PR, headSha: HEAD };

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildVerifier(row: Record<string, unknown> | null) {
    const proposals = { findOne: jest.fn().mockResolvedValue(row), count: jest.fn() };
    const tasks = {
        findById: jest.fn().mockResolvedValue({
            id: TASK_ID,
            userId: 'owner-1',
            slug: 'T-42',
            tenantId: 'tenant-1',
            organizationId: 'org-1',
        }),
    };
    const users = {
        findById: jest.fn().mockResolvedValue({
            id: 'human-1',
            isActive: true,
            isAnonymous: false,
            tenantId: 'tenant-1',
        }),
    };
    const approvals = { createProposal: jest.fn() };
    const members = {
        findByOrgAndUser: jest.fn().mockResolvedValue({ id: 'member-1' }),
        countForOrganization: jest.fn().mockResolvedValue(3),
    };
    const tenants = { findById: jest.fn().mockResolvedValue({ id: 'tenant-1' }) };
    const service = new MergeApprovalService(
        proposals as never,
        tasks as never,
        users as never,
        approvals as never,
        members as never,
        tenants as never,
    );
    return { service, proposals };
}

describe('THE LAYER THAT REFUSES an agent approval at the merge gate', () => {
    it('refuses a proposal whose provenance is this slice’s value, decider or not', async () => {
        // Written as the worst case: the row is `approved`, sits under the
        // exact subject key for this head, and names a real, entitled
        // human. The ONLY thing wrong with it is `decidedVia`.
        const { service } = buildVerifier({
            id: 'proposal-1',
            actionType: 'merge_pull_request',
            subjectKey: KEY,
            status: 'approved',
            decidedVia: 'agent-review',
            decidedById: 'human-1',
            decidedAt: new Date(),
        });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approval-not-human',
        });
    });

    it('refuses a guardrail auto-approval — the platform cannot approve its own work', async () => {
        const { service } = buildVerifier({
            id: 'proposal-1',
            actionType: 'merge_pull_request',
            subjectKey: KEY,
            status: 'approved',
            decidedVia: 'guardrail',
            decidedById: null,
            decidedAt: new Date(),
        });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approval-not-human',
        });
    });

    it('refuses a "user" decision with no decider — half a human is not a human', async () => {
        const { service } = buildVerifier({
            id: 'proposal-1',
            actionType: 'merge_pull_request',
            subjectKey: KEY,
            status: 'approved',
            decidedVia: 'user',
            decidedById: null,
            decidedAt: new Date(),
        });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approval-not-human',
        });
    });

    it('reads ONLY agent_action_proposals — an approved agent review is invisible to it', async () => {
        const { service, proposals } = buildVerifier(null);
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approval-missing',
        });
        // The one lookup it makes, and what it filters on. `task_approvers`
        // does not appear anywhere in this verdict.
        expect(proposals.findOne).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    actionType: 'merge_pull_request',
                    subjectKey: KEY,
                    status: 'approved',
                },
            }),
        );
    });
});

/**
 * Throws unless `target`'s constructor reaches neither the
 * `agent_action_proposals` store nor a service that decides on it.
 *
 * Reads what Nest itself resolves injection from: `design:paramtypes`
 * (the declared parameter classes) and `self:paramtypes` (explicit
 * `@Inject` / `@InjectRepository` tokens).
 */
function expectNoMergeApprovalDependency(target: Function): void {
    const paramTypes: unknown[] = Reflect.getMetadata('design:paramtypes', target) ?? [];
    const selfDeclared: Array<{ index: number; param: unknown }> =
        Reflect.getMetadata('self:paramtypes', target) ?? [];
    const tokens = [...paramTypes, ...selfDeclared.map((entry) => entry.param)];
    for (const forbidden of [
        AgentApprovalsService,
        MergeApprovalService,
        // A raw TypeORM repository is how the proposals table is injected.
        Repository,
        getRepositoryToken(AgentActionProposal),
    ]) {
        expect(tokens).not.toContain(forbidden);
    }
}

describe('the reviewer stage cannot reach the merge-approval table', () => {
    function makeTask(over: Partial<Task> = {}): Task {
        return {
            id: 't1',
            slug: 'ew-1',
            title: 'Add the login button',
            userId: 'u1',
            status: TaskStatus.IN_REVIEW,
            workId: 'w1',
            prNumber: PR,
            prHeadSha: HEAD,
            agentId: null,
            ...over,
        } as unknown as Task;
    }

    it('writes exactly ONE row — the approver row — and nothing else', async () => {
        const approvers = {
            findByTaskId: jest.fn(async () => [
                {
                    id: 'app-1',
                    taskId: 't1',
                    approverType: 'agent',
                    approverId: 'reviewer-1',
                    approvalState: 'pending',
                },
            ]),
            setState: jest.fn(async () => undefined),
        };
        const reviews = {
            findOpenForRun: jest.fn(async () => ({
                id: 'rev-1',
                taskId: 't1',
                reviewerAgentId: 'reviewer-1',
                approverId: 'app-1',
                headSha: HEAD,
                runId: 'run-1',
                state: 'dispatched',
            })),
            listRunIdsForTask: jest.fn(async () => ['run-1']),
            casSettle: jest.fn(async () => true),
        };
        const runRows = [
            {
                id: 'run-1',
                agentId: 'reviewer-1',
                taskId: 't1',
                delegationScope: agentReviewRunScope(),
            },
            { id: 'run-0', agentId: 'impl-1', taskId: 't1', delegationScope: null },
        ];
        const svc = new TaskAgentReviewService(
            { findById: jest.fn(async () => makeTask()) } as never,
            reviews as never,
            approvers as never,
            {
                findById: jest.fn(async () => ({
                    id: 'w1',
                    gitProvider: 'github',
                    getRepoOwner: () => 'ever-works',
                    getDataRepo: () => 'ever-works',
                })),
            } as never,
            { findAgentAssignees: jest.fn(async () => []) } as never,
            {
                findById: jest.fn(async (id: string) => runRows.find((row) => row.id === id)),
                findByIds: jest.fn(async (ids: string[]) =>
                    runRows.filter((row) => ids.includes(row.id)),
                ),
                findAuthorAgentIdsForTask: jest.fn(async (_taskId: string, exclude: string[]) =>
                    runRows.filter((row) => !exclude.includes(row.id)).map((row) => row.agentId),
                ),
            } as never,
            { findById: jest.fn(async (id: string) => ({ id, userId: 'u1', slug: id })) } as never,
            {
                getPullRequestStatus: jest.fn(async () => ({
                    number: PR,
                    state: 'open',
                    merged: false,
                    headSha: HEAD,
                    ciState: 'passing',
                    checks: [],
                })),
                getCompareDiff: jest.fn(),
            } as never,
        );

        const result = await svc.submitVerdict({
            runId: 'run-1',
            taskId: 't1',
            reviewerAgentId: 'reviewer-1',
            verdict: 'approve',
        });

        expect(result.reason).toBe('recorded');
        // The provenance is the thing that keeps this legible forever, and
        // its value is not in `AgentActionProposalDecidedVia` at all.
        expect(approvers.setState).toHaveBeenCalledWith(
            'app-1',
            'approved',
            't1',
            expect.objectContaining({ decidedVia: 'agent-review' }),
        );
    });

    it('has no agent_action_proposals dependency in its constructor at all', () => {
        // Structural, not behavioural: the service's dependency list is
        // the reason an agent verdict physically cannot become a merge
        // approval.
        //
        // Checked against the constructor's REAL parameter types — the
        // `design:paramtypes` metadata Nest itself injects by — rather than
        // against `TaskAgentReviewService.toString()`. The old check could
        // never fail for the case it was written for: TypeScript erases
        // parameter types from the compiled class body, so appending
        // `@Optional() private readonly proposals?: AgentActionProposalRepository`
        // left `toString()` without the word `AgentActionProposal`, and the
        // only thing that still bit was the `length` pin, which the next
        // positional append would simply bump.
        const paramTypes: unknown[] =
            Reflect.getMetadata('design:paramtypes', TaskAgentReviewService) ?? [];
        expect(paramTypes.length).toBe(TaskAgentReviewService.length);
        const names = paramTypes.map((type) =>
            typeof type === 'function' ? (type as { name: string }).name : String(type),
        );
        expect(names).toEqual([
            TaskRepository.name,
            TaskAgentReviewRepository.name,
            TaskApproverRepository.name,
            WorkRepository.name,
            TaskAssigneeRepository.name,
            AgentRunRepository.name,
            AgentRepository.name,
            GitFacadeService.name,
        ]);
        expectNoMergeApprovalDependency(TaskAgentReviewService);
    });

    it('the dependency check above can actually fail — a forbidden dependency is detected', () => {
        // Mutation-style self-test, so this spec never again pins a check
        // that cannot bite: the same check, on a class that DOES inject the
        // proposals store (exactly the way `MergeApprovalService` does), is
        // caught — while the old `toString()` probe is blind to it.
        @Injectable()
        class WouldWidenTheMergeGate {
            constructor(
                private readonly tasks: TaskRepository,
                @Optional()
                @InjectRepository(AgentActionProposal)
                private readonly proposals?: Repository<AgentActionProposal>,
            ) {}
        }
        expect(() => expectNoMergeApprovalDependency(WouldWidenTheMergeGate)).toThrow();
        expect(WouldWidenTheMergeGate.toString()).not.toContain('AgentActionProposal');

        @Injectable()
        class WouldDecideProposals {
            constructor(@Optional() private readonly approvals?: AgentApprovalsService) {}
        }
        expect(() => expectNoMergeApprovalDependency(WouldDecideProposals)).toThrow();
    });
});
