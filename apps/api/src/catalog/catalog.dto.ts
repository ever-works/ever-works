import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import {
    PLAYBOOK_CATEGORIES,
    type PlaybookCategory,
    type PlaybookReadinessState,
} from '@ever-works/contracts';

/** Readiness states the list can be narrowed to (the three chip filters). */
export const PLAYBOOK_LIST_READINESS_FILTERS = ['ready', 'needs_connection', 'adopted'] as const;

/** Largest page the list returns, however much is asked for. */
export const PLAYBOOK_LIST_MAX_LIMIT = 50;
export const PLAYBOOK_LIST_DEFAULT_LIMIT = 24;

const toInteger = ({ value }: { value: unknown }) =>
    value === undefined || value === null || value === '' ? undefined : Number(value);

export class ListPlaybooksDto {
    @ApiPropertyOptional({ enum: PLAYBOOK_CATEGORIES })
    @IsOptional()
    @IsIn(PLAYBOOK_CATEGORIES)
    category?: PlaybookCategory;

    @ApiPropertyOptional({ minLength: 2, maxLength: 64 })
    @IsOptional()
    @IsString()
    @Length(2, 64)
    search?: string;

    @ApiPropertyOptional({ enum: PLAYBOOK_LIST_READINESS_FILTERS })
    @IsOptional()
    @IsIn(PLAYBOOK_LIST_READINESS_FILTERS)
    readiness?: Extract<PlaybookReadinessState, (typeof PLAYBOOK_LIST_READINESS_FILTERS)[number]>;

    @ApiPropertyOptional({
        minimum: 1,
        maximum: PLAYBOOK_LIST_MAX_LIMIT,
        default: PLAYBOOK_LIST_DEFAULT_LIMIT,
        description: 'Values above 50 are clamped to 50.',
    })
    @IsOptional()
    @Transform(({ value }) => {
        const parsed = toInteger({ value });
        return parsed === undefined ? undefined : Math.min(parsed, PLAYBOOK_LIST_MAX_LIMIT);
    })
    @IsInt()
    @Min(1)
    limit?: number;

    @ApiPropertyOptional({ minimum: 0, default: 0 })
    @IsOptional()
    @Transform(toInteger)
    @IsInt()
    @Min(0)
    offset?: number;
}

export class PreflightPlaybookDto {
    @ApiPropertyOptional({ description: 'The Work the playbook would be scoped to.' })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @Length(1, 200)
    instanceName?: string;
}
