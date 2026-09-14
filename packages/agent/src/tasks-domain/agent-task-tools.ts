import type { Agent } from '../entities/agent.entity';
import type { TasksService } from './tasks.service';
import type { TaskChatService } from './task-chat.service';
import type {
    TaskAssigneeRepository,
    TaskReviewerRepository,
    TaskApproverRepository,
} from '../database/repositories/task-side.repositories';
import type { TaskStatus } from '../entities/task.entity';
import { ownershipScopeOf } from '../database/ownership-scope';
// Type-only import of the service, VALUE import of the tool name from the
// pure module: naming the tool must not drag the review service's runtime
// graph (repositories + the git facade) into the chat-tool assembly path.
import type { TaskAgentReviewService } from './task-agent-review.service';
import { SUBMIT_TASK_REVIEW_TOOL } from './task-agent-review';

/**
 * Tasks feature — Phase 16.2 / 16.3 / 16.4.
 *
 * Tool descriptors that wrap the platform's Task surface so an
 * Agent can act on Tasks during a run. Built here (in tasks-domain)
 * instead of in `agent-tool.service` to avoid pulling the Tasks
 * graph into the agents subpath — `AiFacadeService.assembleTools()`
 * concatenates the two lists at run time.
 *
 * Permission gating (Review-fix C9 — tightened):
 *   - createTask       → permissions.canAssignTasks
 *   - commentOnTask    → Agent must be a member (assignee/reviewer/
 *                        approver) of the target Task. Spec
 *                        agents/tasks.md:99 — "validates the agent
 *                        is assignee/reviewer/approver". Cross-user
 *                        404 is still enforced via TasksService.getOne
 *                        inside TaskChatService.post.
 *   - transitionTask   → permissions.canAssignTasks (Spec FR-15).
 *                        State-machine + blocker/approver gates still
 *                        apply downstream in TaskTransitionService.
 */

export interface TaskToolDescriptor<TArgs = unknown, TResult = unknown> {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<
            string,
            {
                type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
                description: string;
                items?: { type: 'string' | 'number' | 'integer' | 'boolean' | 'object' };
            }
        >;
        required: string[];
    };
    invoke: (args: TArgs) => Promise<TResult | { error: string }>;
}

export interface CreateTaskArgs {
    title: string;
    description?: string;
    priority?: string;
    missionId?: string | null;
    ideaId?: string | null;
    workId?: string | null;
    parentTaskId?: string | null;
}

export interface CommentOnTaskArgs {
    taskId: string;
    body: string;
}

export interface TransitionTaskArgs {
    taskId: string;
    to: TaskStatus;
    force?: boolean;
}

export interface SubmitTaskReviewArgs {
    taskId?: string;
    verdict: string;
    summary?: string;
}

