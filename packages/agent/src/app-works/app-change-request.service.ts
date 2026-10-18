import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { isAppWorkKind } from '@ever-works/contracts';
import { ownershipScopeMatches, ownershipScopeOf } from '../database/ownership-scope';
import { AgentRepository } from '../database/repositories/agent.repository';
import { TaskRepository } from '../database/repositories/task.repository';
import type { Task } from '../entities/task.entity';
import type { Work } from '../entities/work.entity';
import { appWorkCloudPushAllowed } from '../tasks-domain/app-work-cloud-push';
import { resolveTaskRepository } from '../tasks-domain/task-repository';
import { TasksService } from '../tasks-domain/tasks.service';
import {
    APP_WORK_AGENT_RESOLVER,
    AppWorkAgentResolverService,
    isCommittingAgent,
    type AppWorkAgentResolver,
    type AppWorkAgentSource,
} from './app-work-agent-resolver';
import { GitFacadeService } from '../facades/git.facade';
import { AppSpecUnreadableError, AppWorkRulesService } from './app-work-rules.service';

/**
 * APW-08 T25 — the evolve loop's entry point: "change this App Work" → a Task on the Work,
 * assigned to the resolved Agent, started through THE dispatch path.
 *
 * ## No second agent-run engine
 *
 * Everything after the Task exists is the Self-Build Fleet machinery that already runs
 * repository Works on prod (EW-762): `TasksService.runTask` → `TaskTransitionService
 * .dispatchAgentRun` (concurrency valve, credits precheck, Fleet lease or cloud executor),
 * the agent edits the Work Repository on a Task branch, the finalize path pushes it and
 * opens a pull request into the fork's base branch. For an App Work the Task repository is
 * the `website` role — the fork (`resolveTaskRepository`, `task-repository.ts`). The change
 * gate (`APP_WORK_CHANGE_GATE`, APW-08 T17), the merge policy (agents never merge a
 * protected branch, `GitFacadeService.assertAgentMayMerge`) and the cloud-push switch
 * (`APP_WORKS_CLOUD_PUSH_ENABLED`, FR-12 — a cloud run publishes nothing, a Fleet run does;
 * residual C45 applies only when the switch is ON) all apply unchanged, because this
 * service only creates and starts the Task.
 *
 * ## The answer is a value, never a throw
 *
 * The controller maps `httpStatus` verbatim (the `work-app-deploy.controller.ts` posture),
 * so the web card and the chat tool render each refusal by its `code`.
 */

/** The label every evolve Task carries — the Task board's filter and `listChanges`' key. */
export const APP_CHANGE_LABEL = 'app-change';

/** Plan §4: `request` is 1–4000 characters. */
export const APP_CHANGE_REQUEST_MAX = 4000;

/** The catalog template the web card's one-click "Create and start" names (GAP-14). */
export const APP_CHANGE_AGENT_TEMPLATE_SLUG = 'evolve-app';

/** What a caller hands {@link AppChangeRequestService.request}. */
export interface AppChangeRequestInput {
    /** The Work, already access-checked (`ensureCanEdit`) by the caller. */
    readonly work: Work;
    /** Who asked — recorded as the Task's creator. */
    readonly actorUserId: string;
    /** What to change, verbatim. */
    readonly request: string;
    /** An explicit Agent; otherwise APW-08's resolution rule decides. */
    readonly agentId?: string | null;
    /** Where the request came from, for the Task description (`chat`, `card`, `api`). */
    readonly channel?: string | null;
}

/** An accepted change request. */
export interface AppChangeAccepted {
    readonly status: 'accepted';
    readonly httpStatus: 202;
    readonly taskId: string;
    readonly taskSlug: string;
    /** The Task's page — what a chat reply links to (`/tasks/<id>`). */
    readonly taskUrl: string;
    readonly runId: string | null;
    readonly agentId: string;
    /** `true` when this request created the Agent (GAP-14's one-click path). */
    readonly agentCreated?: boolean;
    readonly agentSource: AppWorkAgentSource | 'explicit';
    readonly dispatched: boolean;
    readonly parked: boolean;
    readonly queuedReason?: string;
    readonly dispatchError?: string;
    /** The repository the change lands in (the fork). */
    readonly repository: { owner: string; repo: string } | null;
    /** Non-fatal notes, e.g. `cloudPushOff` (only a Fleet-node run will publish). */
    readonly warnings: readonly string[];
}

/** A refused change request — nothing was created unless `taskId` says otherwise. */
export interface AppChangeRefused {
    readonly status: 'refused';
    readonly httpStatus: 404 | 409 | 422 | 503;
    readonly code:
        | 'notAppWork'
        | 'invalidRequest'
        | 'agentRequired'
        | 'agentNotEligible'
        | 'tasksUnavailable'
        | 'taskCreateFailed'
        // Live e2e 2026-10-18 (T-40): the base branch has no `.works/works.yml`, so
        // the change gate would refuse the pull request after the run anyway.
        | 'appSpecMissing';
    readonly message: string;
    readonly candidates?: ReadonlyArray<{ id: string; name: string }>;
    readonly createFromTemplate?: { templateSlug: string; reason: 'noCommittableAgent' };
}

