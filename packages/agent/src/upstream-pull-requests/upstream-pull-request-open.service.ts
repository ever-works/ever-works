import { Injectable, Logger, Optional } from '@nestjs/common';
import { isAppWorkKind, type AppSourceRecord } from '@ever-works/contracts';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { config } from '../config';
import { GitFacadeService } from '../facades/git.facade';
import { TaskChatService } from '../tasks-domain/task-chat.service';
import { relationOf } from '../app-works/app-source-initializer.service';
import { resolveTaskRepository } from '../tasks-domain/task-repository';
import { UpstreamCredentialService } from './upstream-credential.service';

/**
 * APW-09 — the first surface over the upstream-PR facade: open a pull request from a
 * branch of the member's FORK into the UPSTREAM repository (`POST /api/works/:id/upstream-pr`).
 *
 * The facade half already exists: `CreatePROptions.headOwner` / `headRepo` /
 * `maintainerCanModify` (APW-09 T1, `git-provider.interface.ts`) express a cross-repository
 * head, and `UpstreamCredentialService.resolveForPublishingMember` (FR-24) resolves the
 * publishing member's OWN connection — never the platform's, never another member's.
 *
 * Governance kept deliberately narrow for this first slice:
 *
 *   - **fork only** — a private copy shares no fork network with the upstream and a link
 *     has no upstream, so both are refused `notAFork`;
 *   - **draft by default** — the member marks it ready on the provider after reading it
 *     (an upstream project's CLA, templates and etiquette are theirs to honour);
 *   - the branch is named explicitly or taken from one of THIS Work's Tasks (its
 *     `branchRef`), so the route cannot be pointed at an arbitrary repository.
 *
 * Not here yet (APW-09 plan): the `UpstreamPullRequest` row and its lifecycle jobs, the
 * contribution budget gate (T44), FR-41's deny list, and the prepare step that rebases the
 * change onto the upstream default branch.
 */

export interface UpstreamPullRequestOpenInput {
    readonly workId: string;
    /** The publishing member — their own provider connection opens the pull request. */
    readonly callerUserId: string;
    /** A Task of this Work whose branch is the change to offer upstream. */
    readonly taskId?: string | null;
    /** Or the fork branch, named directly. */
    readonly branch?: string | null;
    readonly title?: string | null;
    readonly body?: string | null;
    /** `true` when absent. */
    readonly draft?: boolean | null;
    /** `true` when absent (GitHub's "allow edits by maintainers"). */
    readonly maintainerCanModify?: boolean | null;
}

export type UpstreamPullRequestOpenResult =
    | {
          readonly status: 'opened';
          readonly httpStatus: 201;
          readonly url: string;
          readonly number: number;
          readonly head: string;
          readonly base: string;
          readonly upstream: string;
          readonly draft: boolean;
      }
    | {
          readonly status: 'refused';
          readonly httpStatus: 404 | 422 | 502 | 503;
          readonly code:
              | 'not_found'
              | 'notAppWork'
              | 'notAFork'
              | 'upstreamUnknown'
              | 'branchRequired'
              | 'taskNotOnWork'
              | 'connectionScope'
              | 'providerRefused'
              | 'unavailable'
              | 'upstreamPaused'
              | 'deniedUpstream';
          readonly message: string;
      };

const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,255}$/;

@Injectable()
export class UpstreamPullRequestOpenService {
    private readonly logger = new Logger(UpstreamPullRequestOpenService.name);

    constructor(
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly tasks?: TaskRepository,
        @Optional() private readonly credentials?: UpstreamCredentialService,
        @Optional() private readonly git?: GitFacadeService,
        // The record: when the PR came from a Task, the Task's thread says so (link + head).
        @Optional() private readonly taskChat?: TaskChatService,
    ) {}

