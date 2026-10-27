import {
    Controller,
    Get,
    HttpCode,
    HttpException,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    UPSTREAM_PULL_REQUEST_STATES,
    isAppWorkKind,
    type UpstreamPullRequestDetailView,
    type UpstreamPullRequestListResponse,
    type UpstreamPullRequestState,
    type UpstreamPullRequestView,
} from '@ever-works/contracts';
import { UpstreamPullRequestRepository } from '@ever-works/agent/database';
import { WorkOwnershipService, type WorkAccessResult } from '@ever-works/agent/services';
import {
    UpstreamEligibilityService,
    UpstreamPullRequestRecordService,
    toUpstreamPullRequestView,
    type UpstreamEligibilityResult,
    type UpstreamRecordChangeResult,
} from '@ever-works/agent/upstream-pull-requests';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { requireHumanSession } from '../auth/machine-principal';
import {
    UpstreamEligibilityViewDto,
    UpstreamPullRequestDetailViewDto,
    UpstreamPullRequestListDto,
    UpstreamPullRequestViewDto,
} from './dto/upstream-pull-request.dto';

/**
 * APW-09 T10 / T19 (no-credential half) — `/api/works/:id/upstream-pull-requests[...]`.
 *
 * | Route | Access | What |
 * |---|---|---|
 * | `GET  …/upstream-pull-requests` | view | every member's records for the App Work, newest first (`?state`, `?limit ≤ 100`) |
 * | `GET  …/upstream-pull-requests/eligibility` | edit | may the CALLER propose (`?taskId`) — FR-3, FR-4 (platform half), FR-5, FR-26, FR-39, FR-41, FR-46 |
 * | `GET  …/upstream-pull-requests/:prId` | view | one record, with the detail fields |
 * | `POST …/upstream-pull-requests/:prId/withdraw` | edit + author or owner | FR-33, before the pull request exists |
 * | `POST …/upstream-pull-requests/:prId/acknowledge-extra-files` | edit + author + human session | FR-49 / G06 |
 *
 * ## The gates (each has a spec that fails without it)
 *
 * - **Workspace scope.** `AuthSessionGuard` on the class, then `WorkOwnershipService`: a missing,
 *   invisible or other account's App Work is ONE `404 not_found` (a `403` is folded into it, so
 *   a stranger cannot tell "exists" from "does not"). The sibling `work-evolve.controller.ts`
 *   posture. A non-App Work is `422 notAppWork`.
 * - **Record scope.** Every record read is keyed by the App Work (`findForWork(workId, prId)`):
 *   another App Work's record id answers `404`, never that record.
 * - **Author.** Only the author acknowledges extra files (their name goes on the pull request,
 *   FR-21); withdrawing also admits the App Work's owner. Anyone else: `403 authorRequired`.
 * - **Human only.** The acknowledgement is the human review FR-49 records: an API key, an
 *   integration key or a fleet run is refused by `requireHumanSession`.
 * - **No token anywhere.** Nothing here resolves or returns a credential; the views are an
 *   explicit field list (`toUpstreamPullRequestView`) without `fingerprint` or scope columns.
 *
 * `POST …/upstream-pull-requests` (propose), `…/signed`, `…/check` and `…/address-review` need
 * the preparation, approval and status jobs (APW-09 T13–T19) and are not mounted yet.
 */
