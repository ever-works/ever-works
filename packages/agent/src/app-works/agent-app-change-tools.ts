import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import type { Agent } from '../entities/agent.entity';
import type { Work } from '../entities/work.entity';
import type {
    AppChangeRequestInput,
    AppChangeRequestResult,
    AppChangeSummary,
} from './app-change-request.service';

/**
 * APW-08 T26 (agent half) — the chat tools that close the owner's loop "chat with an AI
 * agent that modifies the software": an Agent in a Conversation about an App Work calls
 * `request_app_change`, which files and starts the change Task through
 * `AppChangeRequestService` (THE evolve path — the same one `POST /api/works/:id/evolve`
 * uses), and `get_app_change` to report where it got to (Task link, PR link, CI).
 *
 * Every import here is TYPE-ONLY (the `AGENT_DOMAIN_TOOL_SOURCES` convention): the agents
 * subpath must not pull the App Works runtime graph in.
 *
 * ## Who does the change
 *
 * When the Agent in the Conversation may commit (`canCommitToRepo`), the Task is assigned
 * to IT — "the agent you are chatting with makes the change". Otherwise APW-08's
 * resolution rule picks the Work's Agent, exactly as the web card does.
 *
 * ## Gates
 *
 * `request_app_change` is offered to an Agent that may assign Tasks or may commit; the
 * Work id comes from the model, so `authorize` checks EDIT access for the Agent's owner
 * before anything is created (a foreign id answers "not found" with no existence leak).
 * `get_app_change` is a read of one of that Work's change Tasks.
 */

export interface AppChangeToolService {
    request(input: AppChangeRequestInput): Promise<AppChangeRequestResult>;
    getChange(work: Work, taskId: string): Promise<AppChangeSummary | null>;
    listChanges(work: Work, limit?: number): Promise<AppChangeSummary[]>;
}

export interface BuildAppChangeToolsArgs {
    agent: Pick<Agent, 'id' | 'userId' | 'permissions'>;
    service: AppChangeToolService;
    /** The Work when the Agent's owner may EDIT it and it is an App Work; `null` otherwise. */
    authorize(userId: string, workId: string, level: 'edit' | 'view'): Promise<Work | null>;
}

interface RequestAppChangeArgs {
    workId: string;
    request: string;
}

interface GetAppChangeArgs {
    workId: string;
    taskId?: string;
}

export function buildAppChangeTools(args: BuildAppChangeToolsArgs): TaskToolDescriptor[] {
    const { agent, service } = args;
    const out: TaskToolDescriptor[] = [];
    const mayCommit = agent.permissions?.canCommitToRepo === true;
    const mayRequest = mayCommit || agent.permissions?.canAssignTasks === true;

    if (mayRequest) {
        out.push({
            name: 'request_app_change',
            description:
                'Ask for a change to an App Work (a running app the owner forked or linked into Ever Works): ' +
                'files a Task on the App Work with the request as its brief and starts an agent run that edits ' +
                'the app’s repository on a branch and opens a pull request for the owner to review. Returns the ' +
                'Task id and link (taskUrl). Use it when the owner asks to add, change or fix something in the ' +
                'app; pass their words verbatim. Follow up with get_app_change for the pull request link.',
            parameters: {
                type: 'object',
                properties: {
                    workId: {
                        type: 'string',
                        description: 'The App Work id (the conversation’s Work).',
                    },
                    request: {
                        type: 'string',
                        description: 'What to change, in the owner’s words (1–4000 characters).',
                    },
                },
                required: ['workId', 'request'],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as RequestAppChangeArgs;
                if (!a.workId || typeof a.request !== 'string' || !a.request.trim()) {
                    return { error: 'workId and request are required' };
                }
                const work = await args.authorize(agent.userId, a.workId, 'edit').catch(() => null);
                if (!work) {
                    return { error: 'App Work not found or not accessible', code: 'not_found' };
                }
                const result = await service.request({
                    work,
                    actorUserId: agent.userId,
                    request: a.request,
                    ...(mayCommit ? { agentId: agent.id } : {}),
                    channel: 'chat',
                });
                if (result.status !== 'accepted') {
                    return {
                        error: result.message,
                        code: result.code,
                        ...(result.candidates ? { candidates: result.candidates } : {}),
                        ...(result.createFromTemplate
                            ? { createFromTemplate: result.createFromTemplate }
                            : {}),
                    };
                }
                return {
                    status: 'started',
                    taskId: result.taskId,
                    taskSlug: result.taskSlug,
                    taskUrl: result.taskUrl,
                    runId: result.runId,
                    agentId: result.agentId,
                    dispatched: result.dispatched,
                    repository: result.repository,
                    warnings: result.warnings,
                    next: 'Tell the owner the Task link. The pull request link appears on get_app_change once the run opens it.',
                };
            },
        } satisfies TaskToolDescriptor<RequestAppChangeArgs, unknown>);
    }

    out.push({
        name: 'get_app_change',
        description:
            'Where a requested App Work change got to: the Task status, its link (taskUrl), the branch, and the ' +
            'pull request link and CI state once the run opened one. Without taskId, lists the Work’s recent ' +
            'change requests (newest first).',
        parameters: {
            type: 'object',
            properties: {
                workId: { type: 'string', description: 'The App Work id.' },
                taskId: {
                    type: 'string',
                    description: 'The change Task id from request_app_change (optional).',
                },
            },
            required: ['workId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as GetAppChangeArgs;
            if (!a.workId) return { error: 'workId is required' };
            const work = await args.authorize(agent.userId, a.workId, 'view').catch(() => null);
            if (!work) return { error: 'App Work not found or not accessible', code: 'not_found' };
            if (a.taskId) {
                const change = await service.getChange(work, a.taskId);
                return (
                    change ?? { error: 'No such change Task on this App Work', code: 'not_found' }
                );
            }
            return { changes: await service.listChanges(work, 10) };
        },
    } satisfies TaskToolDescriptor<GetAppChangeArgs, unknown>);

    return out;
}
