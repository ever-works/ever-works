import { Type, Transform } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsPositive,
    IsString,
    Matches,
    MaxLength,
    ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const GOAL_WINDOWS = ['day', 'week', 'month', 'total', 'point'] as const;

/** Optional measurable target carried on a campaign brief. */
export class CampaignTargetDto {
    @ApiPropertyOptional({
        description:
            'Metric id the campaign Goal targets. Constrained to the campaign Work kind’s own metric vocabulary (defaults to `conversions`).',
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    metricId?: string;

    @ApiPropertyOptional({ description: 'Target value (must be positive).', example: 25 })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    value?: number;

    @ApiPropertyOptional({ description: 'Unit label for the target.', example: 'signups' })
    @IsOptional()
    @IsString()
    @MaxLength(32)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    unit?: string;

    @ApiPropertyOptional({
        description: 'Evaluation window for the Goal.',
        enum: GOAL_WINDOWS,
    })
    @IsOptional()
    @IsIn(GOAL_WINDOWS)
    window?: (typeof GOAL_WINDOWS)[number];
}

/**
 * Body of `POST /api/works/from-campaign-template`.
 *
 * A brief, not a Work payload: the activation service derives the Work,
 * the Goal, the go-to-market Agents, the seeded pipeline Tasks and the
 * pipeline preference from these few fields.
 */
export class CreateCampaignWorkDto {
    @ApiProperty({ description: 'Campaign name.', maxLength: 100, example: 'Q3 developer launch' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    name: string;

    @ApiProperty({
        description: 'What the campaign is trying to achieve — becomes the campaign Goal.',
        maxLength: 500,
        example: 'Book 25 qualified demos with platform engineering teams',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    objective: string;

    @ApiPropertyOptional({
        description:
            'Explicit slug for the campaign Work. Derived from `name` (and de-duplicated) when omitted.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message: 'Slug can only contain lowercase letters, numbers, and hyphens',
    })
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    slug?: string;

    @ApiPropertyOptional({ description: 'Optional measurable target.', type: CampaignTargetDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => CampaignTargetDto)
    target?: CampaignTargetDto;

    @ApiPropertyOptional({
        description:
            'Channels the campaign runs on (email, linkedin, newsletter…). Recorded as labels on the seeded pipeline Tasks. Max 10.',
        type: [String],
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(10)
    @IsString({ each: true })
    @MaxLength(40, { each: true })
    channels?: string[];
}
