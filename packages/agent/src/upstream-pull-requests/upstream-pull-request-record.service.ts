import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    UPSTREAM_POLLING,
    UPSTREAM_WITHDRAWABLE_STATES,
    type UpstreamPrActivityEvent,
    type UpstreamPullRequestState,
    type UpstreamPullRequestView,
} from '@ever-works/contracts';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import type { UpstreamPullRequest } from '../entities/upstream-pull-request.entity';
import {
    UpstreamPullRequestRepository,
    type UpstreamPullRequestPatch,
} from '../database/repositories/upstream-pull-request.repository';

/**
 * A direct pull request left in `opening` longer than this is a crashed request, not an
 * in-flight one: the provider call it was waiting on has long timed out. The next claim on
 * the same source Task moves it to `failed` so the slot is not held forever.
 */
export const UPSTREAM_DIRECT_OPENING_STALE_MS = 15 * 60_000;

/** The answer of a member's state change on one record (`withdraw`, `acknowledgeExtraFiles`). */
export type UpstreamRecordChangeResult =
    | { readonly status: 'ok'; readonly row: UpstreamPullRequest }
    | {
          readonly status: 'refused';
          readonly httpStatus: 403 | 404 | 409 | 503;
          readonly code:
              | 'not_found'
              | 'authorRequired'
              | 'notWithdrawable'
              | 'extraFilesNotPresent'
              | 'notAwaitingApproval'
              | 'unavailable';
          readonly message: string;
      };

/** What a direct pull request claims before the provider is called. */
export interface UpstreamDirectClaimInput {
    readonly workId: string;
    readonly userId: string;
    readonly sourceTaskId: string | null;
    readonly upstreamOwner: string;
    readonly upstreamRepo: string;
    readonly baseBranch: string;
    readonly headOwner: string;
    readonly headRepo: string;
    readonly headBranch: string;
    readonly title: string | null;
    readonly body: string | null;
    readonly draft: boolean;
    readonly maintainerCanModify: boolean;
    readonly tenantId?: string | null;
    readonly organizationId?: string | null;
    readonly now?: Date;
}

export type UpstreamDirectClaim =
    | { readonly status: 'claimed'; readonly row: UpstreamPullRequest }
    | { readonly status: 'active'; readonly activeId: string | null }
    /** No store in this process: the pull request is opened without a record (the pre-APW-09 behaviour). */
    | { readonly status: 'unrecorded' };

/**
 * APW-09 T7/T35 — the one writer of `upstream_pull_requests` rows and their `app_upstream_pr`
 * Activity (R-2), for every door that creates or moves a record.
 *
 * ## What the Activity rows carry (FR-37)
 *
 * `details` hold the upstream `owner/repo`, the number, the URL, the state, the origin and a
 * refusal code — never the title, the body or a diff. The summary names the upstream and
 * the number only. The status follows plan §3.4's per-event table, which is what puts a
 * refused / failed / withdrawn record in the Live Feed's problem bucket.
 *
 * Both collaborators are `@Optional()`: a graph without the store answers `unrecorded` and
 * the caller keeps its pre-record behaviour; a graph without the Activity writer records the
 * row and logs that the Activity line was skipped. An Activity failure never fails the
 * state change it describes.
 */
@Injectable()
export class UpstreamPullRequestRecordService {
    private readonly logger = new Logger(UpstreamPullRequestRecordService.name);

    constructor(
        @Optional() private readonly records?: UpstreamPullRequestRepository,
        @Optional() private readonly activity?: ActivityLogService,
    ) {}

    /** `true` when this process can write records. */
    get available(): boolean {
        return !!this.records;
    }

