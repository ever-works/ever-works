import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    Matches,
    MaxLength,
    Min,
} from 'class-validator';
import {
    KB_DECISION_STATUSES,
    KB_DOCUMENT_CLASSES,
    KB_DOCUMENT_STATUSES,
    KB_LOCK_MODES,
    KB_REVIEW_STATES,
    KbDecisionStatus,
    KbDocumentClass,
    KbDocumentStatus,
    KbLockMode,
    KbReviewState,
} from '@ever-works/contracts';

/** Max body size per spec D9 — 1 MB Markdown. */
const KB_BODY_MAX_BYTES = 1_048_576;
const KB_TITLE_MAX = 255;
const KB_PATH_MAX = 512;
const KB_DESCRIPTION_MAX = 2000;
const KB_TAGS_MAX = 32;
const KB_TAG_SLUG_MAX = 64;

export class CreateKbDocumentDto {
    @IsString()
    @Length(1, KB_PATH_MAX)
    path: string;

    @IsString()
    @Length(1, KB_TITLE_MAX)
    title: string;

    @IsIn(KB_DOCUMENT_CLASSES as unknown as readonly string[])
    class: KbDocumentClass;

    @IsString()
    @MaxLength(KB_BODY_MAX_BYTES)
    body: string;

    @IsOptional()
    @IsString()
    @MaxLength(KB_DESCRIPTION_MAX)
    description?: string | null;

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(KB_TAGS_MAX)
    @IsString({ each: true })
    @MaxLength(KB_TAG_SLUG_MAX, { each: true })
    tags?: string[];

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(KB_TAGS_MAX)
    @IsString({ each: true })
    @MaxLength(KB_TAG_SLUG_MAX, { each: true })
    categories?: string[];

    @IsOptional()
    @IsString()
    @Length(2, 8)
    language?: string;

    @IsOptional()
    @IsIn(KB_DOCUMENT_STATUSES as unknown as readonly string[])
    status?: KbDocumentStatus;
}

export class UpdateKbDocumentDto {
    @IsOptional()
    @IsString()
    @Length(1, KB_TITLE_MAX)
    title?: string;

    @IsOptional()
    @IsString()
    @MaxLength(KB_DESCRIPTION_MAX)
    description?: string | null;

    @IsOptional()
    @IsString()
    @MaxLength(KB_BODY_MAX_BYTES)
    body?: string;

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(KB_TAGS_MAX)
    @IsString({ each: true })
    @MaxLength(KB_TAG_SLUG_MAX, { each: true })
    tags?: string[];

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(KB_TAGS_MAX)
    @IsString({ each: true })
    @MaxLength(KB_TAG_SLUG_MAX, { each: true })
    categories?: string[];

    @IsOptional()
    @IsString()
    @Length(2, 8)
    language?: string;

    @IsOptional()
    @IsIn(KB_DOCUMENT_STATUSES as unknown as readonly string[])
    status?: KbDocumentStatus;

    @IsOptional()
    @IsIn(KB_DOCUMENT_CLASSES as unknown as readonly string[])
    class?: KbDocumentClass;
}

export class LockKbDocumentDto {
    @IsIn(KB_LOCK_MODES as unknown as readonly string[])
    mode: KbLockMode;
}

export class KbDocumentQueryDto {
    @IsOptional()
    @IsIn(KB_DOCUMENT_CLASSES as unknown as readonly string[])
    class?: KbDocumentClass;

    @IsOptional()
    @IsIn(KB_DOCUMENT_STATUSES as unknown as readonly string[])
    status?: KbDocumentStatus;

    @IsOptional()
    @IsString()
    @MaxLength(KB_TAG_SLUG_MAX)
    tag?: string;

    @IsOptional()
    @IsBoolean()
    @Type(() => Boolean)
    locked?: boolean;

    @IsOptional()
    @IsString()
    @Length(2, 8)
    language?: string;

    /**
     * Memory upgrades M8 — review-queue filter. `proposed` returns only
     * the agent-authored / synthesized documents awaiting human review
     * (the ones excluded from context injection); `accepted` returns the
     * reviewed set, including pre-M7 rows whose column is still NULL.
     * Additive: omitting it preserves the original "list everything"
     * behaviour every existing caller relies on.
     */
    @IsOptional()
    @IsIn(KB_REVIEW_STATES as unknown as readonly string[])
    reviewState?: KbReviewState;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    q?: string;

    @IsOptional()
    @IsInt()
    @Min(1)
    @Type(() => Number)
    limit?: number;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Type(() => Number)
    offset?: number;
}

export class CreateKbTagDto {
    @IsString()
    @Length(1, KB_TAG_SLUG_MAX)
    slug: string;

    @IsString()
    @Length(1, 128)
    name: string;

    @IsOptional()
    @IsString()
    @MaxLength(16)
    color?: string | null;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string | null;
}

export class UpdateKbTagDto {
    @IsOptional()
    @IsString()
    @Length(1, 128)
    name?: string;

    @IsOptional()
    @IsString()
    @MaxLength(16)
    color?: string | null;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string | null;
}

export class RestoreKbDocumentDto {
    // Security: enforce hex-only SHA to prevent arbitrary git ref names (branch, tag, HEAD~n)
    @IsString()
    @Length(7, 40)
    @Matches(/^[0-9a-f]{7,40}$/, { message: 'commitSha must be a hexadecimal Git SHA' })
    commitSha: string;
}

/**
 * Optional metadata sent alongside a `POST /api/works/:id/kb/uploads`
 * multipart request. The file itself is in the multipart `file` field;
 * these fields control how the resulting `WorkKnowledgeDocument` is
 * classified once extraction completes.
 *
 * Spec: docs/specs/features/knowledge-base/spec.md §9.7 (drag-and-drop UX).
 */
export class CreateKbUploadDto {
    @IsOptional()
    @IsIn(KB_DOCUMENT_CLASSES as unknown as readonly string[])
    targetClass?: KbDocumentClass;

    @IsOptional()
    @IsString()
    @Length(1, KB_TITLE_MAX)
    title?: string;

    @IsOptional()
    @IsString()
    @MaxLength(KB_DESCRIPTION_MAX)
    description?: string | null;

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(KB_TAGS_MAX)
    @IsString({ each: true })
    @MaxLength(KB_TAG_SLUG_MAX, { each: true })
    tags?: string[];
}

export class OrgKbDocumentScopeDto {
    @IsUUID()
    organizationId: string;
}

/**
 * Body for `POST /api/works/:id/kb/documents/:docId/decision-status`
 * (memory upgrades M4) — the platform-side decision status transition.
 * The service validates the transition against the status machine and
 * 409s on an illegal move; `supersededByDocId` records the replacement
 * chain when transitioning to `superseded`.
 */
export class TransitionKbDecisionStatusDto {
    @IsIn(KB_DECISION_STATUSES as unknown as readonly string[])
    status: KbDecisionStatus;

    @IsOptional()
    @IsUUID()
    supersededByDocId?: string;

    @IsOptional()
    @IsString()
    @MaxLength(KB_DESCRIPTION_MAX)
    rationale?: string;
}