export type AppChangeRequestResult = AppChangeAccepted | AppChangeRefused;

/** One row of {@link AppChangeRequestService.listChanges} — the chat panel's history. */
export interface AppChangeSummary {
    readonly taskId: string;
    readonly taskSlug: string;
    /** `/tasks/<id>` — the chat reply's link. `prUrl` is the PR's, once the run opened one. */
    readonly taskUrl: string;
    readonly title: string;
    readonly status: string;
    readonly agentId: string | null;
    readonly branch: string | null;
    readonly prUrl: string | null;
    readonly prState: string | null;
    readonly ciState: string | null;
    /**
     * The branch's own state (`pushed`, `pr-open`, `conflict`, …) — additive
     * (live e2e 2026-10-18): T-40's branch was `pushed` with no PR and the read said
     * nothing about why.
     */
    readonly branchState: string | null;
    /** Why the platform refused to open the PR, in the member's words, when it did. */
    readonly refusal: string | null;
    readonly createdAt: string | null;
    readonly updatedAt: string | null;
}

@Injectable()
export class AppChangeRequestService {
    private readonly logger = new Logger(AppChangeRequestService.name);

    constructor(
        @Optional() private readonly tasks?: TasksService,
        @Optional() private readonly taskRepository?: TaskRepository,
        @Optional() private readonly agents?: AgentRepository,
        @Optional()
        @Inject(APP_WORK_AGENT_RESOLVER)
        private readonly resolver?: AppWorkAgentResolver,
        @Optional() private readonly resolverService?: AppWorkAgentResolverService,
        // Appended LAST (positional constructions keep their slots) — the evolve
        // preflight (live e2e 2026-10-18). Absent ⇒ no preflight; the finalize gate
        // still judges the branch.
        @Optional() private readonly rules?: AppWorkRulesService,
        @Optional() private readonly git?: GitFacadeService,
    ) {}