    /**
     * Claim the source Task's one active slot for a direct pull request, BEFORE the provider
     * is called, in state `opening`. `openedAt` is stamped now so a concurrent request counts
     * this one in its 24-hour windows; a failure clears it again.
     */
    async claimDirect(input: UpstreamDirectClaimInput): Promise<UpstreamDirectClaim> {
        if (!this.records) return { status: 'unrecorded' };
        const now = input.now ?? new Date();

        if (input.sourceTaskId) {
            const active = await this.records.findActiveBySourceTask(
                input.workId,
                input.sourceTaskId,
            );
            if (active && isStaleDirectOpening(active, now)) {
                await this.records.updateStateIf(active.id, active.workId, ['opening'], 'failed', {
                    openedAt: null,
                    nextCheckAt: null,
                    refusalDetail: 'The request that was opening this pull request did not finish.',
                });
            } else if (active) {
                return { status: 'active', activeId: active.id };
            }
        }

        const result = await this.records.insertActive({
            workId: input.workId,
            userId: input.userId,
            sourceTaskId: input.sourceTaskId,
            origin: 'direct',
            upstreamOwner: input.upstreamOwner,
            upstreamRepo: input.upstreamRepo,
            baseBranch: input.baseBranch,
            headOwner: input.headOwner,
            headRepo: input.headRepo,
            headBranch: input.headBranch,
            title: input.title ? input.title.slice(0, 200) : null,
            body: input.body ?? null,
            draft: input.draft,
            maintainerCanModify: input.maintainerCanModify,
            state: 'opening',
            openedAt: now,
            tenantId: input.tenantId ?? null,
            organizationId: input.organizationId ?? null,
        });
        if (!result.inserted || !result.row) return { status: 'active', activeId: result.activeId };
        return { status: 'claimed', row: result.row };
    }

    /** `opening → open` with the provider's answer, and the `opened` Activity line. */
    async markOpened(
        row: UpstreamPullRequest,
        pr: { number: number; url: string; headSha?: string | null },
        now: Date = new Date(),
    ): Promise<boolean> {
        if (!this.records) return false;
        const moved = await this.records.updateStateIf(row.id, row.workId, ['opening'], 'open', {
            number: pr.number,
            url: pr.url,
            headSha: pr.headSha ?? null,
            openedAt: now,
            lastUpstreamActivityAt: now,
            nextCheckAt: new Date(now.getTime() + UPSTREAM_POLLING.earlyIntervalMs),
        });
        if (moved) {
            await this.recordActivity(
                { ...row, number: pr.number, url: pr.url, state: 'open' },
                'app.upstream_pr.opened',
                ActivityStatus.COMPLETED,
                `Opened ${row.draft ? 'a draft ' : 'a '}pull request on ${upstreamOf(row)} (#${pr.number})`,
            );
        }
        return moved;
    }

    /** `opening → failed` when the provider refused, and the `failed` Activity line. */
    async markFailed(
        row: UpstreamPullRequest,
        detail: string | null,
        refusalCode: string | null = null,
    ): Promise<boolean> {
        if (!this.records) return false;
        const moved = await this.records.updateStateIf(row.id, row.workId, ['opening'], 'failed', {
            openedAt: null,
            nextCheckAt: null,
            refusalCode,
            refusalDetail: detail ? detail.slice(0, 500) : null,
        });
        if (moved) {
            await this.recordActivity(
                { ...row, state: 'failed', refusalCode },
                'app.upstream_pr.failed',
                ActivityStatus.FAILED,
                `A pull request on ${upstreamOf(row)} could not be opened`,
            );
        }
        return moved;
    }

    /**
     * Compare-and-set any state change through the one writer, with its Activity line.
     * `false` (and no Activity) when the record was not in one of `from`.
     */
    async transition(
        row: UpstreamPullRequest,
        from: readonly UpstreamPullRequestState[],
        to: UpstreamPullRequestState,
        patch: UpstreamPullRequestPatch,
        activity: {
            event: UpstreamPrActivityEvent;
            status: ActivityStatus;
            summary: string;
            actorUserId?: string;
        },
    ): Promise<boolean> {
        if (!this.records) return false;
        const moved = await this.records.updateStateIf(row.id, row.workId, from, to, patch);
        if (moved) {
            await this.recordActivity(
                { ...row, ...patch, state: to },
                activity.event,
                activity.status,
                activity.summary,
                activity.actorUserId,
            );
        }
        return moved;
    }

