import type { GitDiffResult, GitPullRequestStatus } from '@ever-works/plugin';
import { capDiffFiles } from '@ever-works/plugin';
import { TaskStatus, type Task } from '../../entities/task.entity';
import { TaskAgentReviewService } from '../task-agent-review.service';
import { TaskTransitionService } from '../task-transition.service';
import {
    AGENT_REVIEW_DIFF_MAX_BYTES,
    AGENT_REVIEW_DIFF_MAX_FILES,
    agentReviewClaimKey,
    agentReviewRunScope,
} from '../task-agent-review';

/** One `agent_runs` row as the authorship evidence sees it. */
interface RunRow {
    id: string;
    agentId: string;
    taskId?: string;
    delegationScope?: unknown;
}

/**
 * A run-repository double that behaves like the real queries: the
 * authorship read is DISTINCT agents minus the excluded run ids, and
 * `findByIds` returns the rows it was asked for.
 */
function runsFrom(rows: RunRow[]) {
    const withTask = rows.map((row) => ({ taskId: 't1', delegationScope: null, ...row }));
    return {
        findAuthorAgentIdsForTask: jest.fn(async (_taskId: string, exclude: string[] = []) => [
            ...new Set(
                withTask.filter((row) => !exclude.includes(row.id)).map((row) => row.agentId),
            ),
        ]),
        findByIds: jest.fn(async (ids: string[]) => withTask.filter((row) => ids.includes(row.id))),
        findById: jest.fn(async (id: string) => withTask.find((row) => row.id === id) ?? null),
    };
}

/**
 * Reviewer agent stage (slice AD, EW-811) — the DISPATCH half.
 *
 * Every test here drives the real `planReviews`, with real doubles for
 * the stores and the git facade. The three properties under test are the
 * three the brief names: a reviewer never reviews its own work, a diff
 * that cannot be read fails closed, and no path can start an unbounded
 * number of runs.
 */

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        slug: 'ew-1',
        title: 'Add the login button',
        userId: 'u1',
        status: TaskStatus.IN_REVIEW,
        workId: 'w1',
        prNumber: 42,
        prUrl: 'https://example.test/pr/42',
        prHeadSha: HEAD,
        agentId: null,
        tenantId: 'tenant-1',
        organizationId: null,
        ...over,
    } as unknown as Task;
}

