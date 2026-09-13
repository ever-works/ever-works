import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    ValidateNested,
} from 'class-validator';
import {
    PROMOTION_RUNGS,
    RELEASE_BRANCH_MAX_LENGTH,
    RELEASE_VERIFY_EXPECT_MAX_LENGTH,
    RELEASE_VERIFY_URL_MAX_LENGTH,
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

/**
 * Where ONE deployed environment can be observed from outside.
 *
 * PLATFORM STATE, set deliberately by the Work's owner and read by every
 * later verification. It is not accepted anywhere on the promotion or
 * verification path: a request that could name the URL a check loads could
 * point a green verdict at a page it controls, and that verdict is the
 * only thing standing between a bad release and a human being told
 * everything is fine.
 *
 * Re-validated server-side with `sanitizeReleaseVerificationTargets`,
 * which is much stricter than these decorators — https only, no
 * credentials, no fragment, and a public DNS hostname, because these URLs
 * are loaded by a real browser on an enrolled fleet node.
 */
export class ReleaseVerificationTargetDto {
    @ApiProperty({
        maxLength: RELEASE_VERIFY_URL_MAX_LENGTH,
        example: 'https://api.ever.works/api/version',
        description:
            'A URL whose rendered DOM contains the deployed commit sha. THE artefact-identity probe: it is what lets a verification claim to have checked the build that was just promoted rather than the one that happened to be running. A plain health endpoint with no version in it will not do.',
    })
    @IsString()
    @MaxLength(RELEASE_VERIFY_URL_MAX_LENGTH)
    versionUrl: string;

    @ApiProperty({
        maxLength: RELEASE_VERIFY_URL_MAX_LENGTH,
        example: 'https://app.ever.works/api/health',
        description: 'The page that must actually render once the rollout has landed.',
    })
    @IsString()
    @MaxLength(RELEASE_VERIFY_URL_MAX_LENGTH)
    appUrl: string;

    @ApiProperty({
        maxLength: RELEASE_VERIFY_EXPECT_MAX_LENGTH,
        example: '"status":"OK"',
        description:
            'Text that must appear in the app page. Required: a browser check with no expectation passes on any document the browser managed to render, including a CDN error page.',
    })
    @IsString()
    @MaxLength(RELEASE_VERIFY_EXPECT_MAX_LENGTH)
    appExpectText: string;
}

/**
 * The per-environment verification targets, keyed by the environment a
 * rung DEPLOYS — `develop → stage` is verified against staging, and
 * `stage → main` against production.
 *
 * Both are optional and independent. An environment with no target makes a
 * promotion into it `unsupported`, reported to the owner as NOT VERIFIED,
 * which is never read as a pass.
 */
export class SetReleaseVerificationDto {
    @ApiPropertyOptional({ type: ReleaseVerificationTargetDto })
    @IsOptional()
    @IsObject()
    @ValidateNested()
    @Type(() => ReleaseVerificationTargetDto)
    staging?: ReleaseVerificationTargetDto;

    @ApiPropertyOptional({ type: ReleaseVerificationTargetDto })
    @IsOptional()
    @IsObject()
    @ValidateNested()
    @Type(() => ReleaseVerificationTargetDto)
    production?: ReleaseVerificationTargetDto;
}
