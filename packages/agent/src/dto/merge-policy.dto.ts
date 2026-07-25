import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MERGE_METHODS, type MergeMethod, type MergePolicyOverride } from '@ever-works/contracts';

/**
 * Validated body shape for one scope's slice of the merge-policy matrix
 * (Wave 3, founder decision D4).
 *
 * EVERY FIELD IS OPTIONAL — and that is the point. A stored policy is a
 * PARTIAL: an omitted field means "inherit from the next scope up"
 * (Agent → Work → organization → tenant → platform default), never
 * "false". Sending `{ "allowAgentMerge": true }` on a Work grants that one
 * knob and leaves gate/approval/method/branch rules inherited.
 *
 * Shared by the Work update path (`update-work.dto.ts`), the Agent update
 * path (`apps/api/src/agents/dto/agent.dto.ts`) and the organization
 * update path, so all three surfaces enforce identical constraints on
 * what is, at rest, the same `simple-json` shape.
 */
export class MergePolicyDto implements MergePolicyOverride {
    @ApiPropertyOptional({
        description:
            'Whether an agent may LAND a pull request (distinct from opening one, which is the Agent permission `canOpenPullRequests`). Omit to inherit.',
    })
    @IsOptional()
    @IsBoolean()
    allowAgentMerge?: boolean;

    @ApiPropertyOptional({
        description:
            'Require the run’s quality gate to be green before an agent may merge. Omit to inherit.',
    })
    @IsOptional()
    @IsBoolean()
    requireGreenGate?: boolean;

    @ApiPropertyOptional({
        description:
            'Require a recorded human approval before an agent may merge. Omit to inherit.',
    })
    @IsOptional()
    @IsBoolean()
    requireHumanApproval?: boolean;

    @ApiPropertyOptional({
        description:
            'Merge strategies an agent may use. An explicitly EMPTY array refuses every agent merge; omit the field to inherit.',
        enum: MERGE_METHODS,
        isArray: true,
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(3)
    @IsIn(MERGE_METHODS, { each: true })
    allowedMergeMethods?: MergeMethod[];

    @ApiPropertyOptional({
        description:
            'Branch names an agent may never merge INTO (case-insensitive; a leading refs/heads/ is stripped). An explicitly EMPTY array protects nothing; omit the field to inherit.',
        isArray: true,
        type: String,
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @MinLength(1, { each: true })
    @MaxLength(255, { each: true })
    protectedBranches?: string[];
}