function makeDiff(over: Partial<GitDiffResult> = {}): GitDiffResult {
    return {
        files: [{ path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@' }],
        truncated: false,
        totalFiles: 1,
        totalAdditions: 3,
        totalDeletions: 1,
        patchBytes: 2,
        ...over,
    };
}

function makeStatus(over: Partial<GitPullRequestStatus> = {}): GitPullRequestStatus {
    return {
        number: 42,
        state: 'open',
        merged: false,
        headSha: HEAD,
        baseRef: 'main',
        ciState: 'passing',
        checks: [{ name: 'lint-and-test', status: 'completed', conclusion: 'success' }],
        checksComplete: true,
        ...over,
    } as GitPullRequestStatus;
}

interface Harness {
    svc: TaskAgentReviewService;
    tasks: any;
    reviews: any;
    approvers: any;
    works: any;
    assignees: any;
    runs: any;
    agents: any;
    gitFacade: any;
    claimed: any[];
}

function build(over: Partial<Record<string, any>> = {}): Harness {
    const claimed: any[] = [];
    const tasks = { findById: jest.fn(async () => makeTask()) };
    const reviews = {
        countForTask: jest.fn(async () => 0),
        // `claim` reports WHAT it did since Greptile P1-C (the budget slot
        // is allocated inside it): `claimed` with the row, `already-claimed`,
        // or `budget-spent`. It used to return the row or `null`, which had
        // no way to say "the database refused the budget".
        claim: jest.fn(async (input: any) => {
            const row = { id: `rev-${claimed.length + 1}`, ...input, state: 'dispatched' };
            claimed.push(row);
            return { outcome: 'claimed', review: row };
        }),
        findOpenForReviewer: jest.fn(async () => null),
        listRunIdsForTask: jest.fn(async () => []),
        listClaimKeysForTask: jest.fn(async () => claimed.map((row) => row.claimKey)),
        stampRunId: jest.fn(async () => undefined),
        bindRun: jest.fn(async () => undefined),
        casSettle: jest.fn(async () => true),
        listForTask: jest.fn(async () => claimed),
    };
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
        resetAgentDecisionToPending: jest.fn(async () => true),
    };
    const works = {
        findById: jest.fn(async () => ({
            id: 'w1',
            gitProvider: 'github',
            getRepoOwner: () => 'ever-works',
            getDataRepo: () => 'ever-works',
        })),
    };
    const assignees = { findAgentAssignees: jest.fn(async () => []) };
    const runs = runsFrom([{ id: 'run-1', agentId: 'impl-1' }]);
    // Distinct personas by default: slug === id, so nothing is
    // accidentally the same identity. The two-identity test overrides it.
    const agents = {
        findById: jest.fn(async (id: string) => ({ id, userId: 'u1', slug: id })),
    };
    // The review diff is `getCompareDiff(baseRef, headSha)` — pinned to the
    // commit the review binds to — not the pull request's live file list
    // (review of slice AD). Every double in this file stubs THAT call, so a
    // "the diff was never fetched" assertion still means what it says.
    const gitFacade = {
        getPullRequestStatus: jest.fn(async () => makeStatus()),
        getCompareDiff: jest.fn(async () => makeDiff()),
    };
    const parts = { tasks, reviews, approvers, works, assignees, runs, agents, gitFacade, ...over };
    // Positional construction, deliberately: the service's constructor is
    // the thing a future slice will append to, and this is where a shifted
    // parameter shows up.
    const svc = new TaskAgentReviewService(
        parts.tasks as any,
        parts.reviews as any,
        parts.approvers as any,
        parts.works as any,
        parts.assignees as any,
        parts.runs as any,
        parts.agents as any,
        parts.gitFacade as any,
    );
    return { svc, ...(parts as any), claimed };
}

describe('TaskAgentReviewService.planReviews — the happy path', () => {
    it('claims one review per pending agent approver and hands back a brief', async () => {
        const h = build();
        const plan = await h.svc.planReviews(makeTask());

        expect(plan.headSha).toBe(HEAD);
        expect(plan.dispatches).toHaveLength(1);
        expect(plan.dispatches[0]).toMatchObject({
            reviewerAgentId: 'reviewer-1',
            approverId: 'app-1',
            headSha: HEAD,
            dedupKey: `t1:reviewer-1:review:${HEAD}`,
        });
        expect(plan.dispatches[0].brief).toContain('src/a.ts');
        expect(plan.dispatches[0].brief).toContain('Rolled-up verdict for this commit: passing.');
        expect(h.reviews.claim).toHaveBeenCalledTimes(1);
        expect(h.reviews.claim.mock.calls[0][0]).toMatchObject({
            taskId: 't1',
            reviewerAgentId: 'reviewer-1',
            approverId: 'app-1',
            claimKey: `agent-review:reviewer-1:${HEAD}`,
            headSha: HEAD,
            // The lifetime budget travels INTO the claim, where the unique
            // slot enforces it (Greptile P1-C).
            maxRuns: expect.any(Number),
            // Tenancy rides from platform state, never a request.
            tenantId: 'tenant-1',
            workId: 'w1',
        });
    });

    it('reads the repository from the Task Work, never from anything a caller passed', async () => {
        const h = build();
        await h.svc.planReviews(makeTask());
        expect(h.works.findById).toHaveBeenCalledWith('w1');
        // Pinned to the LIVE head commit, against the pull request's own
        // base branch — both from the provider's status read.
        expect(h.gitFacade.getCompareDiff).toHaveBeenCalledWith(
            'ever-works',
            'ever-works',
            'main',
            HEAD,
            expect.objectContaining({ maxBytes: expect.any(Number) }),
            { userId: 'u1', providerId: 'github', workId: 'w1' },
        );
    });

    it('ignores non-agent approvers and already-decided ones', async () => {
        // REVERSED CONTRACT (Greptile P1-A on PR #2419): "already decided"
        // used to mean `approvalState !== 'pending'`, full stop — so an agent
        // that approved commit A was never asked about commit B, and that
        // approval passed the `→ done` gate for B. Already decided now means
        // an `agent-review` verdict about the head under review, which is
        // what this fixture carries. A decision about another commit, or one
        // without that provenance, is re-reviewed — pinned in the
        // "A DECISION ABOUT ANOTHER COMMIT" block below.
        const h = build({
            approvers: {
                findByTaskId: jest.fn(async () => [
                    { id: 'a', approverType: 'user', approverId: 'u9', approvalState: 'pending' },
                    {
                        id: 'b',
                        approverType: 'agent',
                        approverId: 'reviewer-1',
                        approvalState: 'approved',
                        decidedVia: 'agent-review',
                        decidedHeadSha: HEAD,
                    },
                ]),
                setState: jest.fn(),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.reason).toBe('no-agent-approvers');
        expect(h.reviews.claim).not.toHaveBeenCalled();
    });
});

describe('THE self-review refusal — enforced by the platform, at dispatch', () => {
    it('refuses when the only approver is the agent that RAN on the Task', async () => {
        const h = build({
            approvers: {
                findByTaskId: jest.fn(async () => [
                    {
                        id: 'app-1',
                        approverType: 'agent',
                        approverId: 'impl-1',
                        approvalState: 'pending',
                    },
                ]),
                setState: jest.fn(),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.dispatches).toHaveLength(0);
        expect(plan.decisions).toEqual([{ reviewerAgentId: 'impl-1', reason: 'self-review' }]);
        // No money spent: nothing claimed, no run planned — and the
        // refusal is decided BEFORE the provider is touched, so a Task
        // whose only approver wrote the code costs not even a diff fetch.
        expect(h.reviews.claim).not.toHaveBeenCalled();
        expect(h.gitFacade.getPullRequestStatus).not.toHaveBeenCalled();
        expect(h.gitFacade.getCompareDiff).not.toHaveBeenCalled();
    });

    it('refuses the agent the Task is ASSIGNED to, even before it has run', async () => {
        const h = build({
            runs: runsFrom([]),
            approvers: {
                findByTaskId: jest.fn(async () => [
                    {
                        id: 'app-1',
                        approverType: 'agent',
                        approverId: 'owner-agent',
                        approvalState: 'pending',
                    },
                ]),
                setState: jest.fn(),
            },
        });
        const plan = await h.svc.planReviews(makeTask({ agentId: 'owner-agent' }));
        expect(plan.decisions).toEqual([{ reviewerAgentId: 'owner-agent', reason: 'self-review' }]);
    });

    it('refuses a SECOND agent row wearing the implementer’s identity', async () => {
        // `agents` is unique per SCOPE, so one owner can hold a
        // tenant-scope and a work-scope row with the same slug. Two ids,
        // one persona — and approving your own work from your other id is
        // still approving your own work.
        const h = build({
            agents: {
                findById: jest.fn(async (id: string) => ({
                    id,
                    userId: 'u1',
                    slug: 'fixer',
                })),
            },
            approvers: {
                findByTaskId: jest.fn(async () => [
                    {
                        id: 'app-1',
                        approverType: 'agent',
                        approverId: 'impl-1-other-scope',
                        approvalState: 'pending',
                    },
                ]),
                setState: jest.fn(),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.decisions).toEqual([
            { reviewerAgentId: 'impl-1-other-scope', reason: 'self-review' },
        ]);
        expect(h.reviews.claim).not.toHaveBeenCalled();
    });

    it('does NOT disqualify a reviewer for its OWN earlier review run', async () => {
        // A review run is an agent_runs row on the Task like any other.
        // Without leaving it out, a second-round review could never happen
        // — every reviewer would disqualify itself.
        const h = build({
            runs: runsFrom([
                {
                    id: 'run-review-1',
                    agentId: 'reviewer-1',
                    // Admitted with the review-only scope: provably wrote
                    // nothing.
                    delegationScope: agentReviewRunScope(),
                },
                { id: 'run-1', agentId: 'impl-1' },
            ]),
            reviews: {
                countForTask: jest.fn(async () => 1),
                claim: jest.fn(async (input: any) => ({
                    outcome: 'claimed',
                    review: { id: 'rev-2', ...input },
                })),
                listRunIdsForTask: jest.fn(async () => ['run-review-1']),
                listClaimKeysForTask: jest.fn(async () => []),
                stampRunId: jest.fn(),
                casSettle: jest.fn(),
                findOpenForReviewer: jest.fn(),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.dispatches).toHaveLength(1);
        expect(plan.dispatches[0].reviewerAgentId).toBe('reviewer-1');
        expect(h.runs.findAuthorAgentIdsForTask).toHaveBeenCalledWith('t1', ['run-review-1']);
    });

    it('DOES disqualify a reviewer whose ledger-bound run was NOT review-scoped — it could have written code', async () => {
        // The finding: every ledger run id used to be subtracted from the
        // authorship evidence unconditionally, while the review run itself
        // had the full tool surface and a workspace that finalize pushes.
        // A reviewer that pushed commits on round one was then invisible
        // as an author on round two, and cleared to approve its own code.
        // Being IN the ledger no longer exempts a run; only a run whose own
        // row proves the review-only scope is left out.
        const h = build({
            runs: runsFrom([
                { id: 'run-review-1', agentId: 'reviewer-1', delegationScope: null },
                { id: 'run-1', agentId: 'impl-1' },
            ]),
            reviews: {
                countForTask: jest.fn(async () => 1),
                claim: jest.fn(),
                listRunIdsForTask: jest.fn(async () => ['run-review-1']),
                listClaimKeysForTask: jest.fn(async () => []),
                stampRunId: jest.fn(),
                casSettle: jest.fn(),
                findOpenForReviewer: jest.fn(),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.dispatches).toHaveLength(0);
        expect(plan.decisions).toEqual([{ reviewerAgentId: 'reviewer-1', reason: 'self-review' }]);
        expect(h.reviews.claim).not.toHaveBeenCalled();
        expect(h.gitFacade.getCompareDiff).not.toHaveBeenCalled();
    });

    it('does not exempt a review-scoped run that belongs to ANOTHER Task', async () => {
        const h = build({
            runs: runsFrom([
                {
                    id: 'run-review-1',
                    agentId: 'reviewer-1',
                    taskId: 'some-other-task',
                    delegationScope: agentReviewRunScope(),
                },
            ]),
            reviews: {
                countForTask: jest.fn(async () => 1),
                claim: jest.fn(),
                listRunIdsForTask: jest.fn(async () => ['run-review-1']),
                listClaimKeysForTask: jest.fn(async () => []),
                stampRunId: jest.fn(),
                casSettle: jest.fn(),
                findOpenForReviewer: jest.fn(),
            },
        });
        await h.svc.planReviews(makeTask());
        expect(h.runs.findAuthorAgentIdsForTask).toHaveBeenCalledWith('t1', []);
    });

    it('reads the WHOLE run history — no row cap a long-lived Task can age an implementer out of', async () => {
        // The finding: the evidence was the 50 newest runs, silently. An
        // implementer that ran early and was then unassigned fell out of
        // the window behind 50 newer runs and stopped counting as an
        // author. The evidence is now the distinct agent set over every
        // run (pinned against a real database in the wiring spec).
        const newer = Array.from({ length: 80 }, (_, index) => ({
            id: `run-chat-${index}`,
            agentId: 'someone-else',
        }));
        const h = build({
            runs: runsFrom([{ id: 'run-0', agentId: 'early-implementer' }, ...newer]),
            approvers: {
                findByTaskId: jest.fn(async () => [
                    {
                        id: 'app-1',
                        approverType: 'agent',
                        approverId: 'early-implementer',
                        approvalState: 'pending',
                    },
                ]),
                setState: jest.fn(),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.decisions).toEqual([
            { reviewerAgentId: 'early-implementer', reason: 'self-review' },
        ]);
        expect(h.runs.findAuthorAgentIdsForTask.mock.calls[0]).toHaveLength(2);
    });

    it('refuses rather than guessing when the run history cannot be read', async () => {
        const h = build({
            runs: {
                ...runsFrom([]),
                findAuthorAgentIdsForTask: jest.fn(async () => {
                    throw new Error('db down');
                }),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.decisions).toEqual([
            { reviewerAgentId: 'reviewer-1', reason: 'reviewer-unreadable' },
        ]);
        expect(h.reviews.claim).not.toHaveBeenCalled();
    });

    it('refuses when there is no run repository at all — fail closed, not fail open', async () => {
        const h = build({ runs: undefined });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.decisions).toEqual([
            { reviewerAgentId: 'reviewer-1', reason: 'reviewer-unreadable' },
        ]);
    });

    it('refuses when the reviewer’s own agent row cannot be read', async () => {
        const h = build({ agents: { findById: jest.fn(async () => null) } });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.decisions).toEqual([
            { reviewerAgentId: 'reviewer-1', reason: 'reviewer-unreadable' },
        ]);
    });
});

describe('a diff that cannot be reviewed never becomes an approval', () => {
    it('fails closed when the diff FETCH throws', async () => {
        const h = build({
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => makeStatus()),
                getCompareDiff: jest.fn(async () => {
                    throw new Error('getCompareDiff is not supported by this provider');
                }),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.reason).toBe('diff-unavailable');
        expect(plan.headSha).toBe(HEAD);
        expect(plan.dispatches).toHaveLength(0);
        expect(h.reviews.claim).not.toHaveBeenCalled();
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });

    // Review of slice AD: the diff used to be the pull request's LIVE file
    // list, read after the status call. A push between the two (or the
    // provider's file list lagging a push) bound the review to one commit
    // and showed the reviewer another; a force-push back before the verdict
    // then passed the stale-head check.
    it('reads the diff AT the bound head commit — never the pull request’s moving file list', async () => {
        const moved = makeDiff({
            files: [
                {
                    path: 'src/evil.ts',
                    status: 'modified',
                    additions: 1,
                    deletions: 0,
                    patch: '@@ evil',
                },
            ],
        });
        const h = build({
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => makeStatus({ baseRef: 'develop' })),
                getCompareDiff: jest.fn(
                    async (_o: string, _r: string, base: string, head: string) =>
                        base === 'develop' && head === HEAD ? makeDiff() : moved,
                ),
                // What a moved head would have shown. Never consulted.
                getPullRequestDiff: jest.fn(async () => moved),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.dispatches).toHaveLength(1);
        expect(h.gitFacade.getCompareDiff).toHaveBeenCalledWith(
            'ever-works',
            'ever-works',
            'develop',
            HEAD,
            expect.any(Object),
            expect.any(Object),
        );
        expect(h.gitFacade.getPullRequestDiff).not.toHaveBeenCalled();
        expect(plan.dispatches[0].brief).toContain('src/a.ts');
        expect(plan.dispatches[0].brief).not.toContain('src/evil.ts');
        expect(h.reviews.claim.mock.calls[0][0].headSha).toBe(HEAD);
    });

    it('fails closed when the provider reports no base branch — the diff cannot be pinned', async () => {
        for (const baseRef of [null, undefined, '', '   ']) {
            const h = build({
                gitFacade: {
                    getPullRequestStatus: jest.fn(async () => makeStatus({ baseRef })),
                    getCompareDiff: jest.fn(async () => makeDiff()),
                    getPullRequestDiff: jest.fn(async () => makeDiff()),
                },
            });
            const plan = await h.svc.planReviews(makeTask());
            expect(plan.reason).toBe('diff-unavailable');
            expect(plan.dispatches).toHaveLength(0);
            expect(h.gitFacade.getCompareDiff).not.toHaveBeenCalled();
            expect(h.gitFacade.getPullRequestDiff).not.toHaveBeenCalled();
            expect(h.reviews.claim).not.toHaveBeenCalled();
        }
    });

    it('fails closed on an OVERSIZED (truncated) diff', async () => {
        const h = build({
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => makeStatus()),
                getCompareDiff: jest.fn(async () => makeDiff({ truncated: true })),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.reason).toBe('diff-too-large');
        expect(h.reviews.claim).not.toHaveBeenCalled();
    });

    it('fails closed on an EMPTY diff', async () => {
        const h = build({
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => makeStatus()),
                getCompareDiff: jest.fn(async () => makeDiff({ files: [], totalFiles: 0 })),
            },
        });
        expect((await h.svc.planReviews(makeTask())).reason).toBe('diff-empty');
    });

    it('fails closed when the pull request itself cannot be read', async () => {
        for (const facade of [
            {
                getPullRequestStatus: jest.fn(async () => {
                    throw new Error('boom');
                }),
                getCompareDiff: jest.fn(),
            },
            { getPullRequestStatus: jest.fn(async () => null), getCompareDiff: jest.fn() },
        ]) {
            const h = build({ gitFacade: facade });
            expect((await h.svc.planReviews(makeTask())).reason).toBe('pr-unreadable');
            expect(facade.getCompareDiff).not.toHaveBeenCalled();
        }
    });

    it('fails closed when no git facade is bound', async () => {
        const h = build({ gitFacade: undefined });
        expect((await h.svc.planReviews(makeTask())).reason).toBe('pr-unreadable');
    });

    it('refuses when no head commit can be resolved — an approval must bind to a commit', async () => {
        const h = build({
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => makeStatus({ headSha: null })),
                getCompareDiff: jest.fn(),
            },
        });
        const plan = await h.svc.planReviews(
            makeTask({ prHeadSha: null, ciHeadSha: null } as Partial<Task>),
        );
        expect(plan.reason).toBe('head-unknown');
    });

    it('never fills a missing LIVE head in from the Task cache — the claim would bind a commit nobody reviewed', async () => {
        // The finding: `normalizeCommitSha(status.headSha) ?? resolveReviewHead(task)`
        // bound the claim key, the ledger row and every later staleness
        // check to a CACHED head, while the diff was fetched at whatever
        // the pull request's head actually was.
        const h = build({
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => makeStatus({ headSha: 'not-a-sha' })),
                getCompareDiff: jest.fn(async () => makeDiff()),
            },
        });
        const plan = await h.svc.planReviews(makeTask({ prHeadSha: OTHER_HEAD }));
        expect(plan.reason).toBe('head-unknown');
        expect(h.gitFacade.getCompareDiff).not.toHaveBeenCalled();
        expect(h.reviews.claim).not.toHaveBeenCalled();
    });

    it('fails closed when the diff is in-cap but the whole brief would not fit the budget', async () => {
        // Provider says NOT truncated, so `assessReviewDiff` passes it; the
        // brief refuses instead of silently cutting the tail and the
        // verdict instructions off.
        const h = build({
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => makeStatus()),
                getCompareDiff: jest.fn(async () =>
                    makeDiff({
                        files: Array.from({ length: 40 }, (_, index) => ({
                            path: `src/f${index}.ts`,
                            status: 'modified',
                            additions: 1,
                            deletions: 1,
                            patch: 'x'.repeat(2_500),
                        })),
                        totalFiles: 40,
                        truncated: false,
                    }),
                ),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.reason).toBe('diff-too-large');
        expect(plan.dispatches).toHaveLength(0);
        expect(h.reviews.claim).not.toHaveBeenCalled();
    });

    it('does not review a closed or merged pull request', async () => {
        for (const state of ['closed', 'merged'] as const) {
            const h = build({
                gitFacade: {
                    getPullRequestStatus: jest.fn(async () => makeStatus({ state })),
                    getCompareDiff: jest.fn(),
                },
            });
            expect((await h.svc.planReviews(makeTask())).reason).toBe('pr-closed');
        }
    });

    it('does not review a Task with no pull request, or no Work', async () => {
        expect((await build().svc.planReviews(makeTask({ prNumber: null }))).reason).toBe(
            'no-pull-request',
        );
        expect((await build().svc.planReviews(makeTask({ workId: null }))).reason).toBe('no-work');
    });
});

describe('BOUNDED COST — every path that can start a review run', () => {
    it('is OFF when the lifetime budget is 0, and costs not even a provider call', async () => {
        const previous = process.env.TASK_AGENT_REVIEW_MAX_RUNS;
        process.env.TASK_AGENT_REVIEW_MAX_RUNS = '0';
        try {
            const h = build();
            expect((await h.svc.planReviews(makeTask())).reason).toBe('disabled');
            expect(h.gitFacade.getPullRequestStatus).not.toHaveBeenCalled();
        } finally {
            if (previous === undefined) delete process.env.TASK_AGENT_REVIEW_MAX_RUNS;
            else process.env.TASK_AGENT_REVIEW_MAX_RUNS = previous;
        }
    });

    it('refuses once the Task has spent its lifetime budget — BEFORE any provider call', async () => {
        const h = build({ reviews: { countForTask: jest.fn(async () => 4), claim: jest.fn() } });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.reason).toBe('budget-spent');
        expect(h.gitFacade.getPullRequestStatus).not.toHaveBeenCalled();
    });

    it('STOPS when the budget cannot be read — a budget nobody can count is not a budget', async () => {
        const h = build({
            reviews: {
                countForTask: jest.fn(async () => {
                    throw new Error('db down');
                }),
                claim: jest.fn(),
            },
        });
        // Named, not swallowed into the generic `error`: the reason union
        // is what the operator reads, and "we did nothing and cannot say
        // why" is not an option for something that spends money.
        expect((await h.svc.planReviews(makeTask())).reason).toBe('budget-unreadable');
        expect(h.gitFacade.getPullRequestStatus).not.toHaveBeenCalled();
    });

    it('caps ONE entry’s fan-out, however many approvers are attached', async () => {
        const previous = process.env.TASK_AGENT_REVIEW_MAX_APPROVERS;
        process.env.TASK_AGENT_REVIEW_MAX_APPROVERS = '2';
        try {
            const h = build({
                approvers: {
                    findByTaskId: jest.fn(async () =>
                        ['r1', 'r2', 'r3', 'r4'].map((id, index) => ({
                            id: `app-${index}`,
                            approverType: 'agent',
                            approverId: id,
                            approvalState: 'pending',
                        })),
                    ),
                    setState: jest.fn(),
                },
            });
            const plan = await h.svc.planReviews(makeTask());
            expect(plan.dispatches).toHaveLength(2);
            expect(plan.decisions.filter((d) => d.reason === 'approver-cap')).toHaveLength(2);
        } finally {
            if (previous === undefined) delete process.env.TASK_AGENT_REVIEW_MAX_APPROVERS;
            else process.env.TASK_AGENT_REVIEW_MAX_APPROVERS = previous;
        }
    });

    it('never spends more than the REMAINING lifetime budget in one entry', async () => {
        const previous = process.env.TASK_AGENT_REVIEW_MAX_RUNS;
        process.env.TASK_AGENT_REVIEW_MAX_RUNS = '3';
        try {
            const h = build({
                reviews: {
                    // Two already spent, so exactly one is left even though
                    // two approvers are eligible and the per-entry cap is 2.
                    countForTask: jest.fn(async () => 2),
                    claim: jest.fn(async (input: any) => ({
                        outcome: 'claimed',
                        review: { id: 'rev-x', ...input },
                    })),
                    listRunIdsForTask: jest.fn(async () => []),
                    listClaimKeysForTask: jest.fn(async () => []),
                    stampRunId: jest.fn(),
                    casSettle: jest.fn(),
                    findOpenForReviewer: jest.fn(),
                },
                approvers: {
                    findByTaskId: jest.fn(async () =>
                        ['r1', 'r2'].map((id, index) => ({
                            id: `app-${index}`,
                            approverType: 'agent',
                            approverId: id,
                            approvalState: 'pending',
                        })),
                    ),
                    setState: jest.fn(),
                },
            });
            const plan = await h.svc.planReviews(makeTask());
            expect(plan.dispatches).toHaveLength(1);
            expect(plan.decisions.map((d) => d.reason)).toEqual(['dispatched', 'budget-spent']);
        } finally {
            if (previous === undefined) delete process.env.TASK_AGENT_REVIEW_MAX_RUNS;
            else process.env.TASK_AGENT_REVIEW_MAX_RUNS = previous;
        }
    });

    it('re-entering review on the SAME commit buys nothing — the claim loses', async () => {
        // The unique (taskId, claimKey) index makes the repository return
        // null. That is the retried transition, the flip-flop, the replica
        // race and the review run that transitions its own Task.
        const h = build({
            reviews: {
                countForTask: jest.fn(async () => 1),
                // `null` before Greptile P1-C; the same outcome, named.
                claim: jest.fn(async () => ({ outcome: 'already-claimed' })),
                listRunIdsForTask: jest.fn(async () => []),
                // The pre-claim check sees nothing (a replica race: the
                // winner's row lands between the read and the insert), so
                // the unique index is what decides — and it still says no.
                listClaimKeysForTask: jest.fn(async () => []),
                stampRunId: jest.fn(),
                casSettle: jest.fn(),
                findOpenForReviewer: jest.fn(),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.dispatches).toHaveLength(0);
        expect(plan.decisions).toEqual([
            { reviewerAgentId: 'reviewer-1', reason: 'already-claimed' },
        ]);
    });

    it('a re-entry on an already-claimed commit costs NO provider call — not a status read, not a diff', async () => {
        // The finding: status + an up-to-80 KB diff were fetched on EVERY
        // entry into in_review, and only then did the claim collide, so a
        // Task dragged in and out of review paid two provider calls per
        // flip, forever, for zero runs.
        const h = build({
            reviews: {
                countForTask: jest.fn(async () => 1),
                claim: jest.fn(),
                listRunIdsForTask: jest.fn(async () => []),
                listClaimKeysForTask: jest.fn(async () => [
                    agentReviewClaimKey('reviewer-1', HEAD),
                ]),
                stampRunId: jest.fn(),
                casSettle: jest.fn(),
                findOpenForReviewer: jest.fn(),
            },
        });
        for (let flip = 0; flip < 5; flip += 1) {
            const plan = await h.svc.planReviews(makeTask());
            expect(plan.dispatches).toHaveLength(0);
            expect(plan.decisions).toEqual([
                { reviewerAgentId: 'reviewer-1', reason: 'already-claimed' },
            ]);
        }
        expect(h.gitFacade.getPullRequestStatus).not.toHaveBeenCalled();
        expect(h.gitFacade.getCompareDiff).not.toHaveBeenCalled();
        expect(h.reviews.claim).not.toHaveBeenCalled();
    });

    it('still reads the provider when only SOME eligible reviewers hold a claim for the cached head', async () => {
        const h = build({
            reviews: {
                countForTask: jest.fn(async () => 1),
                claim: jest.fn(async (input: any) => ({
                    outcome: 'claimed',
                    review: { id: 'rev-2', ...input },
                })),
                listRunIdsForTask: jest.fn(async () => []),
                listClaimKeysForTask: jest.fn(async () => [agentReviewClaimKey('r1', HEAD)]),
                stampRunId: jest.fn(),
                casSettle: jest.fn(),
                findOpenForReviewer: jest.fn(),
            },
            approvers: {
                findByTaskId: jest.fn(async () =>
                    ['r1', 'r2'].map((id, index) => ({
                        id: `app-${index}`,
                        approverType: 'agent',
                        approverId: id,
                        approvalState: 'pending',
                    })),
                ),
                setState: jest.fn(),
            },
        });
        await h.svc.planReviews(makeTask());
        expect(h.gitFacade.getPullRequestStatus).toHaveBeenCalledTimes(1);
        expect(h.reviews.claim).toHaveBeenCalled();
    });

    it('a NEW push is a new commit and therefore a new claim key', async () => {
        const h = build();
        await h.svc.planReviews(makeTask());
        h.gitFacade.getPullRequestStatus.mockResolvedValue(makeStatus({ headSha: OTHER_HEAD }));
        await h.svc.planReviews(makeTask({ prHeadSha: OTHER_HEAD }));
        expect(h.reviews.claim.mock.calls.map((call: any[]) => call[0].claimKey)).toEqual([
            `agent-review:reviewer-1:${HEAD}`,
            `agent-review:reviewer-1:${OTHER_HEAD}`,
        ]);
    });

    it('does nothing at all when the Task is not in review', async () => {
        const h = build();
        const plan = await h.svc.planReviews(makeTask({ status: TaskStatus.IN_PROGRESS }));
        expect(plan.reason).toBe('not-in-review');
        expect(h.approvers.findByTaskId).not.toHaveBeenCalled();
    });

    it('never throws — a review hiccup must not roll back a status change', async () => {
        const h = build({
            approvers: {
                findByTaskId: jest.fn(async () => {
                    throw new Error('db down');
                }),
                setState: jest.fn(),
            },
        });
        await expect(h.svc.planReviews(makeTask())).resolves.toMatchObject({ reason: 'error' });
    });

    it('stops when the DATABASE refuses the budget, even though the count said a slot was left (Greptile P1-C)', async () => {
        // The count is read before the provider calls; another planner can
        // spend the last slot in between. The claim's unique slot is the
        // bound, and its `budget-spent` must stop this entry outright —
        // nothing dispatched, and no later approver even tries.
        const h = build({
            reviews: {
                countForTask: jest.fn(async () => 0),
                claim: jest.fn(async () => ({ outcome: 'budget-spent' })),
                listRunIdsForTask: jest.fn(async () => []),
                listClaimKeysForTask: jest.fn(async () => []),
                stampRunId: jest.fn(),
                casSettle: jest.fn(),
                findOpenForReviewer: jest.fn(),
            },
            approvers: {
                findByTaskId: jest.fn(async () =>
                    ['r1', 'r2'].map((id, index) => ({
                        id: `app-${index}`,
                        approverType: 'agent',
                        approverId: id,
                        approvalState: 'pending',
                    })),
                ),
                setState: jest.fn(),
                resetAgentDecisionToPending: jest.fn(),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.dispatches).toHaveLength(0);
        expect(plan.decisions).toEqual([
            { reviewerAgentId: 'r1', reason: 'budget-spent' },
            { reviewerAgentId: 'r2', reason: 'budget-spent' },
        ]);
        expect(h.reviews.claim).toHaveBeenCalledTimes(1);
    });

    it('fails closed on a claim outcome it does not recognise', async () => {
        const h = build({
            reviews: {
                countForTask: jest.fn(async () => 0),
                claim: jest.fn(async () => ({ outcome: 'something-new' })),
                listRunIdsForTask: jest.fn(async () => []),
                listClaimKeysForTask: jest.fn(async () => []),
                stampRunId: jest.fn(),
                casSettle: jest.fn(),
                findOpenForReviewer: jest.fn(),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.dispatches).toHaveLength(0);
        expect(plan.decisions).toEqual([{ reviewerAgentId: 'reviewer-1', reason: 'budget-spent' }]);
    });

    it('a claim that THROWS mid-loop keeps the reviews already claimed — they are still dispatched (review of P1-C)', async () => {
        // The finding: the throw escaped to `planReviews`' catch, which
        // returned `dispatches: []`. The review claimed a moment earlier kept
        // its `dispatched` row, its budget slot and its claim key — so every
        // later plan at this head said `already-claimed` for it — and no run
        // was ever started or settled for it.
        const claimed: any[] = [];
        const h = build({
            reviews: {
                countForTask: jest.fn(async () => 0),
                claim: jest
                    .fn()
                    .mockImplementationOnce(async (input: any) => {
                        const row = { id: 'rev-r1', ...input, state: 'dispatched' };
                        claimed.push(row);
                        return { outcome: 'claimed', review: row };
                    })
                    .mockImplementationOnce(async () => {
                        throw new Error('pool acquire timeout');
                    }),
                listRunIdsForTask: jest.fn(async () => []),
                listClaimKeysForTask: jest.fn(async () => []),
                stampRunId: jest.fn(),
                casSettle: jest.fn(),
                findOpenForReviewer: jest.fn(),
            },
            approvers: {
                findByTaskId: jest.fn(async () =>
                    ['r1', 'r2', 'r3'].map((id, index) => ({
                        id: `app-${index}`,
                        approverType: 'agent',
                        approverId: id,
                        approvalState: 'pending',
                    })),
                ),
                setState: jest.fn(),
            },
        });
        const previous = process.env.TASK_AGENT_REVIEW_MAX_APPROVERS;
        process.env.TASK_AGENT_REVIEW_MAX_APPROVERS = '3';
        try {
            const plan = await h.svc.planReviews(makeTask());
            expect(plan.reason).toBe('error');
            expect(plan.dispatches.map((dispatch) => dispatch.reviewId)).toEqual(['rev-r1']);
            expect(plan.decisions).toEqual([
                { reviewerAgentId: 'r1', reason: 'dispatched', reviewId: 'rev-r1' },
                { reviewerAgentId: 'r2', reason: 'error' },
                // Nothing more is claimed against a store that just failed.
                { reviewerAgentId: 'r3', reason: 'error' },
            ]);
            expect(h.reviews.claim).toHaveBeenCalledTimes(2);
        } finally {
            if (previous === undefined) delete process.env.TASK_AGENT_REVIEW_MAX_APPROVERS;
            else process.env.TASK_AGENT_REVIEW_MAX_APPROVERS = previous;
        }
    });
});

describe('A DECISION ABOUT ANOTHER COMMIT is not a review of this one (Greptile P1-A)', () => {
    /**
     * Greptile P1-A on PR #2419: the planner only ever considered PENDING
     * agent approvers, so an agent that approved head A was never asked
     * about head B, and its approval stood in for a review of B at the
     * `→ done` gate. A decided agent row is now re-reviewed unless its
     * decision is an `agent-review` verdict about the LIVE head, and the
     * stale decision is reset to `pending` first — against the live head
     * only, by a compare-and-set on exactly the decision that was read.
     */
    function decided(over: Record<string, unknown> = {}) {
        return {
            id: 'app-1',
            taskId: 't1',
            approverType: 'agent',
            approverId: 'reviewer-1',
            approvalState: 'approved',
            decidedVia: 'agent-review',
            decidedHeadSha: OTHER_HEAD,
            ...over,
        };
    }

    function withApprovers(rows: Array<Record<string, unknown>>, over: Record<string, any> = {}) {
        return build({
            approvers: {
                findByTaskId: jest.fn(async () => rows),
                setState: jest.fn(),
                resetAgentDecisionToPending: jest.fn(async () => true),
            },
            ...over,
        });
    }

    it('resets an approval for an OLD head to pending and buys a review of the live head', async () => {
        const h = withApprovers([decided()]);
        const plan = await h.svc.planReviews(makeTask());

        expect(h.approvers.resetAgentDecisionToPending).toHaveBeenCalledTimes(1);
        expect(h.approvers.resetAgentDecisionToPending).toHaveBeenCalledWith({
            id: 'app-1',
            taskId: 't1',
            approvalState: 'approved',
            decidedVia: 'agent-review',
            decidedHeadSha: OTHER_HEAD,
        });
        expect(plan.dispatches).toHaveLength(1);
        expect(plan.dispatches[0]).toMatchObject({ reviewerAgentId: 'reviewer-1', headSha: HEAD });
        expect(h.reviews.claim.mock.calls[0][0].claimKey).toBe(
            agentReviewClaimKey('reviewer-1', HEAD),
        );
    });

    it('re-reviews a REQUEST FOR CHANGES about an old head too — the fix push is what needs reading', async () => {
        const h = withApprovers([decided({ approvalState: 'rejected' })]);
        const plan = await h.svc.planReviews(makeTask());
        expect(h.approvers.resetAgentDecisionToPending).toHaveBeenCalledWith(
            expect.objectContaining({ approvalState: 'rejected', decidedHeadSha: OTHER_HEAD }),
        );
        expect(plan.dispatches).toHaveLength(1);
    });

    it('re-reviews an agent approval that carries no commit at all', async () => {
        const h = withApprovers([decided({ decidedVia: null, decidedHeadSha: null })]);
        const plan = await h.svc.planReviews(makeTask());
        expect(h.approvers.resetAgentDecisionToPending).toHaveBeenCalledWith(
            expect.objectContaining({ decidedVia: null, decidedHeadSha: null }),
        );
        expect(plan.dispatches).toHaveLength(1);
    });

    it('leaves an approval for the LIVE head alone even when the Task cache still names the old head', async () => {
        // Cache lags (OTHER_HEAD), provider says HEAD, the decision is about
        // HEAD. Resetting against the CACHE would erase a current approval.
        const h = withApprovers([decided({ decidedHeadSha: HEAD })]);
        const plan = await h.svc.planReviews(makeTask({ prHeadSha: OTHER_HEAD }));
        expect(h.gitFacade.getPullRequestStatus).toHaveBeenCalledTimes(1);
        expect(h.approvers.resetAgentDecisionToPending).not.toHaveBeenCalled();
        expect(h.reviews.claim).not.toHaveBeenCalled();
        expect(plan.dispatches).toHaveLength(0);
        expect(plan.decisions).toEqual([
            { reviewerAgentId: 'reviewer-1', reason: 'already-claimed' },
        ]);
    });

    it('never resets on the cached head alone — no live head read, no write', async () => {
        for (const facade of [
            {
                getPullRequestStatus: jest.fn(async () => {
                    throw new Error('provider down');
                }),
                getCompareDiff: jest.fn(),
            },
            {
                getPullRequestStatus: jest.fn(async () => makeStatus({ headSha: null })),
                getCompareDiff: jest.fn(),
            },
        ]) {
            const h = withApprovers([decided()], { gitFacade: facade });
            const plan = await h.svc.planReviews(makeTask());
            expect(plan.dispatches).toHaveLength(0);
            expect(h.approvers.resetAgentDecisionToPending).not.toHaveBeenCalled();
        }
    });

    it('resets a stale decision even when this plan cannot buy the new review (the diff is unreviewable)', async () => {
        // The stale approval is about code that is no longer the head,
        // whether or not the new head can be reviewed. `pending` for a human
        // is the safe direction.
        const h = withApprovers([decided()], {
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => makeStatus()),
                getCompareDiff: jest.fn(async () => makeDiff({ truncated: true })),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.reason).toBe('diff-too-large');
        expect(h.approvers.resetAgentDecisionToPending).toHaveBeenCalledTimes(1);
        expect(h.reviews.claim).not.toHaveBeenCalled();
    });

    it('does not touch a USER approver, decided or not', async () => {
        const h = withApprovers([
            decided({ id: 'app-u', approverType: 'user', approverId: 'u9', decidedVia: 'user' }),
        ]);
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.reason).toBe('no-agent-approvers');
        expect(h.approvers.resetAgentDecisionToPending).not.toHaveBeenCalled();
    });
});

describe('bindRun — the run is bound before it is enqueued', () => {
    it('passes the binding to the ledger, and lets its refusal propagate', async () => {
        const h = build();
        await h.svc.bindRun('rev-1', 'run-9');
        expect(h.reviews.bindRun).toHaveBeenCalledWith('rev-1', 'run-9');

        h.reviews.bindRun.mockRejectedValueOnce(new Error('agent-review-binding-refused'));
        // NOT swallowed: the dispatch must roll the run back.
        await expect(h.svc.bindRun('rev-1', 'run-10')).rejects.toThrow(
            'agent-review-binding-refused',
        );
    });
});

describe('recordDispatchResult — a claim that bought nothing stays spent', () => {
    it('stamps the run id on a dispatched review', async () => {
        const h = build();
        await h.svc.recordDispatchResult('rev-1', {
            runId: 'run-9',
            dispatched: true,
            parked: false,
        });
        expect(h.reviews.stampRunId).toHaveBeenCalledWith('rev-1', 'run-9');
        expect(h.reviews.casSettle).not.toHaveBeenCalled();
    });

    it('leaves a PARKED review open — the drain promotes it and it reads the same brief', async () => {
        const h = build();
        await h.svc.recordDispatchResult('rev-1', {
            runId: 'run-9',
            dispatched: false,
            parked: true,
        });
        expect(h.reviews.stampRunId).toHaveBeenCalledWith('rev-1', 'run-9');
        expect(h.reviews.casSettle).not.toHaveBeenCalled();
    });

    it('settles a FAILED dispatch — the attempt is spent, not retried forever', async () => {
        const h = build();
        await h.svc.recordDispatchResult('rev-1', {
            runId: null,
            dispatched: false,
            parked: false,
            error: 'dispatch-failed: boom',
        });
        expect(h.reviews.casSettle).toHaveBeenCalledWith('rev-1', 'failed', {
            refusalCode: 'dispatch-failed: boom',
        });
    });
});

describe('a file whose patch the provider OMITTED — the reviewer would not see every change', () => {
    /**
     * Slice AD verification, finding B. `capDiffFiles` (the real plugin
     * contract, used below exactly as a provider uses it) leaves
     * `truncated` false when the provider sends no patch for a file, so a
     * pull request that hides a binary or a very large file passed
     * `assessReviewDiff` and got a brief that said "(no patch available for
     * this file)" — and an agent `approve` for bytes nobody read. The rule
     * is "the reviewer saw every change, or there is no agent review".
     */
    const readable = {
        path: 'src/a.ts',
        status: 'modified',
        additions: 3,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-a\n+b\n',
    };
    const providerOmitted: Array<
        [string, { path: string; status: string; additions: number; deletions: number }]
    > = [
        ['a BINARY file', { path: 'assets/logo.png', status: 'added', additions: 0, deletions: 0 }],
        [
            'a TEXT file too large for the provider to render',
            { path: 'src/generated/schema.ts', status: 'modified', additions: 9000, deletions: 12 },
        ],
    ];

    it.each(providerOmitted)(
        'refuses %s with its own reason (diff-incomplete), claims nothing and starts no run',
        async (_label, hidden) => {
            const providerDiff = capDiffFiles([readable, hidden], {
                maxBytes: AGENT_REVIEW_DIFF_MAX_BYTES,
                maxFiles: AGENT_REVIEW_DIFF_MAX_FILES,
            });
            expect(providerDiff.truncated).toBe(false);

            const h = build({
                gitFacade: {
                    getPullRequestStatus: jest.fn(async () => makeStatus()),
                    getCompareDiff: jest.fn(async () => providerDiff),
                },
            });
            const plan = await h.svc.planReviews(makeTask());
            expect(plan.reason).toBe('diff-incomplete');
            expect(plan.headSha).toBe(HEAD);
            expect(plan.dispatches).toHaveLength(0);
            expect(h.reviews.claim).not.toHaveBeenCalled();
            expect(h.approvers.setState).not.toHaveBeenCalled();

            // …and through THE dispatch path the transition hook uses: no run
            // row, no seeded brief, no enqueue. The approver stays pending
            // for a human.
            const runs = {
                createQueued: jest.fn(),
                seedResumeContext: jest.fn(),
                markDispatchFailed: jest.fn(),
                setTriggerRunId: jest.fn(),
            };
            const dispatcher = { enqueue: jest.fn() };
            const transition = new TaskTransitionService(
                { casUpdateStatus: jest.fn(), findById: jest.fn(async () => makeTask()) } as any,
                { findByTaskId: jest.fn(async () => []) } as any,
                { allApproved: jest.fn(async () => false) } as any,
                { findAgentAssignees: jest.fn(async () => []) } as any,
                runs as any,
                dispatcher as any,
                undefined,
                undefined,
                { admit: jest.fn(async () => ({ admitted: true })) } as any,
                undefined,
                undefined,
                { findByIdAndUser: jest.fn(async (id: string) => ({ id, userId: 'u1' })) } as any,
                h.svc,
            );
            await transition.requestAgentReviews(makeTask());
            expect(runs.createQueued).not.toHaveBeenCalled();
            expect(runs.seedResumeContext).not.toHaveBeenCalled();
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
            expect(h.reviews.claim).not.toHaveBeenCalled();
            expect(h.approvers.setState).not.toHaveBeenCalled();
        },
    );

    it('still reviews the same pull request once every changed file carries its patch', async () => {
        const h = build({
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => makeStatus()),
                getCompareDiff: jest.fn(async () =>
                    capDiffFiles([readable, { ...readable, path: 'src/b.ts' }], {
                        maxBytes: AGENT_REVIEW_DIFF_MAX_BYTES,
                        maxFiles: AGENT_REVIEW_DIFF_MAX_FILES,
                    }),
                ),
            },
        });
        const plan = await h.svc.planReviews(makeTask());
        expect(plan.dispatches).toHaveLength(1);
        expect(plan.dispatches[0].brief).not.toContain('no patch available');
    });
});
