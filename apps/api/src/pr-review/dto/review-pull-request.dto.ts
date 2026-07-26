import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PR_REVIEW_INSTRUCTION_MAX_CHARS } from '@ever-works/agent/pr-review';

/**
 * Body for `POST /api/pr-review`.
 *
 * There is deliberately no `userId`: the review always runs as the
 * caller. The repository coordinate is `(owner, repo, prNumber)` because
 * that is what identifies a pull request on the provider — see the
 * controller header for why the route is not nested under a Work.
 */
export class ReviewPullRequestDto {
    @ApiProperty({ description: 'Repository owner login, e.g. `ever-works`.' })
    @IsString()
    @MaxLength(200)
    owner: string;

    @ApiProperty({ description: 'Repository name, e.g. `ever-works`.' })
    @IsString()
    @MaxLength(200)
    repo: string;

    @ApiProperty({ description: 'Pull request number.' })
    @Type(() => Number)
    @IsInt()
    @Min(1)
    prNumber: number;

    @ApiPropertyOptional({
        description:
            'Optional reviewer instruction ("focus on the migration"). Treated as untrusted data in the prompt and length-capped.',
        maxLength: PR_REVIEW_INSTRUCTION_MAX_CHARS,
    })
    @IsOptional()
    @IsString()
    @MaxLength(PR_REVIEW_INSTRUCTION_MAX_CHARS)
    instruction?: string;

    @ApiPropertyOptional({
        description:
            'Work to review against (skips repo→Work matching). Must be owned/accessible by the caller.',
    })
    @IsOptional()
    @IsUUID()
    workId?: string;
}
