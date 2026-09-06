import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, IsUUID, MaxLength } from 'class-validator';
import {
    PROMOTION_RUNGS,
    RELEASE_BRANCH_MAX_LENGTH,
    type PromotionRung,
} from '@ever-works/contracts';

// Why every field carries `@ApiProperty`: the API build runs no
// `@nestjs/swagger` CLI plugin, so a DTO field without an explicit
// decorator is simply absent from the OpenAPI document — and the MCP
// server derives its tool schemas from that document.

/**
 * Everything a caller may say about a promotion.
 *
 * Note what is NOT here: no branch names, no repository, no owner. Those
 * come from the Work's `releaseLadder` and its source repository. A
 * request that could name its own branches could open
 * `their-branch → main` and call it a release, so it cannot.
 *
 * The RUNG is the caller's only choice, and it is a closed enum. That is
 * the deliberate act the founder performs per batch: `develop → stage`
 * now, `stage → main` later, after reading the end-to-end verdict.
 */
export class OpenPromotionDto {
    @ApiProperty({
        enum: PROMOTION_RUNGS as unknown as string[],
        description:
            'Which rung of the release ladder to promote. The BRANCHES come from the Work, never from this request.',
    })
    @IsIn(PROMOTION_RUNGS as unknown as string[])
    rung: PromotionRung;

    @ApiProperty({
        format: 'uuid',
        description:
            'Agent the promotion Task is attributed to. Must be owned by the caller — the Inbox merge approval this Task later raises is decidable only by that owner.',
    })
    @IsUUID()
    agentId: string;
}

/**
 * The release ladder, set as PLATFORM STATE on the Work.
 *
 * Deliberately a separate, deliberate configuration act from asking for a
 * promotion: the owner declares the ladder once, and every later promotion
 * reads it. Re-validated with `sanitizeReleaseLadder` server-side, which
 * refuses anything that is not three distinct plain branch names.
 */
export class SetReleaseLadderDto {
    @ApiProperty({ maxLength: RELEASE_BRANCH_MAX_LENGTH, example: 'develop' })
    @IsString()
    @MaxLength(RELEASE_BRANCH_MAX_LENGTH)
    integration: string;

    @ApiProperty({ maxLength: RELEASE_BRANCH_MAX_LENGTH, example: 'stage' })
    @IsString()
    @MaxLength(RELEASE_BRANCH_MAX_LENGTH)
    staging: string;

    @ApiProperty({ maxLength: RELEASE_BRANCH_MAX_LENGTH, example: 'main' })
    @IsString()
    @MaxLength(RELEASE_BRANCH_MAX_LENGTH)
    production: string;
}
