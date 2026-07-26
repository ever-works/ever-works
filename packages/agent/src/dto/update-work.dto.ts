import { Type, Transform } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsOptional,
    IsString,
    IsBoolean,
    IsEmail,
    IsIn,
    IsInt,
    IsUUID,
    Max,
    ValidateNested,
    MaxLength,
    Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    WORK_CHECKS_POLICIES,
    WORK_EXTERNAL_REFS_MAX_PER_KIND,
    WORK_EXTERNAL_REF_KINDS,
    type WorkChecksPolicy,
    type WorkExternalRefs,
} from '@ever-works/contracts';
import { AcceptanceCheckDto } from './acceptance-check.dto';
import { MergePolicyDto } from './merge-policy.dto';
import { MarkdownReadmeConfigDto } from './create-work.dto';
import { sanitizeName, sanitizeDescription } from '../utils/sanitize.util';

export class UpdateWorkDto {
    @ApiPropertyOptional({ description: 'Display name for the work', maxLength: 100 })
    @IsString()
    @IsOptional()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name?: string;

    @ApiPropertyOptional({ description: 'Brief description of the work', maxLength: 500 })
    @IsString()
    @IsOptional()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    description?: string;

    @ApiPropertyOptional({ description: 'Username or organization for repository ownership' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    owner?: string;

    @ApiPropertyOptional({ description: 'Whether the owner is an organization' })
    @IsOptional()
    organization?: boolean;

    @ApiPropertyOptional({ description: 'Deploy provider (e.g., vercel)' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    deployProvider?: string;

    @ApiPropertyOptional({ description: 'Website template identifier for this work' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    websiteTemplateId?: string;

    @ApiPropertyOptional({
        description: 'Custom README configuration',
        type: MarkdownReadmeConfigDto,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => MarkdownReadmeConfigDto)
    readmeConfig?: MarkdownReadmeConfigDto;

    @ApiPropertyOptional({ description: 'Whether to auto-update the website template' })
    @IsOptional()
    @IsBoolean()
    websiteTemplateAutoUpdate?: boolean;

    @ApiPropertyOptional({ description: 'Whether to use the beta website template' })
    @IsOptional()
    @IsBoolean()
    websiteTemplateUseBeta?: boolean;

    @ApiPropertyOptional({
        description:
            'Whether to generate the browsable repository published to the git provider ' +
            '(the "{provider} Repository"). Defaults to true. A Work kind that never ' +
            'provisions that repository ignores this flag.',
    })
    @IsOptional()
    @IsBoolean()
    providerRepositoryEnabled?: boolean;

    /** Task isolation (worktree-per-Task, Wave 2). 'off' | 'worktree'. */
    @IsOptional()
    @IsIn(['off', 'worktree'])
    taskIsolation?: string;

    @IsOptional()
    @IsString()
    @MaxLength(128)
    taskIsolationBaseBranch?: string | null;

    @IsOptional()
    @IsIn(['work-output', 'data', 'provider'])
    taskIsolationTargetRepo?: string;

    @IsOptional()
    @IsIn(['on-merge', 'manual'])
    taskBranchCleanup?: string;

    @ApiPropertyOptional({
        description:
            'Memory recall injection toggle (on by default). When false, self-managed pipeline runs for this Work skip the fenced agent-memory recall block in their session preamble.',
    })
    @IsOptional()
    @IsBoolean()
    memoryRecallEnabled?: boolean;
    @ApiPropertyOptional({
        description:
            'Work-level default acceptance checks inherited by agent-executed Tasks under this Work. ' +
            'Pass `null` to clear the defaults. Max 20 entries.',
        type: AcceptanceCheckDto,
        isArray: true,
        nullable: true,
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @ValidateNested({ each: true })
    @Type(() => AcceptanceCheckDto)
    checkDefaults?: AcceptanceCheckDto[] | null;

    @ApiPropertyOptional({
        description:
            "Enforcement policy for acceptance checks: 'off' (never run), 'warn' (run + report, red does not block) or 'required' (red blocks Task completion).",
        enum: WORK_CHECKS_POLICIES,
    })
    @IsOptional()
    @IsIn(WORK_CHECKS_POLICIES)
    checksPolicy?: WorkChecksPolicy;

    @ApiPropertyOptional({
        description:
            "Default gate-attempt budget for Tasks that don't set their own maxGateAttempts.",
        minimum: 1,
        maximum: 5,
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(5)
    maxGateAttempts?: number;

    @ApiPropertyOptional({
        description:
            'Work-scoped slice of the merge-policy matrix (Wave 3, D4). PARTIAL by design: every field ' +
            'omitted inside the object inherits from the organization, then the tenant, then the platform ' +
            'default. Pass `null` to clear the Work override entirely and inherit everything.',
        type: MergePolicyDto,
        nullable: true,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => MergePolicyDto)
    mergePolicy?: MergePolicyDto | null;

    @ApiPropertyOptional({ description: 'Whether community PR processing is enabled' })
    @IsOptional()
    @IsBoolean()
    communityPrEnabled?: boolean;

    @ApiPropertyOptional({ description: 'Whether to auto-close community PRs after processing' })
    @IsOptional()
    @IsBoolean()
    communityPrAutoClose?: boolean;

    @ApiPropertyOptional({ description: 'Custom git committer name for this work', maxLength: 120 })
    @IsString()
    @IsOptional()
    @MaxLength(120)
    // Security: bound + sanitize committer name (flows into git commit author
    // metadata via Work.resolveCommitter). Prevents oversized/control-char
    // names from being embedded in git objects. Null (clear override) passes
    // through untouched. 120 matches the agent entity's varchar(120) column.
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 120) : value))
    committerName?: string | null;

    @ApiPropertyOptional({ description: 'Custom git committer email for this work' })
    @IsEmail()
    @IsOptional()
    committerEmail?: string | null;

    @ApiPropertyOptional({
        description:
            'Activity Feed sync transport (pull / push / disabled). Source of truth is `activity_sync.mode` in works.yml; this field is the platform-side read path. Settings updates flow here then get round-tripped to works.yml by the WorksConfigRepositorySync flow.',
        enum: ['pull', 'push', 'disabled'],
    })
    @IsOptional()
    @IsIn(['pull', 'push', 'disabled'])
    activitySyncMode?: 'pull' | 'push' | 'disabled';

    @ApiPropertyOptional({
        description:
            'Membership-scope organization UUID. Pairs the Work with an organization-scope KB document set: when set, the Workbench shows org-level docs as "inherited" under the Work\'s KB tree (Phase 2/e A19+A20). Pass `null` to clear the membership. Independent of the `organization: boolean` flag above (which controls Git repository ownership shape, not KB inheritance).',
        nullable: true,
    })
    @IsString()
    @IsOptional()
    // Security: require a well-formed UUID (was @IsString() only), rejecting
    // arbitrary attacker-supplied strings used to probe/guess foreign org ids.
    // Runs after the Transform below, which maps null/'' -> null; @IsOptional()
    // skips this for null so the "clear membership" path is unaffected.
    // NOTE: this is input-shape hardening only — it does NOT verify the caller
    // is a member of the referenced organization. The membership/authorization
    // check must be enforced in the service layer (see deferred finding).
    @IsUUID()
    @Transform(({ value }) =>
        value === null || value === '' ? null : typeof value === 'string' ? value.trim() : value,
    )
    organizationId?: string | null;

    @ApiPropertyOptional({
        description:
            'External containers this Work claims, keyed by ingest hint kind (' +
            `${WORK_EXTERNAL_REF_KINDS.join(' | ')}). Ingested events carrying one of these ` +
            'identifiers route to this Work. At most ' +
            `${WORK_EXTERNAL_REFS_MAX_PER_KIND} identifiers per kind; matching is ` +
            'case-insensitive and trimmed. Pass `null` (or an object whose kinds are all ' +
            'empty) to clear every claim. `repo` is intentionally absent — repository ' +
            'hints resolve through the repositories the Work already declares.',
        example: { 'chat-channel': ['C0123456789'], 'tracker-team': ['ENG'] },
        nullable: true,
    })
    @IsOptional()
    // Shape validation (known kinds, per-kind cap, id length) and the
    // cross-Work duplicate-claim check both live in the service layer
    // (`validateWorkExternalRefs` / `findExternalRefConflicts`), which is
    // the single source of truth shared with the campaign-activation and
    // account-import paths. The DTO only declares the property so
    // `forbidNonWhitelisted` lets it through.
    externalRefs?: WorkExternalRefs | null;
}
