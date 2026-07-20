import { ApiProperty } from '@nestjs/swagger';
import {
    IsBoolean,
    IsIn,
    IsEnum,
    IsIn,
    IsInt,
    IsOptional,
    IsUUID,
    IsString,
    Matches,
    MaxLength,
    Min,
    MinLength,
    Validate,
    ValidateIf,
    ValidateNested,
    ValidatorConstraint,
    type ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MissionType } from '@ever-works/agent/missions';
// Security (SSRF): lexical guard reused by MissionsService.normalizeTemplateRepo to
// vet full-URL forms of `missionTemplateRepo`. Mirror that check at the DTO boundary
// so a hostile value is rejected before the service ever sees it (defense-in-depth).
import { isSafeWebhookUrl } from '@ever-works/agent/utils';
// Security: import the typed guardrails DTO so guardrailsOverride is validated against a strict allowlist
import { WorkAgentGuardrailsDto } from '../../work-agent/dto/work-agent.dto';

// Security (SSRF defense-in-depth): `missionTemplateRepo` is consumed by the Phase 8
// scaffolder to clone/fetch a template repo. The service-layer
// `MissionsService.normalizeTemplateRepo` (packages/agent/src/missions/missions.service.ts)
// already vets the value, but it runs AFTER the DTO. Enforce the SAME accepted shapes
// at the DTO boundary so SSRF/scheme-injection payloads are rejected by the global
// ValidationPipe before they reach the service. The three accepted shapes mirror the
// service exactly:
//   1. GitHub-style `owner/repo` slug  (2+ segments of [A-Za-z0-9._-] joined by `/`)
//   2. bare catalog-id selector        (single [A-Za-z0-9._-] segment, no `/`)
//   3. a full HTTPS git URL on a public host (no embedded credentials, passes the
//      lexical SSRF guard) — `http://`, `file://`, `git://`, `ssh://`, private/
//      loopback/metadata hosts and `user:pass@` forms are all rejected.
// Empty / whitespace-only strings are accepted here because the service treats them as
// "clear the field" (returns null) — preserving the currently-accepted clear behavior.
const TEMPLATE_REPO_SLUG_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;
const TEMPLATE_REPO_BARE_SLUG_RE = /^[A-Za-z0-9._-]+$/;

@ValidatorConstraint({ name: 'isMissionTemplateRepo', async: false })
class IsMissionTemplateRepo implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        if (typeof value !== 'string') return false;
        const trimmed = value.trim();
        // Empty/whitespace clears the field at the service layer — preserve that.
        if (trimmed.length === 0) return true;
        if (trimmed.length > 200) return false;
        if (TEMPLATE_REPO_SLUG_RE.test(trimmed)) return true;
        if (TEMPLATE_REPO_BARE_SLUG_RE.test(trimmed)) return true;
        // Only other acceptable shape: a full HTTPS git URL on a public host with no
        // embedded credentials, passing the shared lexical SSRF guard.
        let parsed: URL | null = null;
        try {
            parsed = new URL(trimmed);
        } catch {
            parsed = null;
        }
        return Boolean(
            parsed &&
            parsed.protocol === 'https:' &&
            !parsed.username &&
            !parsed.password &&
            isSafeWebhookUrl(trimmed),
        );
    }

    defaultMessage(): string {
        return 'missionTemplateRepo must be a GitHub-style "owner/repo" slug, a bare catalog id, or an HTTPS git URL on a public host';
    }
}

/**
 * Phase 3 PR H — request body for `POST /me/missions`. Validated
 * by NestJS's global ValidationPipe via class-validator decorators.
 * The schedule-vs-type consistency rule (scheduled→schedule required,
 * one-shot→no schedule) is enforced server-side in the service
 * layer (`assertScheduleConsistency`) rather than as a cross-field
 * DTO rule — class-validator's cross-field validation is awkward
 * for this pattern and the service-side check is the single source
 * of truth that PATCH also reuses.
 */
export class CreateMissionDto {
    /**
     * Phase 3 PR I — optional. When omitted, the service generates
     * a short title from `description` via the shared TitlerService.
     * Callers that DO want to control the title can still pass it.
     */
    @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title?: string;

    @ApiProperty({ minLength: 1, maxLength: 10000 })
    @IsString()
    @MinLength(1)
    @MaxLength(10000)
    description: string;

    @ApiProperty({ enum: MissionType })
    @IsEnum(MissionType)
    type: MissionType;

    @ApiProperty({
        required: false,
        nullable: true,
        description:
            'Cron expression. Required when type=scheduled, MUST be null/omitted when type=one-shot.',
    })
    @IsOptional()
    @ValidateIf((o) => o.schedule !== null)
    @IsString()
    @MaxLength(64)
    schedule?: string | null;

    @ApiProperty({ required: false, default: false })
    @IsOptional()
    @IsBoolean()
    autoBuildWorks?: boolean;

    /**
     * Soft cap on PENDING/QUEUED/BUILDING Ideas this Mission can
     * have outstanding. NULL = inherit user-level default
     * (`WorkAgentPreference.missionDefaultOutstandingCap`, Phase 0
     * PR 0.4). Negative sentinel (-1) = "unlimited" — the tick
     * worker (PR J) treats negative as no cap.
     */
    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsInt()
    @Min(-1)
    outstandingIdeasCap?: number | null;

