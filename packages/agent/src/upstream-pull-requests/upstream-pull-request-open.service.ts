import { Injectable, Logger, Optional } from '@nestjs/common';
import { isAppWorkKind, type AppSourceRecord } from '@ever-works/contracts';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { config } from '../config';
import { ActivityStatus } from '../entities/activity-log.types';
import { GitFacadeService } from '../facades/git.facade';
import { TaskChatService } from '../tasks-domain/task-chat.service';
import { relationOf } from '../app-works/app-source-initializer.service';
import { resolveTaskRepository } from '../tasks-domain/task-repository';
import { UpstreamCredentialService } from './upstream-credential.service';
import { ownershipScopeOf } from '../database/ownership-scope';
import { UpstreamPullRequestRecordService } from './upstream-pull-request-record.service';
import { UpstreamEligibilityService } from './upstream-eligibility.service';
import type { UpstreamRateLimitRefusal } from './upstream-rate-limits';
import {
    UPSTREAM_PR_TELEMETRY_EVENTS,
    UpstreamPrTelemetry,
    upstreamPrRefusedPhase,
} from './upstream-pr.telemetry';

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
 * Not here yet (APW-09 plan): the lifecycle jobs (status polling), the contribution budget
 * gate (T44) and the prepare step that rebases the change onto the upstream default branch.
 *
 * ## The record (APW-09 T7/T35, lane aw-upstream-prs — additive)
 *
 * When the `upstream_pull_requests` store is bound (`UpstreamPullRequestRecordService`), the
 * route claims the source Task's one active slot BEFORE the provider is called (state
 * `opening`, `origin: 'direct'`), then moves it to `open` with the number and URL, or to
 * `failed` with the provider's message — each with its `app_upstream_pr` Activity line. A
 * second request for a Task that already has an active record is refused
 * `409 activeProposal` (FR-5) and reaches no provider. The success body is unchanged except
 * for one added field, `recordId`. The record never holds the token.
 *
 * ## FR-26 / FR-39 limits (APW-09 T8, lane aw-upstream-prs — additive)
 *
 * When `UpstreamEligibilityService` is bound, the route refuses `429` before any provider call
 * when the member already opened one pull request on this upstream in 24 hours, has the App
 * spec's `maxOpen` open there, opened 3 anywhere in 24 hours, or Ever Works opened 5 on this
 * upstream in 24 hours (`platformCapReached`). The body names the `limit` and, for a windowed
 * limit, `nextSlotAt` (FR-27). The check runs twice — before the claim, and again with the claim
 * counted — so two concurrent requests cannot both slip under a limit.
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
          /** APW-09 — the `upstream_pull_requests` row, or `null` when no store is bound. */
          readonly recordId?: string | null;
      }
    | {
          readonly status: 'refused';
          readonly httpStatus: 404 | 409 | 422 | 429 | 502 | 503;
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
              | 'deniedUpstream'
              // APW-09 (lane aw-upstream-prs) — appended.
              | 'activeProposal'
              | 'rateLimited'
              | 'platformCapReached';
          readonly message: string;
          /** `activeProposal`: the record that already holds the source Task's slot. */
          readonly id?: string | null;
          /** `rateLimited` / `platformCapReached`: which FR-26 / FR-39 limit refused (FR-27). */
          readonly limit?: string;
          readonly nextSlotAt?: string;
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
        // APW-09 T7/T35 — the `upstream_pull_requests` record. Appended LAST and optional.
        @Optional() private readonly records?: UpstreamPullRequestRecordService,
        // APW-09 T8/T9 — the FR-26 / FR-39 limits. Appended LAST and optional.
        @Optional() private readonly eligibility?: UpstreamEligibilityService,
        // Gauzy Ever Works #37 - plan 9.1's `upstream_pr.*` events. Appended LAST and
        // optional: absent, nothing is emitted; present, it never throws.
        @Optional() private readonly telemetry?: UpstreamPrTelemetry,
    ) {}

    /**
     * Open one upstream pull request (see the class docstring). The answer is
     * {@link decide}'s, unchanged; this wrapper only reports how it ended - the refusal
     * CODE and its phase, or that it opened - never a title, a body, a branch or a
     * repository.
     */
    async open(input: UpstreamPullRequestOpenInput): Promise<UpstreamPullRequestOpenResult> {
        const result = await this.decide(input);
        if (this.telemetry) {
            if (result.status === 'opened') {
                this.telemetry.track(
                    UPSTREAM_PR_TELEMETRY_EVENTS.opened,
                    {
                        minutesApprovalToOpen: null,
                        draft: result.draft,
                        fromTask: Boolean(input?.taskId),
                    },
                    input?.callerUserId ?? null,
                );
            } else {
                this.telemetry.track(
                    UPSTREAM_PR_TELEMETRY_EVENTS.refused,
                    { code: result.code, phase: upstreamPrRefusedPhase(result.code) },
                    input?.callerUserId ?? null,
                );
            }
        }
        return result;
    }

    private async decide(
        input: UpstreamPullRequestOpenInput,
    ): Promise<UpstreamPullRequestOpenResult> {
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

        // ── APW-09 FR-26 / FR-39: the limits, before any credential or provider call ──
        const limitScope = {
            workId: work.id,
            userId: input.callerUserId,
            upstreamOwner: upstream.owner,
            upstreamRepo: upstream.repo,
        };
        const preLimit = this.eligibility ? await this.eligibility.limitsFor(limitScope) : null;
        if (preLimit) return limitRefusal(preLimit, `${upstream.owner}/${upstream.repo}`);

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
        const maintainerCanModify = input.maintainerCanModify !== false;
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

        // ── APW-09: claim the record (FR-5) before anything reaches the provider ──
        const scope = ownershipScopeOf(work as never);
        const claim = this.records
            ? await this.records.claimDirect({
                  workId: work.id,
                  userId: input.callerUserId,
                  sourceTaskId: recordOn?.id ?? null,
                  upstreamOwner: upstream.owner,
                  upstreamRepo: upstream.repo,
                  baseBranch: base,
                  headOwner: fork.owner,
                  headRepo: fork.repo,
                  headBranch: branch,
                  title,
                  body,
                  draft,
                  maintainerCanModify,
                  tenantId: scope.tenantId ?? null,
                  organizationId: scope.organizationId ?? null,
              })
            : ({ status: 'unrecorded' } as const);
        if (claim.status === 'active') {
            return {
                status: 'refused',
                httpStatus: 409,
                code: 'activeProposal',
                message: 'This Task already has a proposal. Open it instead of starting another.',
                id: claim.activeId,
            };
        }
        const row = claim.status === 'claimed' ? claim.row : null;
        if (row) {
            // Gauzy Ever Works #37 - the record exists: a proposal was made (plan 9.1).
            this.telemetry?.track(
                UPSTREAM_PR_TELEMETRY_EVENTS.proposed,
                { workId: work.id, taskId: recordOn?.id ?? null },
                input.callerUserId,
            );
        }

        // The second look, with this request's own claim counted (see the class docstring).
        if (row && this.eligibility && this.records) {
            let postLimit: UpstreamRateLimitRefusal | null;
            try {
                postLimit = await this.eligibility.limitsFor({ ...limitScope, includesSelf: true });
            } catch (error) {
                // Never leave the claim holding the Task's slot (and counting in every window).
                await this.releaseClaim(row, 'The limit re-check failed.');
                throw error;
            }
            if (postLimit) {
                try {
                    const moved = await this.records.transition(
                        row,
                        ['opening'],
                        'refused',
                        { openedAt: null, nextCheckAt: null, refusalCode: postLimit.code },
                        {
                            event: 'app.upstream_pr.refused',
                            status: ActivityStatus.FAILED,
                            summary: `A pull request on ${upstream.owner}/${upstream.repo} was refused by a limit`,
                        },
                    );
                    if (!moved) {
                        this.logger.warn(
                            `Upstream PR claim ${row.id} was no longer opening when its limit refusal was recorded.`,
                        );
                    }
                } catch (error) {
                    this.logger.warn(
                        `Recording the limit refusal of claim ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    await this.releaseClaim(row, 'Refused by a limit.');
                }
                return limitRefusal(postLimit, `${upstream.owner}/${upstream.repo}`);
            }
        }

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
                    maintainerCanModify,
                },
                {
                    token: credential.token,
                    providerId: credential.providerId,
                    userId: credential.userId,
                    workId: work.id,
                },
            );
            if (row && this.records) {
                await this.records
                    .markOpened(row, { number: pr.number, url: pr.url })
                    .catch((error: unknown) =>
                        this.logger.warn(
                            `Recording upstream PR ${pr.url} for work ${work.id} failed: ${error instanceof Error ? error.message : String(error)}`,
                        ),
                    );
            }
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
                recordId: row?.id ?? null,
            };
        } catch (error) {
            const message = redactProviderMessage(
                error instanceof Error ? error.message : String(error),
                credential.token,
            );
            this.logger.warn(`Upstream PR for work ${work.id} (${branch}) was refused: ${message}`);
            if (row && this.records) {
                await this.records.markFailed(row, message).catch(() => undefined);
            }
            return refused(
                502,
                'providerRefused',
                `The provider refused the pull request: ${message}`,
            );
        }
    }

    /** Move a claim that will not reach the provider to `failed` (best-effort, logged). */
    private async releaseClaim(
        row: Parameters<UpstreamPullRequestRecordService['markFailed']>[0],
        detail: string,
    ): Promise<void> {
        if (!this.records) return;
        await this.records
            .markFailed(row, detail)
            .catch((error: unknown) =>
                this.logger.warn(
                    `Releasing upstream PR claim ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
            );
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

/** The `429` an FR-26 / FR-39 limit answers, naming the limit (FR-27). */
function limitRefusal(
    refusal: UpstreamRateLimitRefusal,
    upstream: string,
): UpstreamPullRequestOpenResult {
    const message =
        refusal.code === 'platformCapReached'
            ? `Ever Works has opened its daily limit of ${refusal.limitValue} pull requests on ${upstream}.`
            : refusal.limit === 'openPerUpstream'
              ? `You already have ${refusal.limitValue} open pull request(s) on ${upstream}.`
              : refusal.limit === 'openedPerUpstreamPer24h'
                ? `You can open ${refusal.limitValue} pull request(s) on ${upstream} per day.`
                : `You've reached this limit for now (limit: ${refusal.limitValue} per 24 hours).`;
    return {
        status: 'refused',
        httpStatus: 429,
        code: refusal.code,
        message: refusal.nextSlotAt
            ? `${message} Next one available at ${refusal.nextSlotAt}.`
            : message,
        limit: refusal.limit,
        ...(refusal.nextSlotAt ? { nextSlotAt: refusal.nextSlotAt } : {}),
    };
}

/**
 * The provider's own message, safe to keep on the record: the member's token is never
 * echoed (belt and braces — the provider SDK does not include it), and the text is capped.
 */
export function redactProviderMessage(message: string, token: string | null | undefined): string {
    let text = String(message ?? '');
    if (token && token.length >= 4) text = text.split(token).join('[redacted]');
    return text.slice(0, 500);
}

function refused(
    httpStatus: 404 | 409 | 422 | 429 | 502 | 503,
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