    /**
     * FR-33 — **Withdraw**, before the pull request exists.
     *
     * Only the author (whose name the pull request would carry) or the App Work's owner may
     * withdraw; any other editor is refused `403 authorRequired`. Only `preparing`,
     * `needs_signature` and `awaiting_approval` are withdrawable (`409 notWithdrawable` after
     * that: an opened pull request is closed on the provider by the member, never by Ever Works,
     * FR-32). The compare-and-set is the fence against a concurrent open.
     *
     * The fork branch is NOT deleted here: `forkBranchDeletedAt` stays NULL, which is the status
     * job's (T18) cue to delete it with the member's token within 10 minutes. No credential is
     * used by this call.
     */
    async withdraw(
        workId: string,
        id: string,
        actor: { userId: string; isWorkOwner: boolean },
    ): Promise<UpstreamRecordChangeResult> {
        if (!this.records) return unavailable();
        const row = await this.records.findForWork(workId, id);
        if (!row) return notFound(id);
        if (row.userId !== actor.userId && !actor.isWorkOwner) {
            return {
                status: 'refused',
                httpStatus: 403,
                code: 'authorRequired',
                message: 'Only the member who proposed this pull request, or the App Work owner, can withdraw it.',
            };
        }
        const withdrawable = UPSTREAM_WITHDRAWABLE_STATES as readonly UpstreamPullRequestState[];
        const moved = await this.transition(
            row,
            withdrawable,
            'withdrawn',
            { nextCheckAt: null, closedAt: new Date() },
            {
                event: 'app.upstream_pr.withdrawn',
                status: ActivityStatus.CANCELLED,
                summary: `Withdrew a pull request proposal for ${upstreamOf(row)}`,
                actorUserId: actor.userId,
            },
        );
        if (!moved) {
            return {
                status: 'refused',
                httpStatus: 409,
                code: 'notWithdrawable',
                message:
                    row.state === 'open' || row.state === 'opening'
                        ? 'This pull request is already open upstream. Close it on GitHub if you no longer want it.'
                        : `This proposal is ${row.state} and can no longer be withdrawn.`,
            };
        }
        const fresh = await this.records.findForWork(workId, id);
        return { status: 'ok', row: fresh ?? { ...row, state: 'withdrawn' } };
    }

    /**
     * FR-49 / G06 — "I've reviewed the extra files", recorded for the AUTHOR, the only person
     * whose approval counts (FR-21). `409 extraFilesNotPresent` when the prepared diff marks no
     * file "Not in the original change"; `409 notAwaitingApproval` outside the approval window.
     * Idempotent: a second acknowledgement keeps the first time.
     */
    async acknowledgeExtraFiles(
        workId: string,
        id: string,
        actorUserId: string,
        now: Date = new Date(),
    ): Promise<UpstreamRecordChangeResult> {
        if (!this.records) return unavailable();
        const row = await this.records.findForWork(workId, id);
        if (!row) return notFound(id);
        if (row.userId !== actorUserId) {
            return {
                status: 'refused',
                httpStatus: 403,
                code: 'authorRequired',
                message: 'Only the member who will publish this pull request can acknowledge its extra files.',
            };
        }
        const extra = Array.isArray(row.diffStats?.extraFiles) ? row.diffStats.extraFiles : [];
        if (extra.length === 0) {
            return {
                status: 'refused',
                httpStatus: 409,
                code: 'extraFilesNotPresent',
                message: 'This proposal changes no file outside the original change.',
            };
        }
        if (row.extraFilesAcknowledgedAt) return { status: 'ok', row };
        const patched = await this.records.patchIf(row.id, workId, ['awaiting_approval'], {
            extraFilesAcknowledgedAt: now,
            extraFilesAcknowledgedById: actorUserId,
        });
        if (!patched) {
            return {
                status: 'refused',
                httpStatus: 409,
                code: 'notAwaitingApproval',
                message: 'Extra files can only be acknowledged while the proposal is awaiting your approval.',
            };
        }
        const fresh = await this.records.findForWork(workId, id);
        return {
            status: 'ok',
            row: fresh ?? { ...row, extraFilesAcknowledgedAt: now, extraFilesAcknowledgedById: actorUserId },
        };
    }

