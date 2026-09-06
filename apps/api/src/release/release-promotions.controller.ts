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
import { sanitizeReleaseLadder } from '@ever-works/contracts';
import { ReleasePromotionService } from '@ever-works/agent/tasks-domain';
import { WorkRepository } from '@ever-works/agent/database';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { OpenPromotionDto, SetReleaseLadderDto } from './release-promotions.dto';

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
        refusalCode: promotion.refusalCode ?? null,
        createdAt: promotion.createdAt,
    };
}