    async request(input: AppChangeRequestInput): Promise<AppChangeRequestResult> {
        const { work } = input;
        if (!isAppWorkKind(work.kind)) {
            return refused(422, 'notAppWork', `Work ${work.id} is not an App Work.`);
        }

        const text = typeof input.request === 'string' ? input.request.trim() : '';
        if (text.length === 0 || text.length > APP_CHANGE_REQUEST_MAX) {
            return refused(
                422,
                'invalidRequest',
                `Describe the change in 1–${APP_CHANGE_REQUEST_MAX} characters.`,
            );
        }

        if (!this.tasks) {
            return refused(503, 'tasksUnavailable', 'Tasks are not available in this process.');
        }

        const ownerId = work.userId;
        const scope = ownershipScopeOf(work);

        // ── the Agent: explicit, else APW-08's rule ───────────────────────────
        let agentId: string | null = null;
        let agentSource: AppChangeAccepted['agentSource'] = 'explicit';
        if (input.agentId) {
            const agent = this.agents
                ? await this.agents.findByIdAndUser(input.agentId, ownerId, scope).catch(() => null)
                : null;
            if (!agent || !ownershipScopeMatches(agent, scope)) {
                return refused(404, 'agentNotEligible', `Agent ${input.agentId} not found.`);
            }
            if (!isCommittingAgent(agent)) {
                return refused(
                    422,
                    'agentNotEligible',
                    'That Agent is archived or may not commit to repositories, so it cannot change an App Work. Grant it "Commit to repository" or pick another.',
                );
            }
            agentId = agent.id;
        } else {
            const resolved = await this.resolve(ownerId, work.id, scope);
            if (resolved) {
                agentId = resolved.agentId;
                agentSource = resolved.source;
            }
        }

        if (!agentId) {
            // The candidates are the OWNER's Agents. A member who is not the owner gets the
            // refusal without the list, so editing access to one Work never enumerates the
            // owner's whole Agent roster.
            const isOwner = !input.actorUserId || input.actorUserId === ownerId;
            const candidates = isOwner
                ? ((await this.resolverService?.listCandidates(ownerId, scope)) ?? [])
                : [];
            if (!isOwner) {
                return refused(
                    409,
                    'agentRequired',
                    'No Agent is set up to change this App Work. Ask the owner to assign one to it.',
                );
            }
            return {
                status: 'refused',
                httpStatus: 409,
                code: 'agentRequired',
                message:
                    candidates.length > 0
                        ? 'More than one Agent could make this change — pick one (agentId).'
                        : 'No Agent that may commit to repositories exists yet. Create one (for example from the "evolve-app" template) and try again.',
                candidates,
                ...(candidates.length === 0
                    ? {
                          createFromTemplate: {
                              templateSlug: APP_CHANGE_AGENT_TEMPLATE_SLUG,
                              reason: 'noCommittableAgent' as const,
                          },
                      }
                    : {}),
            };
        }

        // ── the base branch must hold an App spec (live e2e 2026-10-18) ─────
        // Without one the change gate refuses the pull request AFTER the agent ran
        // (T-40: branch pushed, no PR, "rules could not be read"). Said up front
        // instead — only for a spec that is definitely MISSING; a provider that
        // cannot answer does not stop the request (the gate still judges).
        const missing = await this.appSpecMissingOnBase(work);
        if (missing) {
            return refused(409, 'appSpecMissing', missing);
        }

        // ── the Task ──────────────────────────────────────────────────────────
        const target = safeTarget(work);
        let task: Task;
        try {
            task = await this.tasks.create(
                ownerId,
                {
                    title: changeTitle(text),
                    description: changeDescription(text, work, target, input.channel ?? null),
                    labels: [APP_CHANGE_LABEL],
                    workId: work.id,
                    agentId,
                    createdByType: 'user',
                    createdById: input.actorUserId || ownerId,
                },
                scope,
            );
        } catch (error) {
            this.logger.warn(
                `App change: creating the Task on work ${work.id} failed (${errorText(error)}).`,
            );
            return refused(
                422,
                'taskCreateFailed',
                `The change Task could not be created: ${errorText(error)}`,
            );
        }

        // ── start it, through THE dispatch path ───────────────────────────────
        let runId: string | null = null;
        let dispatched = false;
        let parked = false;
        let queuedReason: string | undefined;
        let dispatchError: string | undefined;
        try {
            const run = await this.tasks.runTask(ownerId, task.id, { agentId }, scope);
            runId = run.runId;
            dispatched = run.dispatched;
            parked = run.parked;
            queuedReason = run.queuedReason;
            dispatchError = run.error;
        } catch (error) {
            // The Task exists and is assigned; a refused dispatch (credits, a gate) is
            // reported, never rolled back — the person can press Run on the Task.
            dispatchError = errorText(error);
            this.logger.warn(`App change: dispatching Task ${task.id} failed (${dispatchError}).`);
        }

        const warnings: string[] = [];
        if (!appWorkCloudPushAllowed(work.kind)) {
            // FR-12 (owner decision 2026-09-25): a cloud run publishes nothing for an App Work;
            // a Fleet-node run does. Said up front so the card does not promise a PR it
            // cannot get from a cloud runtime.
            warnings.push('cloudPushOff');
        }

        return {
            status: 'accepted',
            httpStatus: 202,
            taskId: task.id,
            taskSlug: task.slug,
            taskUrl: taskUrlOf(task.id),
            runId,
            agentId,
            agentSource,
            dispatched,
            parked,
            ...(queuedReason ? { queuedReason } : {}),
            ...(dispatchError ? { dispatchError } : {}),
            repository: target,
            warnings,
        };
    }

