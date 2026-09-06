import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Get,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Post,
    Put,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { sanitizeReleaseLadder, sanitizeReleaseVerificationTargets } from '@ever-works/contracts';
import { ReleasePromotionService } from '@ever-works/agent/tasks-domain';
import { WorkRepository } from '@ever-works/agent/database';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    OpenPromotionDto,
    SetReleaseLadderDto,
    SetReleaseVerificationDto,
} from './release-promotions.dto';

/**
 * Release promotion lane (self-build slice AI, EW-808) — the operator's
 * entry point to `develop → stage → main`.
 *
 * ## The whole surface, and what it deliberately lacks
 *
 * There is no "merge" endpoint here, and no "promote everything" endpoint.
 * Opening a promotion is one deliberate act per rung; landing it is a
 * `merge_pull_request` approval in the Inbox, decided by a human and
 * re-verified against the head commit at merge time (slice AE). Nothing
 * here can merge anything, and nothing here opens the second rung when
 * the first one lands.
 *
 * ## Why `POST` is rate-limited hard
 *
 * A promotion opens a pull request on a real repository and starts a CI
 * lane measured at 215–243 minutes. Six a minute is already far more than
 * a human performs; the lane's UNIQUE index is the real duplicate guard,
 * and this is the cheap one in front of it.
 *
 * ## Post-deploy verification (slice AJ, EW-809)
 *
 * `PUT/GET verification-targets` declares WHERE each environment can be
 * observed, as platform state, exactly as `release-ladder` declares which
 * branches a promotion may touch. `GET promotions` then reports what the
 * verification found.
 *
 * There is still no endpoint here that reverts anything, and there is no
 * endpoint that starts, retries or forces a verification. A verification
 * begins when a promotion is observed merged and advances on a cron; a
 * failed one files an inert Task offering a revert for a human to decide
 * on. Nothing a caller can say to this controller reverts a deployment.
 */
@ApiTags('release')
@Controller('api/works/:workId')
export class ReleasePromotionsController {
    constructor(
        private readonly promotions: ReleasePromotionService,
        private readonly works: WorkRepository,
    ) {}

    @Put('release-ladder')
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Declare this Work’s develop → stage → main branch ladder',
        description:
            'PLATFORM STATE. Set once by the owner; every later promotion reads it. A promotion request can never name its own branches.',
    })
    async setLadder(
        @CurrentUser() user: AuthenticatedUser,
        @Param('workId', ParseUUIDPipe) workId: string,
        @Body() body: SetReleaseLadderDto,
    ) {
        const work = await this.works.findById(workId);
        if (!work || work.userId !== user.userId) {
            // Same answer for "no such Work" and "not yours".
            throw new NotFoundException(`Work ${workId} not found.`);
        }
        const ladder = sanitizeReleaseLadder(body);
        if (!ladder) {
            throw new BadRequestException(
                'A release ladder needs three DISTINCT plain branch names for integration, staging and production.',
            );
        }
        await this.works.update(workId, { releaseLadder: ladder });
        return { workId, releaseLadder: ladder };
    }

    @Get('release-ladder')
    @ApiOperation({ summary: 'Read this Work’s release ladder (null when none is configured)' })
    async getLadder(
        @CurrentUser() user: AuthenticatedUser,
        @Param('workId', ParseUUIDPipe) workId: string,
    ) {
        const work = await this.works.findById(workId);
        if (!work || work.userId !== user.userId) {
            throw new NotFoundException(`Work ${workId} not found.`);
        }
        return { workId, releaseLadder: sanitizeReleaseLadder(work.releaseLadder) };
    }

    @Put('verification-targets')
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Declare where this Work’s deployed environments can be observed',
        description:
            'PLATFORM STATE. Set by the owner; every post-deploy verification reads it. A promotion request can never name the URL its deployment is checked against.',
    })
    async setVerificationTargets(
        @CurrentUser() user: AuthenticatedUser,
        @Param('workId', ParseUUIDPipe) workId: string,
        @Body() body: SetReleaseVerificationDto,
    ) {
        const work = await this.works.findById(workId);
        if (!work || work.userId !== user.userId) {
            // Same answer for "no such Work" and "not yours".
            throw new NotFoundException(`Work ${workId} not found.`);
        }
        const targets = sanitizeReleaseVerificationTargets(body);
        if (!targets) {
            throw new BadRequestException(
                'A verification target needs an https versionUrl, an https appUrl and a non-trivial ' +
                    'appExpectText, on a public DNS hostname, for at least one environment.',
            );
        }
        await this.works.update(workId, { releaseVerification: targets });
        // Echo the SANITIZED value, never the request body: what comes back
        // is what a verification will actually load.
        return { workId, releaseVerification: targets };
    }

    @Get('verification-targets')
    @ApiOperation({
        summary: 'Read this Work’s verification targets (null when none are configured)',
    })
    async getVerificationTargets(
        @CurrentUser() user: AuthenticatedUser,
        @Param('workId', ParseUUIDPipe) workId: string,
    ) {
        const work = await this.works.findById(workId);
        if (!work || work.userId !== user.userId) {
            throw new NotFoundException(`Work ${workId} not found.`);
        }
        return {
            workId,
            releaseVerification: sanitizeReleaseVerificationTargets(work.releaseVerification),
        };
    }

    @Post('promotions')
    @Throttle({ long: { limit: 6, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Open ONE rung of the release ladder as a pull request',
        description:
            'Opens the promotion pull request and files the Task that reports the promotion-gate verdict. It does NOT merge it, and it does NOT open the next rung when this one lands.',
    })
    async open(
        @CurrentUser() user: AuthenticatedUser,
        @Param('workId', ParseUUIDPipe) workId: string,
        @Body() body: OpenPromotionDto,
    ) {
        const result = await this.promotions.openPromotion({
            userId: user.userId,
            workId,
            rung: body.rung,
            agentId: body.agentId,
        });

        if (result.outcome === 'opened') {
            return {
                outcome: 'opened' as const,
                promotion: view(result.promotion),
                taskId: result.task.id,
                taskSlug: result.task.slug,
            };
        }
        if (result.outcome === 'already-open') {
            // 409, not 200: the caller asked for a NEW promotion and got
            // somebody else's. Making that a success is how a UI ends up
            // reporting "promoted" twice for one pull request. The live
            // promotion is in the body so the caller can link to it.
            throw new ConflictException({
                message: `A ${body.rung} promotion is already open for this Work.`,
                promotion: view(result.promotion),
            });
        }
        if (result.code === 'work-not-found') {
            throw new NotFoundException(result.reason);
        }
        throw new BadRequestException({ code: result.code, message: result.reason });
    }

    @Get('promotions')
    @ApiOperation({ summary: 'This Work’s promotion history, newest first' })
    async list(
        @CurrentUser() user: AuthenticatedUser,
        @Param('workId', ParseUUIDPipe) workId: string,
        @Query('limit') limit?: string,
    ) {
        const parsed = limit ? Number.parseInt(limit, 10) : undefined;
        const rows = await this.promotions.listForWork(
            workId,
            user.userId,
            Number.isFinite(parsed) ? parsed : undefined,
        );
        return { promotions: rows.map(view) };
    }
}

