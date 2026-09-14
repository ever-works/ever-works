import { TaskStatus, type Task } from '../../entities/task.entity';
import { TaskAgentReviewService } from '../task-agent-review.service';
import { buildAgentTaskTools } from '../agent-task-tools';
import { AGENT_REVIEW_BRIEF_MISSING, agentReviewRunScope } from '../task-agent-review';
import type { Agent } from '../../entities/agent.entity';

/**
 * Reviewer agent stage (slice AD, EW-811) — the VERDICT half.
 *
 * This is where the approver row is written, so it is where every refusal
 * has to hold. The tests drive `submitVerdict` directly and, for the
 * authorization shape, through the real `submitTaskReview` tool
 * descriptor — because the tool is the only production caller and the
 * only thing that decides what a model may say about itself.
 *
 * Since the slice's review, the authorization is the RUN: a verdict is
 * accepted only from the run the ledger bound to the review before that
 * run was enqueued. Every case below therefore speaks as a run.
 */

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const REVIEW_RUN = 'run-review-1';

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        slug: 'ew-1',
        title: 'Add the login button',
        userId: 'u1',
        status: TaskStatus.IN_REVIEW,
        workId: 'w1',
        prNumber: 42,
        prHeadSha: HEAD,
        agentId: null,
        ...over,
    } as unknown as Task;
}

interface RunRow {
    id: string;
    agentId: string;
    taskId?: string;
    delegationScope?: unknown;
}

/** Behaves like the real run queries — see the service spec. */
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

/** The review run itself: bound, review-scoped, on this Task. */
const reviewRunRow = (over: Partial<RunRow> = {}): RunRow => ({
    id: REVIEW_RUN,
    agentId: 'reviewer-1',
    delegationScope: agentReviewRunScope(),
    ...over,
});

function build(over: Partial<Record<string, any>> = {}) {
    const openReview = {
        id: 'rev-1',
        taskId: 't1',
        reviewerAgentId: 'reviewer-1',
        approverId: 'app-1',
        headSha: HEAD,
        runId: REVIEW_RUN,
        state: 'dispatched',
    };
    const parts: Record<string, any> = {
        tasks: { findById: jest.fn(async () => makeTask()) },
        reviews: {
            // A store-shaped double: ONLY the bound run finds the review.
            findOpenForRun: jest.fn(async (runId: string) =>
                runId === REVIEW_RUN ? openReview : null,
            ),
            findOpenForReviewer: jest.fn(async () => openReview),
            listRunIdsForTask: jest.fn(async () => [REVIEW_RUN]),
            casSettle: jest.fn(async () => true),
            countForTask: jest.fn(async () => 1),
            claim: jest.fn(),
            stampRunId: jest.fn(),
        },
        approvers: {
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
        },
        works: {
            findById: jest.fn(async () => ({
                id: 'w1',
                gitProvider: 'github',
                getRepoOwner: () => 'ever-works',
                getDataRepo: () => 'ever-works',
            })),
        },
        assignees: { findAgentAssignees: jest.fn(async () => []) },
        runs: runsFrom([{ id: 'run-1', agentId: 'impl-1' }, reviewRunRow()]),
        agents: { findById: jest.fn(async (id: string) => ({ id, userId: 'u1', slug: id })) },
        gitFacade: {
            getPullRequestStatus: jest.fn(async () => ({
                number: 42,
                state: 'open',
                merged: false,
                headSha: HEAD,
                ciState: 'passing',
                checks: [],
            })),
            getCompareDiff: jest.fn(),
        },
        ...over,
    };
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
    return { svc, openReview, ...parts } as {
        svc: TaskAgentReviewService;
        openReview: typeof openReview;
    } & Record<string, any>;
}

/** A verdict spoken by the bound review run, unless overridden. */
const asReviewRun = (over: Record<string, unknown> = {}) => ({
    runId: REVIEW_RUN,
    taskId: 't1',
    reviewerAgentId: 'reviewer-1',
    verdict: 'approve' as unknown,
    ...over,
});