    async open(input: UpstreamPullRequestOpenInput): Promise<UpstreamPullRequestOpenResult> {
        if (!this.works || !this.git || !this.credentials) {
            return refused(
                503,
                'unavailable',
                'Upstream pull requests are not available in this process.',
            );
        }
        // FR-46 — the operator kill switch, before anything is read.
        if (!config.everWorks.apps.upstreamPullRequestsEnabled()) {
            return refused(
                422,
                'upstreamPaused',
                'Upstream pull requests are paused by the platform.',
            );
        }
        const work = await this.works.findById(input.workId);
        if (!work) return refused(404, 'not_found', `Work ${input.workId} not found.`);
        if (!isAppWorkKind(work.kind))
            return refused(422, 'notAppWork', 'Only an App Work has an upstream.');

        const record = (work.sourceRepository ?? {}) as AppSourceRecord;
        if (relationOf(record) !== 'fork') {
            return refused(
                422,
                'notAFork',
                'Only a fork can open a pull request upstream: a private copy shares no fork network with the upstream, and a linked repository has no upstream.',
            );
        }
        const upstream = record.upstream;
        if (!upstream?.owner || !upstream?.repo) {
            return refused(
                422,
                'upstreamUnknown',
                'This App Work has no recorded upstream repository.',
            );
        }
        // FR-41 — the operator deny list; an App Work cannot be configured around it.
        const upstreamFullName = `${upstream.owner}/${upstream.repo}`.toLowerCase();
        if (config.everWorks.apps.upstreamDenyList().includes(upstreamFullName)) {
            return refused(
                422,
                'deniedUpstream',
                `The platform does not open pull requests into ${upstream.owner}/${upstream.repo}.`,
            );
        }
        const fork = safeTarget(work);
        if (!fork)
            return refused(422, 'upstreamUnknown', 'The fork repository could not be resolved.');

        // ── the branch: named, or one of THIS Work's Tasks ────────────────────
        let branch = typeof input.branch === 'string' ? input.branch.trim() : '';
        let taskTitle: string | null = null;
        let recordOn: { id: string; userId: string } | null = null;
        if (input.taskId) {
            const task = this.tasks
                ? await this.tasks.findById(input.taskId).catch(() => null)
                : null;
            if (!task || task.workId !== work.id) {
                return refused(
                    404,
                    'taskNotOnWork',
                    `Task ${input.taskId} is not a Task of this App Work.`,
                );
            }
            branch = branch || (task.branchRef ?? '');
            taskTitle = task.title ?? null;
            recordOn = { id: task.id, userId: task.userId };
        }
        if (!branch || !BRANCH_PATTERN.test(branch)) {
            return refused(
                422,
                'branchRequired',
                'Name the fork branch to offer upstream (or a Task that has one).',
            );
        }

        // ── the publishing member's own credential (FR-24) ────────────────────
        const publishing = await this.credentials.resolveForPublishingMember(
            work.id,
            input.callerUserId,
        );
        if (publishing.usable !== true) {
            return refused(
                422,
                'connectionScope',
                'Your git connection cannot open a pull request upstream (missing `repo` scope or revoked). Reconnect it and try again.',
            );
        }
        const credential = publishing.credential;

        const draft = input.draft !== false;
        const base = upstream.defaultBranch || 'main';
        const title = (
            input.title?.trim() ||
            taskTitle?.replace(/^Change:\s*/, '') ||
            `Changes from ${fork.owner}/${fork.repo}`
        ).slice(0, 256);
        const body = [
            input.body?.trim() || 'A change made in an Ever Works App Work, offered back upstream.',
            '',
            `Head: \`${fork.owner}/${fork.repo}:${branch}\`.`,
        ].join('\n');

        try {
            const pr = await this.git.createPullRequest(
                {
                    owner: upstream.owner,
                    repo: upstream.repo,
                    title,
                    head: branch,
                    headOwner: fork.owner,
                    ...(fork.repo !== upstream.repo ? { headRepo: fork.repo } : {}),
                    base,
                    body,
                    draft,
                    maintainerCanModify: input.maintainerCanModify !== false,
                },
                {
                    token: credential.token,
                    providerId: credential.providerId,
                    userId: credential.userId,
                    workId: work.id,
                },
            );
            if (recordOn) await this.record(recordOn, pr.url, `${fork.owner}:${branch}`, draft);
            return {
                status: 'opened',
                httpStatus: 201,
                url: pr.url,
                number: pr.number,
                head: `${fork.owner}:${branch}`,
                base,
                upstream: `${upstream.owner}/${upstream.repo}`,
                draft,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Upstream PR for work ${work.id} (${branch}) was refused: ${message}`);
            return refused(
                502,
                'providerRefused',
                `The provider refused the pull request: ${message}`,
            );
        }
    }

    /** The record: one line on the Task the change came from, so its thread links the PR. */
    private async record(
        task: { id: string; userId: string },
        url: string,
        head: string,
        draft: boolean,
    ): Promise<void> {
        if (!this.taskChat) return;
        try {
            await this.taskChat.post(task.userId, {
                taskId: task.id,
                authorType: 'user',
                authorId: task.userId,
                body: `Offered upstream${draft ? ' as a draft' : ''}: ${url} (head \`${head}\`).`,
            });
        } catch (error) {
            this.logger.warn(
                `Recording the upstream PR on Task ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

function refused(
    httpStatus: 404 | 422 | 502 | 503,
    code: Extract<UpstreamPullRequestOpenResult, { status: 'refused' }>['code'],
    message: string,
): UpstreamPullRequestOpenResult {
    return { status: 'refused', httpStatus, code, message };
}

function safeTarget(
    work: Parameters<typeof resolveTaskRepository>[0],
): { owner: string; repo: string } | null {
    try {
        const target = resolveTaskRepository(work);
        return target ? { owner: target.owner, repo: target.repo } : null;
    } catch {
        return null;
    }
}