    /** The Work's change Tasks, newest first — what the chat panel lists under the input. */
    async listChanges(work: Work, limit = 20): Promise<AppChangeSummary[]> {
        if (!this.taskRepository) return [];
        const { rows } = await this.taskRepository.findByUserIdFiltered(
            work.userId,
            { workId: work.id, label: APP_CHANGE_LABEL, limit: Math.min(Math.max(limit, 1), 100) },
            ownershipScopeOf(work),
        );
        return [...rows]
            .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt))
            .map((task) => summaryOf(task));
    }

    /**
     * One change Task of this Work — the chat tool's "what happened to my change?" read.
     * `null` for a Task that is not on this Work (no existence leak across Works).
     */
    async getChange(work: Work, taskId: string): Promise<AppChangeSummary | null> {
        if (!this.taskRepository || !taskId) return null;
        const task = await this.taskRepository.findById(taskId).catch(() => null);
        if (!task || task.workId !== work.id || task.userId !== work.userId) return null;
        return summaryOf(task);
    }

    /**
     * The refusal text when the Work's base branch has NO App spec, else `null`.
     * Fail-open on everything else: no rules/git collaborator, no resolvable
     * repository, an unreadable head, an invalid spec (the gate names that one).
     */
    private async appSpecMissingOnBase(work: Work): Promise<string | null> {
        if (!this.rules || !this.git) return null;
        const target = safeTarget(work);
        if (!target) return null;
        const gitOptions = {
            userId: work.userId,
            providerId: work.gitProvider || 'github',
            workId: work.id,
        };
        let branch: string | undefined;
        try {
            const configured = work.taskIsolationBaseBranch?.trim();
            branch =
                configured ||
                (await this.git.getRepository(target.owner, target.repo, gitOptions))
                    ?.defaultBranch;
            if (!branch) return null;
            const head = await this.git.getLatestCommit(
                target.owner,
                target.repo,
                branch,
                gitOptions,
            );
            if (!head?.sha) return null;
            await this.rules.resolve(work, head.sha);
            return null;
        } catch (error) {
            if (error instanceof AppSpecUnreadableError && error.status === 'missing') {
                return (
                    `This App Work has no App spec (\`.works/works.yml\`) on \`${branch || error.branch}\` yet, ` +
                    "so a change cannot be checked against its rules. Merge the App Work's setup pull " +
                    'request (or add the App spec), then ask again.'
                );
            }
            this.logger.debug(
                `App change: the App spec preflight of work ${work.id} could not decide (${errorText(error)}); continuing.`,
            );
            return null;
        }
    }

    private async resolve(
        userId: string,
        workId: string,
        scope: ReturnType<typeof ownershipScopeOf>,
    ): Promise<{ agentId: string; source: AppWorkAgentSource } | null> {
        if (!this.resolver || typeof this.resolver.resolve !== 'function') return null;
        try {
            return await this.resolver.resolve({ userId, workId, scope });
        } catch (error) {
            this.logger.warn(
                `App change: the Agent resolver failed for work ${workId} (${errorText(error)}).`,
            );
            return null;
        }
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

/** The Task page a chat reply or card links to. */
export function taskUrlOf(taskId: string): string {
    return `/tasks/${taskId}`;
}

function summaryOf(task: Task): AppChangeSummary {
    return {
        taskId: task.id,
        taskSlug: task.slug,
        taskUrl: taskUrlOf(task.id),
        title: task.title,
        status: String(task.status),
        agentId: task.agentId ?? null,
        branch: task.branchRef ?? null,
        prUrl: task.prUrl ?? null,
        prState: task.prState ?? null,
        ciState: task.ciState ?? null,
        branchState: task.branchState ?? null,
        refusal: task.branchGuardRefusal ?? null,
        createdAt: isoOf(task.createdAt),
        updatedAt: isoOf(task.updatedAt),
    };
}

function refused(
    httpStatus: AppChangeRefused['httpStatus'],
    code: AppChangeRefused['code'],
    message: string,
): AppChangeRefused {
    return { status: 'refused', httpStatus, code, message };
}

function safeTarget(work: Work): { owner: string; repo: string } | null {
    try {
        const target = resolveTaskRepository(work);
        return target ? { owner: target.owner, repo: target.repo } : null;
    } catch {
        return null;
    }
}

/** The Task title: the request's first line, capped (titles are short; the request is not). */
export function changeTitle(request: string): string {
    const firstLine = request.split(/\r?\n/).find((line) => line.trim().length > 0) ?? request;
    const clean = firstLine.trim().replace(/\s+/g, ' ');
    const capped = clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
    return `Change: ${capped}`;
}

/**
 * The brief the Agent reads. The request is fenced and labelled as the member's words; the
 * governance lines are the platform's and say what the Agent may and may not do.
 */
export function changeDescription(
    request: string,
    work: Pick<Work, 'id' | 'name'>,
    target: { owner: string; repo: string } | null,
    channel: string | null,
): string {
    const repo = target ? `${target.owner}/${target.repo}` : 'the Work Repository';
    return [
        `A member asked for a change to the App Work "${work.name ?? work.id}"${channel ? ` (via ${channel})` : ''}.`,
        '',
        "## Requested change (the member's words, verbatim)",
        '',
        '```text',
        request.replace(/```/g, '`​``'),
        '```',
        '',
        '## How to deliver it',
        '',
        `- Make the change in ${repo} on this Task's branch. The platform pushes the branch and opens a pull request into the repository's base branch; the change reaches the running app when that pull request is merged and the App Work rebuilds and redeploys.`,
        "- Never push to or merge the default branch yourself, and never merge a pull request — merging is the owner's decision (or the merge policy's).",
        '- Keep the change focused on the request. Do not edit `.works/works.yml` protected blocks (`source`, `blueprint`, `license`, `upstreamSync`, `upstreamPullRequests`, `provisioning`) or CI workflows unless the request is explicitly about them.',
        '- If the request is ambiguous or needs a secret only the owner knows, ask instead of guessing.',
        '- Summarise what you changed and how to verify it when you finish.',
    ].join('\n');
}

function timeOf(value: Date | string | null | undefined): number {
    if (!value) return 0;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
}

function isoOf(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function errorText(error: unknown): string {
    if (error && typeof error === 'object' && 'response' in error) {
        const response = (error as { response?: { message?: unknown } }).response;
        if (response && typeof response.message === 'string') return response.message;
    }
    return error instanceof Error ? error.message : String(error);
}