describe('submitVerdict — the outcome writes the approver row', () => {
    it('writes approved, with provenance bound to the commit and the run', async () => {
        const h = build();
        const result = await h.svc.submitVerdict(
            asReviewRun({ summary: 'Read every hunk; the null check is correct.' }),
        );

        expect(result).toEqual({
            reason: 'recorded',
            verdict: 'approve',
            approverId: 'app-1',
            headSha: HEAD,
        });
        expect(h.approvers.setState).toHaveBeenCalledWith('app-1', 'approved', 't1', {
            decidedVia: 'agent-review',
            decidedByRunId: REVIEW_RUN,
            decidedHeadSha: HEAD,
        });
        expect(h.reviews.casSettle).toHaveBeenCalledWith('rev-1', 'approved', {
            summary: 'Read every hunk; the null check is correct.',
        });
    });

    it('writes rejected for request-changes', async () => {
        const h = build();
        // REVERSED CONTRACT (slice AD verification): this spoke the
        // undocumented `request_changes`, which the parser used to widen to
        // `request-changes`. The vocabulary is now exactly the documented
        // one (see `parseAgentReviewVerdict`), so the test speaks it; the
        // underscore spelling is pinned as `unreadable-verdict` below.
        const result = await h.svc.submitVerdict(asReviewRun({ verdict: 'request-changes' }));
        expect(result.reason).toBe('recorded');
        expect(h.approvers.setState).toHaveBeenCalledWith(
            'app-1',
            'rejected',
            't1',
            expect.objectContaining({ decidedVia: 'agent-review' }),
        );
    });

    it('writes the approver row ONCE when the tool is called twice', async () => {
        const h = build();
        // The review row's CAS from `dispatched` is the guard: the second
        // call finds it already settled and affects zero rows.
        h.reviews.casSettle
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false as unknown as boolean);
        const first = await h.svc.submitVerdict(asReviewRun());
        const second = await h.svc.submitVerdict(asReviewRun());
        expect(first.reason).toBe('recorded');
        expect(second.reason).toBe('no-open-review');
        expect(h.approvers.setState).toHaveBeenCalledTimes(1);
    });

    it('accepts a verdict with no model-supplied Task id — the bound review names the Task', async () => {
        const h = build();
        const result = await h.svc.submitVerdict(asReviewRun({ taskId: undefined }));
        expect(result.reason).toBe('recorded');
        expect(h.tasks.findById).toHaveBeenCalledWith('t1');
    });
});

describe('AUTHORIZATION — only the run the platform bound can answer a review', () => {
    it('refuses a run with no open review bound to it, and writes nothing', async () => {
        const h = build();
        const result = await h.svc.submitVerdict(
            asReviewRun({ runId: 'run-stranger', reviewerAgentId: 'stranger' }),
        );
        expect(result).toEqual({ reason: 'no-open-review' });
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });

    it('refuses ANOTHER run of the reviewer agent — a chat run, or a run after the review run died', async () => {
        // The finding: authorization was (task, agent), so a review whose
        // run was cancelled before it read the diff stayed `dispatched`,
        // and any later run of the same agent could approve it. The open
        // (task, agent) row still exists here — and is not enough.
        const h = build({
            runs: runsFrom([
                { id: 'run-1', agentId: 'impl-1' },
                reviewRunRow(),
                // An ordinary run of the SAME agent, e.g. a chat reply.
                { id: 'run-chat-7', agentId: 'reviewer-1' },
            ]),
        });
        expect(await h.reviews.findOpenForReviewer('t1', 'reviewer-1')).not.toBeNull();

        const result = await h.svc.submitVerdict(asReviewRun({ runId: 'run-chat-7' }));
        expect(result).toEqual({ reason: 'no-open-review' });
        expect(h.reviews.findOpenForRun).toHaveBeenCalledWith('run-chat-7');
        expect(h.approvers.setState).not.toHaveBeenCalled();
        expect(h.reviews.casSettle).not.toHaveBeenCalled();
    });

    it('refuses when no run id is supplied at all', async () => {
        const h = build();
        for (const runId of [undefined, null, '', '   ']) {
            expect(await h.svc.submitVerdict(asReviewRun({ runId }))).toEqual({
                reason: 'no-open-review',
            });
        }
        expect(h.reviews.findOpenForRun).not.toHaveBeenCalled();
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });

    it('refuses a bound run that belongs to a DIFFERENT agent than the one speaking', async () => {
        const h = build();
        const result = await h.svc.submitVerdict(asReviewRun({ reviewerAgentId: 'impostor' }));
        expect(result).toEqual({ reason: 'no-open-review' });
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });

    it('refuses a run that is NOT review-scoped, even if a binding points at it', async () => {
        // Defence in depth: the run row must be the review run the binding
        // describes — admitted with the one-tool scope, on this Task.
        const h = build({
            runs: runsFrom([
                { id: 'run-1', agentId: 'impl-1' },
                reviewRunRow({ delegationScope: null }),
            ]),
        });
        expect((await h.svc.submitVerdict(asReviewRun())).reason).toBe('no-open-review');
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });

    it('refuses a review-scoped run whose row is on another Task', async () => {
        const h = build({
            runs: runsFrom([reviewRunRow({ taskId: 'other-task' })]),
        });
        expect((await h.svc.submitVerdict(asReviewRun())).reason).toBe('no-open-review');
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });

    it('a run briefed with one Task cannot record a verdict on ANOTHER Task by naming it', async () => {
        // The finding: `taskId` was model-supplied and selected the review.
        // It is now a cross-check against the review bound to the run; a
        // mismatch records nothing anywhere.
        const h = build();
        const result = await h.svc.submitVerdict(asReviewRun({ taskId: 'task-B' }));
        expect(result).toEqual({ reason: 'no-open-review' });
        expect(h.tasks.findById).not.toHaveBeenCalled();
        expect(h.approvers.setState).not.toHaveBeenCalled();
        expect(h.reviews.casSettle).not.toHaveBeenCalled();
    });

    it('refuses when the approver row was detached while the review ran', async () => {
        const h = build({
            approvers: { findByTaskId: jest.fn(async () => []), setState: jest.fn() },
        });
        const result = await h.svc.submitVerdict(asReviewRun());
        expect(result.reason).toBe('approver-missing');
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });

    it('will not let a verdict land on a row belonging to a DIFFERENT actor', async () => {
        // The review row names the approver row it may write. A row with
        // the right id but the wrong actor is not that row.
        const h = build({
            approvers: {
                findByTaskId: jest.fn(async () => [
                    {
                        id: 'app-1',
                        approverType: 'user',
                        approverId: 'reviewer-1',
                        approvalState: 'pending',
                    },
                ]),
                setState: jest.fn(),
            },
        });
        expect((await h.svc.submitVerdict(asReviewRun())).reason).toBe('approver-missing');
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });
});

