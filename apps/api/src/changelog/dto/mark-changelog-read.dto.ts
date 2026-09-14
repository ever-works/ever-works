import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString, Matches } from 'class-validator';
import {
    CHANGELOG_LIMITS,
    CHANGELOG_SLUG_PATTERN,
    type ChangelogMarkReadRequestDto,
} from '@ever-works/contracts/api';

/**
 * What's new (AW-14) — `POST /api/changelog/read` body.
 *
 * 1–25 well-formed slugs per write (spec FR-6, FR-17). A slug the running
 * build does not ship is well-formed and accepted; the service ignores it.
 */
export class MarkChangelogReadDto implements ChangelogMarkReadRequestDto {
    @ApiProperty({
        type: [String],
        minItems: 1,
        maxItems: CHANGELOG_LIMITS.markReadBatchMax,
        example: ['approve-agent-merges-in-inbox'],
        description: 'Slugs of the product changelog entries the reader has now seen.',
    })
    @IsArray()
    @ArrayNotEmpty()
    @ArrayMaxSize(CHANGELOG_LIMITS.markReadBatchMax)
    @IsString({ each: true })
    @Matches(CHANGELOG_SLUG_PATTERN, { each: true })
    slugs!: string[];
}
