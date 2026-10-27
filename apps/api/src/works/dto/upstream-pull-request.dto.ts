import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    UPSTREAM_CHECKS_SUMMARIES,
    UPSTREAM_PULL_REQUEST_ORIGINS,
    UPSTREAM_PULL_REQUEST_STATES,
    UPSTREAM_RATE_LIMIT_KEYS,
    UPSTREAM_REFUSAL_CODES,
    UPSTREAM_REVIEW_SUMMARIES,
    UPSTREAM_SIGNATURE_STATES,
} from '@ever-works/contracts';

/**
 * APW-09 T10 — the OpenAPI shapes of `/api/works/:id/upstream-pull-requests[...]` (G11,
 * XC-23). The field lists are plan §3.3's `UpstreamPullRequestView`,
 * `UpstreamPullRequestDetailView` and `UpstreamEligibilityView`
 * (`packages/contracts/src/apps/upstream-pull-request.types.ts`); these classes document them,
 * the controller returns the contract objects themselves.
 */

class UpstreamCoordinatesDto {
    @ApiProperty({ example: 'acme' }) owner: string;
    @ApiProperty({ example: 'bookings' }) repo: string;
    @ApiProperty({ example: 'main' }) baseBranch: string;
}

class UpstreamHeadDto {
    @ApiProperty({ example: 'maya' }) owner: string;
    @ApiProperty({ example: 'bookings' }) repo: string;
    @ApiProperty({ example: 'upstream-pr/sms-reminder-1a2b' }) branch: string;
    @ApiProperty({ type: String, nullable: true }) sha: string | null;
}

class UpstreamDiffStatsDto {
    @ApiProperty() files: number;
    @ApiProperty() additions: number;
    @ApiProperty() deletions: number;
    @ApiProperty({ type: [String], description: '≤ 3 files "Not in the original change" (FR-10).' })
    extraFiles: string[];
}

export class UpstreamPullRequestViewDto {
    @ApiProperty({ format: 'uuid' }) id: string;
    @ApiProperty({ type: String, format: 'uuid', nullable: true }) sourceTaskId: string | null;
    @ApiProperty({
        format: 'uuid',
        description: 'The author: whose GitHub account the pull request carries.',
    })
    userId: string;
    @ApiProperty({ enum: [...UPSTREAM_PULL_REQUEST_ORIGINS] }) origin: string;
    @ApiProperty({ enum: [...UPSTREAM_PULL_REQUEST_STATES] }) state: string;
    @ApiProperty({ type: UpstreamCoordinatesDto }) upstream: UpstreamCoordinatesDto;
    @ApiProperty({ type: UpstreamHeadDto }) head: UpstreamHeadDto;
    @ApiProperty({ type: Number, nullable: true }) number: number | null;
    @ApiProperty({ type: String, nullable: true }) url: string | null;
    @ApiProperty() draft: boolean;
    @ApiProperty({ type: String, nullable: true }) title: string | null;
    @ApiProperty({ type: String, nullable: true }) body: string | null;
    @ApiProperty({ type: String, nullable: true }) disclosureText: string | null;
    @ApiProperty() maintainerCanModify: boolean;
    @ApiProperty({ enum: [...UPSTREAM_CHECKS_SUMMARIES], nullable: true }) checksSummary:
        | string
        | null;
    @ApiProperty({ enum: [...UPSTREAM_REVIEW_SUMMARIES], nullable: true }) reviewSummary:
        | string
        | null;
    @ApiProperty({ enum: [...UPSTREAM_SIGNATURE_STATES], nullable: true }) signatureState:
        | string
        | null;
    @ApiProperty({ type: String, nullable: true }) refusalCode: string | null;
    @ApiProperty({ type: String, nullable: true }) refusalDetail: string | null;
    @ApiProperty({ type: UpstreamDiffStatsDto, nullable: true })
    diffStats: UpstreamDiffStatsDto | null;
    @ApiProperty({ type: String, nullable: true }) extraFilesAcknowledgedAt: string | null;
    @ApiProperty({ type: String, nullable: true }) approvalProposalId: string | null;
    @ApiProperty({ type: String, nullable: true }) approvalExpiresAt: string | null;
    @ApiProperty({ type: String, nullable: true }) openedAt: string | null;
    @ApiProperty({ type: String, nullable: true }) mergedAt: string | null;
    @ApiProperty({ type: String, nullable: true }) closedAt: string | null;
    @ApiProperty({ type: String, nullable: true }) lastUpstreamActivityAt: string | null;
    @ApiProperty({ type: String, nullable: true }) nextCheckAt: string | null;
    @ApiProperty() createdAt: string;
    @ApiProperty() updatedAt: string;
}

export class UpstreamPullRequestDetailViewDto extends UpstreamPullRequestViewDto {
    @ApiProperty({
        type: Object,
        nullable: true,
        description:
            'The prepared diff, while awaiting approval (300 files / 1 MB). `null` until preparation ships.',
    })
    diff: Record<string, unknown> | null;
    @ApiProperty({
        type: [Object],
        nullable: true,
        description: 'Agent-reported check results (FR-47).',
    })
    checkResults: Record<string, unknown>[] | null;
    @ApiProperty({ type: [String], nullable: true }) missingPieces: string[] | null;
    @ApiProperty({ type: String, nullable: true }) claUrl: string | null;
}

class UpstreamPullRequestListMetaDto {
    @ApiProperty() total: number;
}

export class UpstreamPullRequestListDto {
    @ApiProperty({ type: [UpstreamPullRequestViewDto] }) data: UpstreamPullRequestViewDto[];
    @ApiProperty({ type: UpstreamPullRequestListMetaDto }) meta: UpstreamPullRequestListMetaDto;
}

class UpstreamEligibilityTargetDto {
    @ApiProperty() owner: string;
    @ApiProperty() repo: string;
    @ApiProperty() baseBranch: string;
    @ApiProperty() forkOwner: string;
    @ApiProperty() forkRepo: string;
}

export class UpstreamEligibilityViewDto {
    @ApiProperty() allowed: boolean;
    @ApiPropertyOptional({ enum: [...UPSTREAM_REFUSAL_CODES] }) code?: string;
    @ApiPropertyOptional({
        enum: [...UPSTREAM_RATE_LIMIT_KEYS],
        description: 'FR-27: which limit refused.',
    })
    limit?: string;
    @ApiPropertyOptional({ description: 'ISO; absent for `openPerUpstream`.' }) nextSlotAt?: string;
    @ApiPropertyOptional() limitValue?: number;
    @ApiProperty({ type: UpstreamEligibilityTargetDto, nullable: true })
    target: UpstreamEligibilityTargetDto | null;
    @ApiProperty() orgFork: boolean;
    @ApiProperty() maintainerCanModifyDefault: boolean;
    @ApiProperty({ type: String, nullable: true, enum: ['fork', 'private-copy', 'link'] })
    relation: string | null;
    @ApiProperty({
        description: '`false` until the preparation step ships: nothing can be prepared yet.',
    })
    preparationAvailable: boolean;
    @ApiPropertyOptional({
        type: String,
        nullable: true,
        description: 'FR-5: the record that already holds this Task’s active slot.',
    })
    activeProposalId?: string | null;
}