export function buildAgentTaskTools(args: {
    agent: Agent;
    tasksService: TasksService;
    chatService: TaskChatService;
    // Review-fix C9: membership-check helpers. Typed optional for
    // ergonomic construction, but Security (fail-closed): if any of the
    // three is unbound the commentOnTask membership gate DENIES every
    // call (see agentIsOnTask). Production wiring in the API-side module
    // must bind all three; unit tests that exercise commentOnTask must
    // supply them too (omitting them now denies rather than allows).
    assignees?: TaskAssigneeRepository;
    reviewers?: TaskReviewerRepository;
    approvers?: TaskApproverRepository;
    /**
     * Reviewer agent stage (slice AD, EW-811). Absent, `submitTaskReview`
     * is NOT offered at all — the model never sees a tool whose backing
     * service is unbound, and an unwired install therefore records no
     * agent approvals rather than recording unverified ones.
     */
    agentReviews?: Pick<TaskAgentReviewService, 'submitVerdict'>;
    /**
     * The id of the run these tools are being assembled for — platform
     * state from the tool loop's run context, never model input. It is
     * what `submitTaskReview` authorizes on: only the run a review was
     * bound to may answer it. Absent (a tool catalogue, a context with no
     * run), the verdict tool is still listed but records nothing.
     */
    runId?: string | null;
}): TaskToolDescriptor[] {
    const out: TaskToolDescriptor[] = [];

    if (args.agent.permissions?.canAssignTasks) {
        out.push({
            name: 'createTask',
            description:
                'Create a new Task. The Task is scoped to the same Mission/Idea/Work the Agent is in (or unscoped if the Agent is tenant-scoped). Returns the new Task slug + id.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Short title (≤200 chars).' },
                    description: { type: 'string', description: 'Optional Markdown body.' },
                    priority: {
                        type: 'string',
                        description: 'p0 / p1 / p2 / p3 (default) / p4.',
                    },
                    parentTaskId: {
                        type: 'string',
                        description: 'Optional parent task id to nest under.',
                    },
                },
                required: ['title'],
            },
            invoke: async (raw) => {
                const a = raw as CreateTaskArgs;
                try {
                    const created = await args.tasksService.create(
                        args.agent.userId,
                        {
                            title: a.title,
                            description: a.description ?? null,
                            priority: a.priority as any,
                            missionId: args.agent.missionId ?? null,
                            ideaId: args.agent.ideaId ?? null,
                            workId: args.agent.workId ?? null,
                            parentTaskId: a.parentTaskId ?? null,
                            createdByType: 'agent',
                            createdById: args.agent.id,
                        },
                        ownershipScopeOf(args.agent),
                    );
                    return { id: created.id, slug: created.slug };
                } catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        } satisfies TaskToolDescriptor<CreateTaskArgs, { id: string; slug: string }>);
    }

    // Helper for C9: returns true iff the Agent is on the Task as
    // assignee / reviewer / approver.
    //
    // Security (fail-closed authz): the membership gate is the SOLE
    // enforcement point for "Agent must be a member" — downstream
    // TaskChatService.post only checks task OWNERSHIP (findByIdAndUser),
    // not membership. If any of the three membership repos is unbound
    // the gate cannot be evaluated completely, so we DENY rather than
    // silently allow. A misconfigured / partially-wired DI graph
    // therefore fails closed instead of turning the gate into a no-op.
    // (Previously this returned `true` when all three repos were absent,
    // which let any caller that omitted the repos bypass the check.)
    async function agentIsOnTask(taskId: string): Promise<boolean> {
        if (!args.assignees || !args.reviewers || !args.approvers) return false;
        const checks = await Promise.all([
            args.assignees?.findByTaskId(taskId).catch(() => []),
            args.reviewers?.findByTaskId(taskId).catch(() => []),
            args.approvers?.findByTaskId(taskId).catch(() => []),
        ]);
        const flat = checks.flat().filter(Boolean) as Array<{
            assigneeType?: string;
            assigneeId?: string;
            reviewerType?: string;
            reviewerId?: string;
            approverType?: string;
            approverId?: string;
        }>;
        return flat.some(
            (row) =>
                (row.assigneeType === 'agent' && row.assigneeId === args.agent.id) ||
                (row.reviewerType === 'agent' && row.reviewerId === args.agent.id) ||
                (row.approverType === 'agent' && row.approverId === args.agent.id),
        );
    }

    out.push({
        name: 'commentOnTask',
        description:
            'Post a chat message on a Task you are a member of (assignee/reviewer/approver). The body is secret-scanned + size-capped. Use @<slug> mentions to ping other Agents/users; [[kb-slug]] to reference KB docs. Unknown mentions are stripped server-side.',
        parameters: {
            type: 'object',
            properties: {
                taskId: { type: 'string', description: 'The Task UUID.' },
                body: { type: 'string', description: 'Message body (≤16 KB).' },
            },
            required: ['taskId', 'body'],
        },
        invoke: async (raw) => {
            const a = raw as CommentOnTaskArgs;
            if (!a?.taskId || !a?.body) return { error: 'taskId and body are required' };
            // Review-fix C9: membership check before posting.
            if (!(await agentIsOnTask(a.taskId))) {
                return {
                    error: 'commentOnTask: this Agent is not a member of the Task (assignee/reviewer/approver). Add the Agent to the Task before commenting.',
                };
            }
            try {
                const message = await args.chatService.post(
                    args.agent.userId,
                    {
                        taskId: a.taskId,
                        authorType: 'agent',
                        authorId: args.agent.id,
                        body: a.body,
                    },
                    {},
                );
                return { id: message.id, createdAt: message.createdAt.toISOString() };
            } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies TaskToolDescriptor<CommentOnTaskArgs, { id: string; createdAt: string }>);

    // Review-fix C9: transitionTask now gated by canAssignTasks per Spec FR-15.
    if (args.agent.permissions?.canAssignTasks) {
        out.push({
            name: 'transitionTask',
            description:
                'Move a Task to a new status. Requires canAssignTasks. The state-machine enforces legal transitions; → done requires no open blockers AND (when requireAllApprovers=true) all approvers must have approved.',
            parameters: {
                type: 'object',
                properties: {
                    taskId: { type: 'string', description: 'The Task UUID.' },
                    to: {
                        type: 'string',
                        description:
                            'Target status: backlog / todo / in_progress / in_review / blocked / done / cancelled.',
                    },
                    force: {
                        // Review-fix C5: boolean, not string.
                        type: 'boolean',
                        description:
                            'Override the approver gate (NOT the blocker gate). Default false.',
                    },
                },
                required: ['taskId', 'to'],
            },
            invoke: async (raw) => {
                const a = raw as TransitionTaskArgs;
                if (!a?.taskId || !a?.to) return { error: 'taskId and to are required' };
                try {
                    const updated = await args.tasksService.transition(
                        args.agent.userId,
                        a.taskId,
                        a.to,
                        {
                            force: a.force === true || (a.force as any) === 'true',
                            // Quality gates (Wave 3 M8): this tool acts on an
                            // Agent's behalf, so a red/skipped gate under a
                            // 'required' policy refuses → in_review here.
                            actorType: 'agent',
                        },
                    );
                    return { id: updated.id, status: updated.status };
                } catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        } satisfies TaskToolDescriptor<TransitionTaskArgs, { id: string; status: TaskStatus }>);
    }

    // Reviewer agent stage (slice AD, EW-811) — the ONE way a review run
    // records a verdict.
    //
    // Deliberately NOT gated on `canAssignTasks` or any other permission
    // flag: the authorization is not a permission on the agent, it is an
    // OPEN review row the platform bound to THIS RUN before the run was
    // enqueued. `TaskAgentReviewService.submitVerdict` looks that up
    // before it looks at anything else, so the tool is inert in every run
    // that was not dispatched as that review — including every other run
    // of the same agent.
    //
    // The tool takes no review id, no approver id and no run id: the run
    // id comes from the tool loop's own context, the identity from the
    // agent whose run is speaking, the Task and the commit from the row
    // the platform bound. The optional `taskId` is only a cross-check — a
    // run briefed with one Task's diff cannot record a verdict on another.
    if (args.agentReviews) {
        const reviews = args.agentReviews;
        const runId = args.runId && args.runId !== 'no-run' ? args.runId : null;
        out.push({
            name: SUBMIT_TASK_REVIEW_TOOL,
            description:
                'Record your verdict on the code review this run was dispatched to perform. Only usable inside that review run. verdict must be exactly "approve" or "request-changes" — anything else records nothing, and finishing without calling this records nothing either. This is an AGENT approval on the Task; it is never the human sign-off required before a merge.',
            parameters: {
                type: 'object',
                properties: {
                    taskId: {
                        type: 'string',
                        description:
                            'Optional. The Task UUID under review; if given it must match the review this run was dispatched for.',
                    },
                    verdict: {
                        type: 'string',
                        // The vocabulary contract. `parseAgentReviewVerdict`
                        // accepts exactly `AGENT_REVIEW_VERDICTS` and nothing
                        // else — no casing, `_` or past-tense variants.
                        description:
                            'Exactly "approve" or "request-changes". No other spelling, casing or tense counts.',
                    },
                    summary: {
                        type: 'string',
                        description:
                            'Short note on what you actually checked and why (≤4000 chars).',
                    },
                },
                required: ['verdict'],
            },
            invoke: async (raw) => {
                const a = raw as SubmitTaskReviewArgs;
                if (!a?.verdict) {
                    return { error: 'verdict is required' };
                }
                if (!runId) {
                    return { error: 'review not recorded: no-open-review' };
                }
                try {
                    const result = await reviews.submitVerdict({
                        // Platform state: the run and the agent that are
                        // speaking, never fields the model filled in.
                        runId,
                        reviewerAgentId: args.agent.id,
                        taskId: a.taskId ?? null,
                        verdict: a.verdict,
                        summary: a.summary ?? null,
                    });
                    if (result.reason !== 'recorded') {
                        return { error: `review not recorded: ${result.reason}` };
                    }
                    return {
                        recorded: true,
                        verdict: result.verdict as string,
                        headSha: result.headSha ?? null,
                    };
                } catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        } satisfies TaskToolDescriptor<
            SubmitTaskReviewArgs,
            { recorded: boolean; verdict: string; headSha: string | null }
        >);
    }

    return out;
}