describe('A REVIEWER MUST NOT APPROVE ITS OWN WORK — re-checked at verdict time', () => {
    it('refuses the implementer even when the approver row was added AFTER the run', async () => {
        // The dispatch-time check cannot see this: the approver may be
        // attached at any moment, including while the review is in flight.
        // The platform therefore decides again, at the moment the verdict
        // would land.
        const implReview = {
            id: 'rev-1',
            taskId: 't1',
            reviewerAgentId: 'impl-1',
            approverId: 'app-1',
            headSha: HEAD,
            runId: REVIEW_RUN,
            state: 'dispatched',
        };
        const h = build({
            reviews: {
                findOpenForRun: jest.fn(async () => implReview),
                listRunIdsForTask: jest.fn(async () => [REVIEW_RUN]),
                casSettle: jest.fn(async () => true),
            },
            runs: runsFrom([
                { id: 'run-1', agentId: 'impl-1' },
                reviewRunRow({ agentId: 'impl-1' }),
            ]),
        });
        const result = await h.svc.submitVerdict(asReviewRun({ reviewerAgentId: 'impl-1' }));
        expect(result).toEqual({ reason: 'self-review' });
        expect(h.approvers.setState).not.toHaveBeenCalled();
        expect(h.reviews.casSettle).toHaveBeenCalledWith('rev-1', 'refused', {
            refusalCode: 'self-review',
        });
    });

    it('refuses a reviewer that authored code in an EARLIER, non-review-scoped run on this Task', async () => {
        // The round-two case from the finding: the reviewer's earlier run
        // is in the ledger, but its row does not prove the review-only
        // scope — so it counts as authorship, and the verdict is refused.
        const h = build({
            reviews: {
                findOpenForRun: jest.fn(async () => ({
                    id: 'rev-2',
                    taskId: 't1',
                    reviewerAgentId: 'reviewer-1',
                    approverId: 'app-1',
                    headSha: HEAD,
                    runId: REVIEW_RUN,
                    state: 'dispatched',
                })),
                listRunIdsForTask: jest.fn(async () => ['run-review-0', REVIEW_RUN]),
                casSettle: jest.fn(async () => true),
            },
            runs: runsFrom([
                { id: 'run-1', agentId: 'impl-1' },
                // Round one, dispatched with the full tool surface.
                { id: 'run-review-0', agentId: 'reviewer-1', delegationScope: null },
                reviewRunRow(),
            ]),
        });
        const result = await h.svc.submitVerdict(asReviewRun());
        expect(result).toEqual({ reason: 'self-review' });
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });

    it('does NOT count the bound review run itself as authorship', async () => {
        const h = build();
        expect((await h.svc.submitVerdict(asReviewRun())).reason).toBe('recorded');
        expect(h.runs.findAuthorAgentIdsForTask).toHaveBeenCalledWith('t1', [REVIEW_RUN]);
    });

    it('refuses a second agent row wearing the implementer’s identity', async () => {
        const h = build({
            agents: {
                findById: jest.fn(async (id: string) => ({ id, userId: 'u1', slug: 'fixer' })),
            },
        });
        const result = await h.svc.submitVerdict(asReviewRun());
        expect(result).toEqual({ reason: 'self-review' });
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });

    it('refuses — without closing the review — when identity cannot be read', async () => {
        const h = build({ runs: undefined });
        const result = await h.svc.submitVerdict(asReviewRun());
        expect(result).toEqual({ reason: 'reviewer-unreadable' });
        expect(h.approvers.setState).not.toHaveBeenCalled();
        // A store failure is not a verdict about the reviewer: the row
        // stays open so a retry can succeed.
        expect(h.reviews.casSettle).not.toHaveBeenCalled();
    });
});