@ApiTags('App Works')
@ApiBearerAuth('JWT-auth')
@Controller('api/works')
@UseGuards(AuthSessionGuard)
export class UpstreamPullRequestsController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly records: UpstreamPullRequestRepository,
        private readonly writer: UpstreamPullRequestRecordService,
        private readonly eligibility: UpstreamEligibilityService,
    ) {}

    @Get(':id/upstream-pull-requests')
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'List an App Work’s upstream pull requests (APW-09)',
        description:
            'Every member’s upstream pull request records for this App Work — proposals and pull requests opened directly — newest first. Each row names its author (`userId`). Needs view access; another account’s App Work answers `404`.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiQuery({ name: 'state', required: false, enum: [...UPSTREAM_PULL_REQUEST_STATES] })
    @ApiQuery({ name: 'limit', required: false, description: '1–100, default 20' })
    @ApiResponse({ status: 200, type: UpstreamPullRequestListDto })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('state') state?: string,
        @Query('limit') limit?: string,
    ): Promise<UpstreamPullRequestListResponse> {
        await this.authorize(id, auth.userId, 'view');
        const stateFilter = parseState(state);
        const { rows, total } = await this.records.listForWork(id, {
            state: stateFilter,
            limit: parseLimit(limit),
        });
        return { data: rows.map(toUpstreamPullRequestView), meta: { total } };
    }

    @Get(':id/upstream-pull-requests/eligibility')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Whether the caller may propose a Task upstream (APW-09)',
        description:
            'The Propose upstream pre-flight: the operator switch and deny list, the fork relation, the App spec opt-in, the source Task’s merge, the one active proposal per Task, the caller’s own git connection and the FR-26 / FR-39 limits (with `limit` and `nextSlotAt`). Needs edit access. `preparationAvailable: false` while the preparation step has not shipped.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiQuery({ name: 'taskId', required: false, description: 'The source Task (uuid)' })
    @ApiResponse({ status: 200, type: UpstreamEligibilityViewDto })
    async getEligibility(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('taskId', new ParseUUIDPipe({ optional: true })) taskId?: string,
    ): Promise<UpstreamEligibilityResult> {
        await this.authorize(id, auth.userId, 'edit');
        const result = await this.eligibility.evaluate({
            workId: id,
            userId: auth.userId,
            taskId: taskId ?? null,
        });
        if (result.taskNotOnWork) {
            throw new HttpException(
                {
                    status: 'error',
                    code: 'taskNotOnWork',
                    message: `Task ${taskId} is not a Task of this App Work.`,
                },
                HttpStatus.NOT_FOUND,
            );
        }
        return result;
    }

    @Get(':id/upstream-pull-requests/:prId')
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Read one upstream pull request record (APW-09)',
        description:
            'One record of this App Work with its detail fields. A record of another App Work answers `404`.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'prId', description: 'Upstream pull request record ID' })
    @ApiResponse({ status: 200, type: UpstreamPullRequestDetailViewDto })
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('prId', ParseUUIDPipe) prId: string,
    ): Promise<UpstreamPullRequestDetailView> {
        await this.authorize(id, auth.userId, 'view');
        const row = await this.records.findForWork(id, prId);
        if (!row) throw recordNotFound(prId);
        return {
            ...toUpstreamPullRequestView(row),
            // The compare read lands with the preparation step (T19's diff, 300 files / 1 MB).
            diff: null,
            checkResults: row.checkResults ?? null,
            missingPieces: row.missingPieces ?? null,
            claUrl: row.claUrl ?? null,
        };
    }

    @Post(':id/upstream-pull-requests/:prId/withdraw')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Withdraw an upstream pull request proposal before it is opened (APW-09 FR-33)',
        description:
            'Only before the pull request exists (`preparing`, `needs_signature`, `awaiting_approval`); after that `409 notWithdrawable` — close it on GitHub. The author or the App Work owner only (`403 authorRequired`). The fork branch is removed by the status job.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'prId', description: 'Upstream pull request record ID' })
    @ApiResponse({ status: 200, type: UpstreamPullRequestViewDto })
    async withdraw(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('prId', ParseUUIDPipe) prId: string,
    ): Promise<UpstreamPullRequestView> {
        const access = await this.authorize(id, auth.userId, 'edit');
        const result = await this.writer.withdraw(id, prId, {
            userId: auth.userId,
            isWorkOwner: access.isCreator === true || access.work.userId === auth.userId,
        });
        return answer(result);
    }

    @Post(':id/upstream-pull-requests/:prId/acknowledge-extra-files')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Record “I’ve reviewed the extra files” (APW-09 FR-49)',
        description:
            'The author’s acknowledgement of the files the prepared change touches outside the original change; required before any approval. `409 extraFilesNotPresent` when there are none. A signed-in person only — never an API key, an integration key or an automation.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'prId', description: 'Upstream pull request record ID' })
    @ApiResponse({ status: 200, type: UpstreamPullRequestViewDto })
    async acknowledgeExtraFiles(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('prId', ParseUUIDPipe) prId: string,
    ): Promise<UpstreamPullRequestView> {
        await this.authorize(id, auth.userId, 'edit');
        requireHumanSession(auth, 'acknowledge the extra files of an upstream pull request');
        const result = await this.writer.acknowledgeExtraFiles(id, prId, auth.userId);
        return answer(result);
    }

    /** View/edit access to an App Work, or the one refusal each failure gets. */
    private async authorize(
        workId: string,
        userId: string,
        level: 'view' | 'edit',
    ): Promise<WorkAccessResult> {
        let access: WorkAccessResult;
        try {
            access =
                level === 'edit'
                    ? await this.ownership.ensureCanEdit(workId, userId)
                    : await this.ownership.ensureCanView(workId, userId);
        } catch (error) {
            if (error instanceof HttpException) {
                const status = error.getStatus();
                if (status === HttpStatus.NOT_FOUND || status === HttpStatus.FORBIDDEN) {
                    throw new HttpException(
                        { status: 'error', code: 'not_found', message: `Work ${workId} not found.` },
                        HttpStatus.NOT_FOUND,
                    );
                }
            }
            throw error;
        }
        if (!isAppWorkKind(access.work.kind)) {
            throw new HttpException(
                { status: 'error', code: 'notAppWork', message: `Work ${workId} is not an App Work.` },
                HttpStatus.UNPROCESSABLE_ENTITY,
            );
        }
        return access;
    }
}

function answer(result: UpstreamRecordChangeResult): UpstreamPullRequestView {
    if (result.status === 'ok') return toUpstreamPullRequestView(result.row);
    const refused = result as Extract<UpstreamRecordChangeResult, { status: 'refused' }>;
    throw new HttpException(
        { status: 'error', code: refused.code, message: refused.message },
        refused.httpStatus,
    );
}

function recordNotFound(prId: string): HttpException {
    return new HttpException(
        { status: 'error', code: 'not_found', message: `Upstream pull request ${prId} not found.` },
        HttpStatus.NOT_FOUND,
    );
}

function parseState(value: string | undefined): UpstreamPullRequestState | null {
    if (value === undefined || value === '') return null;
    if ((UPSTREAM_PULL_REQUEST_STATES as readonly string[]).includes(value)) {
        return value as UpstreamPullRequestState;
    }
    throw new HttpException(
        { status: 'error', code: 'invalidState', message: `Unknown state "${String(value).slice(0, 40)}".` },
        HttpStatus.BAD_REQUEST,
    );
}

function parseLimit(value: string | undefined): number | null {
    if (value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
