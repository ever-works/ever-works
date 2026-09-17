import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    Allow,
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Min,
    ValidateNested,
} from 'class-validator';
import {
    SHARED_VIEW_LIMITS,
    SHARED_VIEW_STATUSES,
    type SharedViewStatus,
} from '@ever-works/contracts/api';

/** The sections facet of a settings change. Each flag optional. */
export class SharedViewSectionsPatchDto {
    @ApiPropertyOptional({ description: 'Publish the Task board.' })
    @IsOptional()
    @IsBoolean()
    board?: boolean;

    @ApiPropertyOptional({
        description: 'Publish the knowledge library. Refused until the knowledge section ships.',
    })
    @IsOptional()
    @IsBoolean()
    knowledge?: boolean;
}

/** `PATCH /api/organizations/:orgId/shared-view` — one optional field per facet. */
export class UpdateSharedViewDto {
    @ApiPropertyOptional({
        enum: SHARED_VIEW_STATUSES,
        description: '`paused` turns sharing off and keeps the link.',
    })
    @IsOptional()
    @IsIn([...SHARED_VIEW_STATUSES])
    status?: SharedViewStatus;

    @ApiPropertyOptional({ type: SharedViewSectionsPatchDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => SharedViewSectionsPatchDto)
    sections?: SharedViewSectionsPatchDto;

    @ApiPropertyOptional({
        type: [String],
        description: 'Knowledge Base classes to publish. Empty publishes nothing.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(SHARED_VIEW_LIMITS.knowledgeClassLimit)
    @IsString({ each: true })
    knowledgeClasses?: string[];

    @ApiPropertyOptional({ description: 'Allow search engines to index the published page.' })
    @IsOptional()
    @IsBoolean()
    searchIndexable?: boolean;
}

/** `POST /api/organizations/:orgId/shared-view/regenerate` */
export class RegenerateSharedViewDto {
    @ApiPropertyOptional({
        description:
            'The rotation count the caller last saw. When another tab regenerated since, the request answers 409 and changes nothing.',
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    expectedRotationCount?: number;
}

/**
 * `POST /api/public/shared-view/sessions` — the token travels only here, in a
 * body. The field is named `token` so every request recorder that drops
 * body secrets already drops it.
 *
 * Deliberately NOT shape-validated here: a malformed token must answer the
 * exact same response as an unknown or revoked one, so the service decides.
 */
export class CreateSharedViewSessionDto {
    @ApiProperty({ description: 'The share token from the link.' })
    @Allow()
    token?: unknown;
}