describe('A PUSH WHILE THE REVIEW IS IN FLIGHT — the verdict is about a commit', () => {
    it('refuses a verdict whose commit is no longer the pull request head', async () => {
        const h = build({
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => ({
                    number: 42,
                    state: 'open',
                    merged: false,
                    headSha: NEW_HEAD,
                    ciState: 'passing',
                    checks: [],
                })),
                getCompareDiff: jest.fn(),
            },
        });
        const result = await h.svc.submitVerdict(asReviewRun());
        expect(result).toEqual({ reason: 'stale-head', headSha: HEAD });
        expect(h.approvers.setState).not.toHaveBeenCalled();
        expect(h.reviews.casSettle).toHaveBeenCalledWith('rev-1', 'refused', {
            refusalCode: 'stale-head',
        });
    });

    // REVERSED CONTRACT (slice AD review). This case was titled "falls back
    // to the Task's cached head when the provider cannot answer" and pinned
    // that fallback. That was wrong: the cached head is written by a
    // two-minute poll, so right after a force-push it still names the OLD
    // commit — the very commit the review was about — and a provider error
    // at that moment waved the verdict through for code no longer on the
    // branch. The same provider error refuses the DISPATCH half. A live
    // head that cannot be read now refuses the verdict WITHOUT settling it.
    it('does NOT fall back to the cached head when the provider cannot answer — refuses, row left open', async () => {
        const h = build({
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => {
                    throw new Error('provider down');
                }),
                getCompareDiff: jest.fn(),
            },
            tasks: { findById: jest.fn(async () => makeTask({ prHeadSha: NEW_HEAD })) },
        });
        expect(await h.svc.submitVerdict(asReviewRun())).toEqual({
            reason: 'head-unreadable',
            headSha: HEAD,
        });
        expect(h.approvers.setState).not.toHaveBeenCalled();
        expect(h.reviews.casSettle).not.toHaveBeenCalled();
    });

    it('does not approve on a provider error even when the STALE cache still matches the reviewed commit', async () => {
        // The exploit from the finding: force-push to NEW_HEAD, poll not yet
        // run so the cache still says HEAD, provider throws. The old code
        // compared HEAD === HEAD and wrote the approval.
        const h = build({
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => {
                    throw new Error('rate limited');
                }),
                getCompareDiff: jest.fn(),
            },
            tasks: { findById: jest.fn(async () => makeTask({ prHeadSha: HEAD })) },
        });
        expect((await h.svc.submitVerdict(asReviewRun())).reason).toBe('head-unreadable');
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });

    it('treats a provider answer with no parseable head as unreadable, not as the cache', async () => {
        const h = build({
            gitFacade: {
                getPullRequestStatus: jest.fn(async () => ({
                    number: 42,
                    state: 'open',
                    merged: false,
                    headSha: null,
                    ciState: 'passing',
                    checks: [],
                })),
                getCompareDiff: jest.fn(),
            },
        });
        expect((await h.svc.submitVerdict(asReviewRun())).reason).toBe('head-unreadable');
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });

    it('refuses when NO head can be established — currency cannot be proven', async () => {
        const h = build({
            gitFacade: undefined,
            tasks: {
                findById: jest.fn(async () =>
                    makeTask({ prHeadSha: null, ciHeadSha: null } as Partial<Task>),
                ),
            },
        });
        expect((await h.svc.submitVerdict(asReviewRun())).reason).toBe('stale-head');
    });
});