/**
 * The read model. `laneKey` is deliberately NOT exposed — it is an index
 * implementation detail, and a caller that learned to read it would be
 * one edit away from writing it.
 */
function view(promotion: {
    id: string;
    rung: string;
    state: string;
    headBranch: string;
    baseBranch: string;
    headSha?: string | null;
    prNumber?: number | null;
    prUrl?: string | null;
    taskId?: string | null;
    gateWorkflow: string;
    gateVerdict?: string | null;
    gateVerdictSha?: string | null;
    gateCheckedAt?: Date | null;
    gateRunUrl?: string | null;
    gateOverridden?: boolean | null;
    refusalCode?: string | null;
    verifyState?: string | null;
    verifyExpectedSha?: string | null;
    verifyTargetUrl?: string | null;
    verifyAttempts?: number | null;
    verifyCheckedAt?: Date | null;
    verifyDetail?: string | null;
    revertTaskId?: string | null;
    revertOfferedAt?: Date | null;
    createdAt: Date;
}) {
    return {
        id: promotion.id,
        rung: promotion.rung,
        state: promotion.state,
        headBranch: promotion.headBranch,
        baseBranch: promotion.baseBranch,
        headSha: promotion.headSha ?? null,
        prNumber: promotion.prNumber ?? null,
        prUrl: promotion.prUrl ?? null,
        taskId: promotion.taskId ?? null,
        gate: {
            workflow: promotion.gateWorkflow,
            verdict: promotion.gateVerdict ?? null,
            forCommit: promotion.gateVerdictSha ?? null,
            checkedAt: promotion.gateCheckedAt ?? null,
            runUrl: promotion.gateRunUrl ?? null,
            // A `success` whose E2E leg was WAIVED by the
            // `override-e2e-gate` label rather than green. GitHub folds an
            // overridden run back into a plain `success` conclusion, so
            // without this field a caller cannot tell the two apart — and
            // this lane exists so a human can read the verdict before
            // promoting.
            overridden: promotion.gateOverridden === true,
        },
        // Post-deploy verification (slice AJ). `state: null` means the
        // deployment was never checked — which a reader must not round up
        // to "fine", so the field is always present rather than omitted.
        verification: {
            state: promotion.verifyState ?? null,
            // The commit the deployment was held to. Not `headSha`: the
            // merge produced a new commit, and this is the base branch's
            // tip read straight afterwards.
            expectedSha: promotion.verifyExpectedSha ?? null,
            lastUrl: promotion.verifyTargetUrl ?? null,
            attempts: promotion.verifyAttempts ?? 0,
            checkedAt: promotion.verifyCheckedAt ?? null,
            detail: promotion.verifyDetail ?? null,
        },
        // A revert that was OFFERED. There is deliberately no field here
        // saying a revert happened, because nothing in this platform
        // reverts: this is a Task id a human may act on, and landing what
        // it produces still needs a merge approval.
        revertOffer: promotion.revertTaskId
            ? { taskId: promotion.revertTaskId, offeredAt: promotion.revertOfferedAt ?? null }
            : null,
        refusalCode: promotion.refusalCode ?? null,
        createdAt: promotion.createdAt,
    };
}