    /** One `app_upstream_pr` Activity row (R-2). Best-effort: never fails the caller. */
    async recordActivity(
        row: Pick<
            UpstreamPullRequest,
            | 'id'
            | 'userId'
            | 'workId'
            | 'upstreamOwner'
            | 'upstreamRepo'
            | 'state'
            | 'origin'
            | 'tenantId'
            | 'organizationId'
        > &
            Partial<
                Pick<
                    UpstreamPullRequest,
                    'number' | 'url' | 'refusalCode' | 'draft' | 'sourceTaskId'
                >
            >,
        event: UpstreamPrActivityEvent,
        status: ActivityStatus,
        summary: string,
        actorUserId?: string,
    ): Promise<void> {
        if (!this.activity) {
            this.logger.warn(
                `Upstream PR ${row.id}: ${event} was not recorded (no ActivityLogService).`,
            );
            return;
        }
        try {
            await this.activity.log({
                // The Activity row lands in the feed of whoever acted (the author by default).
                userId: actorUserId ?? row.userId,
                workId: row.workId,
                tenantId: row.tenantId ?? null,
                organizationId: row.organizationId ?? null,
                actionType: ActivityActionType.APP_UPSTREAM_PR,
                action: event,
                status,
                summary: summary.slice(0, 250),
                // FR-37: coordinates, number, link, state and code — never a title, body or diff.
                details: {
                    upstreamPullRequestId: row.id,
                    upstream: upstreamOf(row),
                    number: row.number ?? null,
                    url: row.url ?? null,
                    state: row.state,
                    origin: row.origin,
                    draft: row.draft ?? null,
                    refusalCode: row.refusalCode ?? null,
                    sourceTaskId: row.sourceTaskId ?? null,
                },
            });
        } catch (error) {
            this.logger.warn(
                `Upstream PR ${row.id}: recording ${event} failed (${error instanceof Error ? error.message : String(error)}).`,
            );
        }
    }
}

function unavailable(): UpstreamRecordChangeResult {
    return {
        status: 'refused',
        httpStatus: 503,
        code: 'unavailable',
        message: 'Upstream pull requests are not available in this process.',
    };
}

function notFound(id: string): UpstreamRecordChangeResult {
    return {
        status: 'refused',
        httpStatus: 404,
        code: 'not_found',
        message: `Upstream pull request ${id} not found.`,
    };
}

function upstreamOf(row: { upstreamOwner: string; upstreamRepo: string }): string {
    return `${row.upstreamOwner}/${row.upstreamRepo}`;
}

function isStaleDirectOpening(row: UpstreamPullRequest, now: Date): boolean {
    if (row.state !== 'opening' || row.origin !== 'direct') return false;
    const since = row.updatedAt ?? row.createdAt;
    const at = since ? new Date(since).getTime() : NaN;
    return Number.isFinite(at) && now.getTime() - at > UPSTREAM_DIRECT_OPENING_STALE_MS;
}

/** ISO or `null` — every date in a view. */
function iso(value: Date | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * The API's row view (plan §3.3 `UpstreamPullRequestView`). An explicit field list: the
 * `fingerprint`, the scope columns, the Task ids of the preparation and follow-up runs, the
 * seen-review and push bookkeeping never leave the API (T10: "no row leaks `fingerprint`").
 */
export function toUpstreamPullRequestView(row: UpstreamPullRequest): UpstreamPullRequestView {
    return {
        id: row.id,
        sourceTaskId: row.sourceTaskId ?? null,
        userId: row.userId,
        origin: row.origin ?? 'proposal',
        state: row.state,
        upstream: { owner: row.upstreamOwner, repo: row.upstreamRepo, baseBranch: row.baseBranch },
        head: {
            owner: row.headOwner,
            repo: row.headRepo,
            branch: row.headBranch,
            sha: row.headSha ?? null,
        },
        number: row.number ?? null,
        url: row.url ?? null,
        draft: row.draft === true,
        title: row.title ?? null,
        body: row.body ?? null,
        disclosureText: row.disclosureText ?? null,
        maintainerCanModify: row.maintainerCanModify !== false,
        checksSummary: row.checksSummary ?? null,
        reviewSummary: row.reviewSummary ?? null,
        signatureState: row.signatureState ?? null,
        refusalCode: row.refusalCode ?? null,
        refusalDetail: row.refusalDetail ?? null,
        diffStats: row.diffStats ?? null,
        extraFilesAcknowledgedAt: iso(row.extraFilesAcknowledgedAt),
        approvalProposalId: row.approvalProposalId ?? null,
        approvalExpiresAt: iso(row.approvalExpiresAt),
        openedAt: iso(row.openedAt),
        mergedAt: iso(row.mergedAt),
        closedAt: iso(row.closedAt),
        lastUpstreamActivityAt: iso(row.lastUpstreamActivityAt),
        nextCheckAt: iso(row.nextCheckAt),
        createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
        updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
    };
}