describe('A VERDICT THAT CANNOT BE READ IS NOT AN APPROVAL', () => {
    it.each([['lgtm'], ['looks good'], [''], ['   '], ['approve-ish']])(
        'records nothing for %p',
        async (verdict) => {
            const h = build();
            const result = await h.svc.submitVerdict(asReviewRun({ verdict }));
            expect(result).toEqual({ reason: 'unreadable-verdict' });
            expect(h.approvers.setState).not.toHaveBeenCalled();
            // The row stays OPEN: the run may still call the tool correctly.
            expect(h.reviews.casSettle).not.toHaveBeenCalled();
        },
    );

    // Slice AD verification (minor): spellings the parser used to widen.
    it.each([
        ['approved'],
        ['APPROVE'],
        ['Approve'],
        ['reject'],
        ['rejected'],
        ['request_changes'],
    ])(
        'records nothing for the undocumented spelling %p — only the documented vocabulary counts',
        async (verdict) => {
            const h = build();
            const result = await h.svc.submitVerdict(asReviewRun({ verdict }));
            expect(result).toEqual({ reason: 'unreadable-verdict' });
            expect(h.approvers.setState).not.toHaveBeenCalled();
            expect(h.reviews.casSettle).not.toHaveBeenCalled();
        },
    );

    it('records nothing when the Task itself has vanished', async () => {
        const h = build({ tasks: { findById: jest.fn(async () => null) } });
        expect((await h.svc.submitVerdict(asReviewRun())).reason).toBe('no-task');
    });

    it('never throws, and never approves, when a store blows up', async () => {
        const h = build({
            reviews: {
                findOpenForRun: jest.fn(async () => {
                    throw new Error('db down');
                }),
            },
        });
        await expect(h.svc.submitVerdict(asReviewRun())).resolves.toEqual({ reason: 'error' });
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });
});

describe('the submitTaskReview tool — identity comes from the platform', () => {
    function makeAgent(over: Partial<Agent> = {}): Agent {
        return {
            id: 'reviewer-1',
            userId: 'u1',
            slug: 'reviewer',
            permissions: {},
            ...over,
        } as unknown as Agent;
    }

    it('passes the RUN’s id and the RUN’s agent id, ignoring anything the model might claim', () => {
        const submitVerdict = jest.fn(async () => ({ reason: 'recorded', verdict: 'approve' }));
        const [tool] = buildAgentTaskTools({
            agent: makeAgent(),
            tasksService: {} as never,
            chatService: {} as never,
            agentReviews: { submitVerdict } as never,
            runId: REVIEW_RUN,
        }).filter((descriptor) => descriptor.name === 'submitTaskReview');

        expect(tool).toBeDefined();
        // The parameter schema has no reviewer id, no review id and no run
        // id: there is nothing for a model to spoof.
        expect(Object.keys(tool.parameters.properties).sort()).toEqual([
            'summary',
            'taskId',
            'verdict',
        ]);

        return tool
            .invoke({
                taskId: 't1',
                verdict: 'approve',
                // A model trying to review as somebody else, or as another
                // run, has no field to put it in; invented ones are ignored.
                reviewerAgentId: 'impl-1',
                runId: 'run-chat-7',
            } as never)
            .then(() => {
                expect(submitVerdict).toHaveBeenCalledWith({
                    runId: REVIEW_RUN,
                    taskId: 't1',
                    reviewerAgentId: 'reviewer-1',
                    verdict: 'approve',
                    summary: null,
                });
            });
    });

    it('records nothing, and never calls the service, when assembled without a run', async () => {
        const submitVerdict = jest.fn(async () => ({ reason: 'recorded', verdict: 'approve' }));
        for (const runId of [undefined, null, 'no-run']) {
            const [tool] = buildAgentTaskTools({
                agent: makeAgent(),
                tasksService: {} as never,
                chatService: {} as never,
                agentReviews: { submitVerdict } as never,
                runId,
            }).filter((descriptor) => descriptor.name === 'submitTaskReview');
            await expect(tool.invoke({ verdict: 'approve' } as never)).resolves.toEqual({
                error: 'review not recorded: no-open-review',
            });
        }
        expect(submitVerdict).not.toHaveBeenCalled();
    });

    it('reports a refusal as an error rather than a silent success', async () => {
        const submitVerdict = jest.fn(async () => ({ reason: 'self-review' }));
        const [tool] = buildAgentTaskTools({
            agent: makeAgent(),
            tasksService: {} as never,
            chatService: {} as never,
            agentReviews: { submitVerdict } as never,
            runId: REVIEW_RUN,
        }).filter((descriptor) => descriptor.name === 'submitTaskReview');
        await expect(tool.invoke({ taskId: 't1', verdict: 'approve' } as never)).resolves.toEqual({
            error: 'review not recorded: self-review',
        });
    });

    it('is NOT offered when the review service is unbound', () => {
        const names = buildAgentTaskTools({
            agent: makeAgent(),
            tasksService: {} as never,
            chatService: {} as never,
            runId: REVIEW_RUN,
        }).map((descriptor) => descriptor.name);
        expect(names).not.toContain('submitTaskReview');
        // …and the pre-existing tools are untouched.
        expect(names).toContain('commentOnTask');
    });
});