    @ApiProperty({
        required: false,
        nullable: true,
        description: 'Sparse override of the user-level WorkAgentGuardrails for spawned Ideas.',
    })
    // Security: use typed WorkAgentGuardrailsDto instead of @IsObject() to enforce field allowlist and
    // numeric bounds, preventing unbounded JSON DoS via oversized or deeply-nested payloads.
    @IsOptional()
    @ValidateNested()
    @Type(() => WorkAgentGuardrailsDto)
    guardrailsOverride?: WorkAgentGuardrailsDto | null;

    @ApiProperty({ required: false, nullable: true, maxLength: 200 })
    @IsOptional()
    @ValidateIf((o) => o.missionTemplateRepo !== null)
    @IsString()
    @MaxLength(200)
    // Security (SSRF defense-in-depth): enforce the accepted owner/repo-slug,
    // bare-catalog-id, or HTTPS-public-host shape at the DTO boundary, mirroring
    // MissionsService.normalizeTemplateRepo so SSRF payloads are rejected up front.
    @Validate(IsMissionTemplateRepo)
    missionTemplateRepo?: string | null;
}

/**
 * Phase 3 PR HH — request body for `POST /me/missions/:id/clone`.
 * Only field today is the optional `title` override; everything
 * else carries verbatim from the source Mission (spec §4.4a +
 * Decision A25). Future additions (e.g. opt-out of Ideas copy,
 * select-which-Ideas) would land here as additional optional
 * fields without breaking the empty-body case.
 */
export class CloneMissionDto {
    @ApiProperty({
        required: false,
        minLength: 1,
        maxLength: 200,
        description:
            'Title for the cloned Mission. Defaults to "Copy of <source title>" when omitted.',
    })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title?: string;
}

/**
 * Phase 3 PR H — request body for `PATCH /me/missions/:id`. All
 * fields optional; undefined = leave existing untouched; `null`
 * on the nullable fields explicitly clears them. State (`status`)
 * is intentionally NOT updatable here — use the lifecycle
 * endpoints (pause / resume / complete) for state transitions.
 */
export class UpdateMissionDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title?: string;

    @ApiProperty({ required: false, minLength: 1, maxLength: 10000 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(10000)
    description?: string;

    @ApiProperty({ required: false, enum: MissionType })
    @IsOptional()
    @IsEnum(MissionType)
    type?: MissionType;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @ValidateIf((o) => o.schedule !== null)
    @IsString()
    @MaxLength(64)
    schedule?: string | null;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    autoBuildWorks?: boolean;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsInt()
    @Min(-1)
    outstandingIdeasCap?: number | null;

    @ApiProperty({ required: false, nullable: true })
    // Security: use typed WorkAgentGuardrailsDto instead of @IsObject() to enforce field allowlist and
    // numeric bounds, preventing unbounded JSON DoS via oversized or deeply-nested payloads.
    @IsOptional()
    @ValidateNested()
    @Type(() => WorkAgentGuardrailsDto)
    guardrailsOverride?: WorkAgentGuardrailsDto | null;

    @ApiProperty({ required: false, nullable: true, maxLength: 200 })
    @IsOptional()
    @ValidateIf((o) => o.missionTemplateRepo !== null)
    @IsString()
    @MaxLength(200)
    // Security (SSRF defense-in-depth): enforce the accepted owner/repo-slug,
    // bare-catalog-id, or HTTPS-public-host shape at the DTO boundary, mirroring
    // MissionsService.normalizeTemplateRepo so SSRF payloads are rejected up front.
    @Validate(IsMissionTemplateRepo)
    missionTemplateRepo?: string | null;
}

/**
 * PR-2 (domain-model evolution) — attach an existing Work to a Mission
 * with a typed relation. Relation values mirror
 * `MISSION_WORK_RELATIONS` on the entity; validated again at the
 * service layer.
 */
export class AttachMissionWorkDto {
    @ApiProperty({ description: 'Id of an existing Work owned by the caller', format: 'uuid' })
    @IsUUID()
    workId!: string;

    @ApiProperty({
        description: 'How the Mission relates to the Work',
        enum: ['created', 'improves', 'operates', 'markets', 'researches', 'retires'],
    })
    @IsIn(['created', 'improves', 'operates', 'markets', 'researches', 'retires'])
    relation!: 'created' | 'improves' | 'operates' | 'markets' | 'researches' | 'retires';
}

/**
 * PR-3 (domain-model evolution, review §23.2) - optional conclusion
 * verdict recorded when a human completes a Mission. Omitting it keeps
 * today's behavior exactly (outcome stays NULL).
 */
export class CompleteMissionDto {
    @IsOptional()
    @IsIn(['succeeded', 'partially_succeeded', 'failed', 'cancelled', 'superseded'])
    outcome?: 'succeeded' | 'partially_succeeded' | 'failed' | 'cancelled' | 'superseded' | null;
}

export class AddMissionAttachmentDto {
    @ApiProperty({
        description: 'Upload id returned by POST /api/uploads/file.',
        pattern: '^[0-9a-fA-F]{64}$',
    })
    @IsString()
    @Matches(/^[0-9a-f]{64}$/i)
    uploadId: string;
}