describe('A REVIEW RUN THAT STARTED WITHOUT ITS BRIEF can never record a verdict', () => {
    /**
     * Slice AD verification, finding C. The brief rides as the run row's
     * first `pendingInput` entry and draining it CLEARS it, so a
     * job-runtime retry of a `running` review run executes with no diff in
     * hand while the open review row and the verdict tool are both still
     * there. The tool loop refuses that execution before the model is
     * called and settles the bound review through `abandonRunWithoutBrief`;
     * this pins the verdict half of that closure against a STATEFUL ledger
     * double (the real `findOpenForRun` reads only `dispatched` rows).
     */
    function statefulLedger(h: ReturnType<typeof build>) {
        const row = h.openReview as typeof h.openReview & { refusalCode?: string | null };
        h.reviews.findOpenForRun.mockImplementation(async (runId: string) =>
            runId === REVIEW_RUN && row.state === 'dispatched' ? row : null,
        );
        h.reviews.casSettle.mockImplementation(
            async (id: string, state: string, patch: { refusalCode?: string | null } = {}) => {
                if (id !== row.id || row.state !== 'dispatched') return false;
                row.state = state;
                row.refusalCode = patch.refusalCode ?? null;
                return true;
            },
        );
        return row;
    }

    it('settles the bound review failed, after which even an explicit approve is refused', async () => {
        const h = build();
        const row = statefulLedger(h);

        expect(await h.svc.abandonRunWithoutBrief(REVIEW_RUN)).toBe(true);
        expect(row.state).toBe('failed');
        expect(row.refusalCode).toBe(AGENT_REVIEW_BRIEF_MISSING);

        const result = await h.svc.submitVerdict(asReviewRun({ verdict: 'approve' }));
        expect(result).toEqual({ reason: 'no-open-review' });
        expect(h.approvers.setState).not.toHaveBeenCalled();

        // …and through the real tool the model would call.
        const [tool] = buildAgentTaskTools({
            agent: { id: 'reviewer-1', userId: 'u1', slug: 'reviewer', permissions: {} } as never,
            tasksService: {} as never,
            chatService: {} as never,
            agentReviews: h.svc,
            runId: REVIEW_RUN,
        }).filter((descriptor) => descriptor.name === 'submitTaskReview');
        await expect(tool.invoke({ verdict: 'approve' } as never)).resolves.toEqual({
            error: 'review not recorded: no-open-review',
        });
        expect(h.approvers.setState).not.toHaveBeenCalled();
    });

    it('is a no-op for a run with nothing open bound to it, and never throws', async () => {
        const h = build();
        statefulLedger(h);
        expect(await h.svc.abandonRunWithoutBrief('run-chat-7')).toBe(false);
        expect(h.reviews.casSettle).not.toHaveBeenCalled();

        h.reviews.findOpenForRun.mockRejectedValueOnce(new Error('db down'));
        await expect(h.svc.abandonRunWithoutBrief(REVIEW_RUN)).resolves.toBe(false);
    });
});
