import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, ValidateIf } from 'class-validator';
import {
    APP_BLUEPRINT_APPLY_STATUSES,
    APP_SPEC_EVALUATION_TRIGGERS,
    APP_SPEC_SEVERITIES,
    APP_SPEC_VALIDATION_STATUSES,
    BLUEPRINT_MATCH_SOURCES,
    LICENSE_CLASSES,
    LICENSE_REGISTRY_SOURCES,
    LICENSE_SOURCES,
    type AppBlueprintApplyRef,
    type AppBlueprintApplyStatus,
    type AppBlueprintUpgradePr,
    type AppLicenseEvidence,
    type AppLicenseHeaderFinding,
    type AppSpec,
    type AppSpecEvaluationTrigger,
    type AppSpecIssue,
    type AppSpecSeverity,
    type AppSpecValidationStatus,
    type LicenseAttestation,
    type LicenseClass,
    type LicenseRegistrySource,
    type LicenseSource,
    type WorkAppSpecFileLink,
    type WorkAppSpecLinks,
    type WorkAppSpecStateDto,
} from '@ever-works/contracts';
import type { WorkAppSpecState } from '@ever-works/agent/entities';
import type { AppSpecDraftValidation } from '@ever-works/agent/app-spec';

/**
 * APW-03 T15 — the DTOs of `GET /api/works/:id/app-spec` and
 * `POST /api/works/:id/app-spec/validate` (plan §4.1, `plan.md:547-548`, and
 * §4.3, `plan.md:576-583`).
 *
 * ## The request DTO validates shape; the route decides the rest
 *
 * `source` is the plan's own two-member union and `content` is required exactly
 * when `source` is `'content'` — a body that could never be validated is refused
 * by the platform's `ValidationPipe` with the field named, rather than reaching
 * the service.
 *
 * `content` is deliberately **not** bounded here. Plan §4.2 makes a file larger
 * than 256 KiB a `413 { code: "file_too_large" }`, and `@MaxLength` would turn
 * that into a `400` from the pipe — a different code and a different status for
 * the one input the plan names. The ceiling is `APP_SPEC_FILE_MAX_BYTES` and the
 * route checks it, so the answer is the one §4.2 fixes.
 *
 * ## The response classes are a mirror, and `implements` is what keeps them one
 *
 * Every class below `implements` the `@ever-works/contracts` type it documents,
 * so a field added to `WorkAppSpecStateDto` fails `type-check` here until the
 * Swagger document describes it too (the same discipline
 * `app-source-inspect.dto.ts` records). The classes are **never instantiated by
 * the route** — `toWorkAppSpecStateResponse` builds the plain object and the
 * classes exist for the document — so the `!` declarations are the shape, not a
 * value.
 *
 * `effectiveSpec` is documented as an open object: the App spec is a 600-line
 * contracts interface of its own (`app-spec.types.ts:952`), the page renders it
 * section by section from `AppSpecSections`, and mirroring it here would put a
 * second copy of the whole schema in the API's document — one that drifts the
 * first time a block is added. The one authority for that shape is the App spec
 * JSON Schema (`GET /api/schema/app-spec.schema.json`, T21).
 */

/* -------------------------------------------------------------------------- *
 * Request
 * -------------------------------------------------------------------------- */

/**
 * The two inputs of plan §4.1: `branch` re-checks the tracked branch, `content`
 * validates text the member is still editing.
 */
export const APP_SPEC_VALIDATE_SOURCES = ['branch', 'content'] as const;

/** Union derived from {@link APP_SPEC_VALIDATE_SOURCES}. */
export type AppSpecValidateSource = (typeof APP_SPEC_VALIDATE_SOURCES)[number];

/**
 * `POST /api/works/:id/app-spec/validate`'s body (plan §4.1:548):
 * `{ source: 'branch' }` or `{ source: 'content', content }`.
 */
export class AppSpecValidateRequestDto {
    @ApiProperty({
        enum: APP_SPEC_VALIDATE_SOURCES,
        description:
            '`branch` re-checks the tracked branch’s head and answers `202`; `content` validates the text ' +
            'in `content` and answers `200` without storing anything (plan §4.1:548, ACC-03-08).',
        example: 'branch',
    })
    @IsIn(APP_SPEC_VALIDATE_SOURCES)
    source!: AppSpecValidateSource;

    @ApiPropertyOptional({
        description:
            'The draft `.works/works.yml` to validate. Required when `source` is `content` and ignored ' +
            'when it is `branch`. Its UTF-8 length is what the 256 KiB ceiling is measured on ' +
            '(`APP_SPEC_FILE_MAX_BYTES`): a larger value is refused with `413 file_too_large`.',
    })
    @ValidateIf((body: AppSpecValidateRequestDto) => body.source === 'content')
    @IsString()
    content?: string;
}

/* -------------------------------------------------------------------------- *
 * Responses — one class per nested shape of the contract
 * -------------------------------------------------------------------------- */

/**
 * A name for the contract's own nested issue shape: a class may only `implements`
 * an identifier (TS2500), and the interface stays the single definition.
 */
export class AppSpecIssueDto implements AppSpecIssue {
    @ApiProperty({
        description: 'One member of `APP_SPEC_ISSUE_CODES` (contracted, append-only).',
        example: 'web_component_needs_port',
    })
    code!: AppSpecIssue['code'];

    @ApiProperty({ enum: APP_SPEC_SEVERITIES })
    severity!: AppSpecSeverity;

    @ApiProperty({ example: 'spec.components[0].port' })
    path!: string;

    @ApiProperty({ example: '/spec/components/0/port' })
    pointer!: string;

    @ApiProperty({ example: 'components › web › port' })
    displayPath!: string;

    @ApiPropertyOptional({
        description:
            '1-based YAML line, absent when the caller validated parsed text (plan §2.2:144).',
    })
    line?: number;

    @ApiPropertyOptional({ description: '1-based, absent together with `line`.' })
    column?: number;

    @ApiProperty({
        description: 'English fallback; the web renders its own translated copy per code.',
    })
    message!: string;

    @ApiPropertyOptional()
    hint?: string;

    @ApiPropertyOptional({
        description: 'Names and scalar facts only — never a value of a `secret` entry (FR-6).',
        type: Object,
    })
    params?: Readonly<Record<string, string | number | boolean>>;
}

/** `WorkAppSpecFileLink` (plan §4.3:578-580) — where the spec file can be opened. */
export class WorkAppSpecFileLinkDto implements WorkAppSpecFileLink {
    @ApiProperty({
        description:
            'The provider’s web URL for the file at `commitSha`. The URL shape belongs to the provider ' +
            '(plan §7:720) and never to the web app; empty only when no provider could answer.',
        example:
            'https://github.com/ever-works/example-app/blob/0123456789abcdef0123456789abcdef01234567/.works/works.yml',
    })
    base!: string;

    @ApiProperty({ nullable: true, description: 'The head commit when one was read.' })
    commitSha!: string | null;

    @ApiProperty({ example: '.works/works.yml' })
    path!: string;
}

/** The `links` block of the DTO (plan §4.3:578-580). */
export class WorkAppSpecLinksDto implements WorkAppSpecLinks {
    @ApiProperty({ type: () => WorkAppSpecFileLinkDto })
    file!: WorkAppSpecFileLinkDto;

    @ApiProperty({
        nullable: true,
        description:
            'The provider’s line-anchor template, e.g. `#L{line}`. `null` when the provider offers none, ' +
            'in which case a problem row links to the file. `buildAppSpecLineLink` is the one place it is ' +
            'expanded.',
        example: '#L{line}',
    })
    lineAnchor!: string | null;
}

/** `blueprintApplyRef` (plan §3.1:429). */
export class AppBlueprintApplyRefDto implements AppBlueprintApplyRef {
    @ApiProperty({ enum: ['commit', 'pull_request'] })
    kind!: 'commit' | 'pull_request';

    @ApiPropertyOptional({ description: 'Present with `kind: "commit"`.' })
    sha?: string;

    @ApiPropertyOptional({ description: 'Present with `kind: "pull_request"`.' })
    number?: number;

    @ApiProperty()
    url!: string;
}

/** `blueprintUpgradePr` (plan §3.1:432). */
export class AppBlueprintUpgradePrDto implements AppBlueprintUpgradePr {
    @ApiProperty()
    number!: number;

    @ApiProperty()
    url!: string;

    @ApiProperty()
    version!: string;

    @ApiProperty({ description: 'A `MAJOR` bump sets this (FR-51).' })
    breaking!: boolean;
}

/** One licence header finding (plan §2.6:324-325). */
export class AppLicenseHeaderFindingDto implements AppLicenseHeaderFinding {
    @ApiProperty()
    path!: string;

    @ApiPropertyOptional()
    spdx?: string;
}

/** `licenseEvidence` (plan §3.1:437). */
export class AppLicenseEvidenceDto implements AppLicenseEvidence {
    @ApiProperty({ type: [String] })
    files!: readonly string[];

    @ApiProperty({ type: [String] })
    mixedPaths!: readonly string[];

    @ApiPropertyOptional({ type: () => [AppLicenseHeaderFindingDto] })
    headerFindings?: readonly AppLicenseHeaderFindingDto[];
}

/** The single attestation record (C3, R-3). */
export class LicenseAttestationDto implements LicenseAttestation {
    @ApiProperty()
    userId!: string;

    @ApiProperty()
    attestedAt!: string;

    @ApiProperty()
    spdx!: string;

    @ApiProperty({ enum: LICENSE_CLASSES })
    class!: LicenseClass;

    @ApiProperty()
    textId!: string;

    @ApiProperty()
    textSha256!: string;

    @ApiProperty()
    commitSha!: string;
}

/**
 * The whole answer of `GET /api/works/:id/app-spec` (plan §4.1:547) — the state
 * minus the five internal sequence columns, plus `evaluationPending` and the
 * `links` block.
 */
export class WorkAppSpecStateResponseDto implements WorkAppSpecStateDto {
    @ApiProperty()
    id!: string;

    @ApiProperty()
    workId!: string;

    @ApiProperty({ nullable: true })
    tenantId!: string | null;

    @ApiProperty({ nullable: true })
    organizationId!: string | null;

    @ApiProperty({ description: 'The branch whose head is evaluated (FR-16).' })
    trackedBranch!: string;

    @ApiProperty({ nullable: true, description: 'When the last evaluation was dispatched.' })
    dispatchedAt!: string | null;

    @ApiProperty({ nullable: true })
    headCommitSha!: string | null;

    @ApiProperty({ nullable: true })
    headSpecHash!: string | null;

    @ApiProperty({ enum: APP_SPEC_VALIDATION_STATUSES })
    validationStatus!: AppSpecValidationStatus;

    @ApiProperty({
        type: () => [AppSpecIssueDto],
        nullable: true,
        description: '`null` until an evaluation has read a head.',
    })
    issues!: readonly AppSpecIssueDto[] | null;

    @ApiProperty()
    errorCount!: number;

    @ApiProperty()
    warningCount!: number;

    @ApiProperty({ description: '`true` when the 200-issue cap was reached.' })
    issuesTruncated!: boolean;

    @ApiProperty({
        nullable: true,
        description: 'The commit of the last zero-error evaluation (FR-20).',
    })
    effectiveCommitSha!: string | null;

    @ApiProperty({ nullable: true })
    effectiveSpecHash!: string | null;

    @ApiProperty({
        type: Object,
        nullable: true,
        description:
            'A **cache** of the spec at `effectiveCommitSha`; the file at that commit is authoritative. ' +
            'The shape is the App spec of `GET /api/schema/app-spec.schema.json`.',
    })
    effectiveSpec!: AppSpec | null;

    @ApiProperty({ nullable: true })
    effectiveAt!: string | null;

    @ApiProperty({ nullable: true })
    lastEvaluatedAt!: string | null;

    @ApiProperty({ enum: APP_SPEC_EVALUATION_TRIGGERS, nullable: true })
    lastEvaluationTrigger!: AppSpecEvaluationTrigger | null;

    @ApiProperty({
        nullable: true,
        description: 'The provider error code for `unreadable` (plan §9.2).',
    })
    lastEvaluationError!: string | null;

    @ApiProperty({ nullable: true })
    blueprintId!: string | null;

    @ApiProperty({ nullable: true })
    blueprintVersion!: string | null;

    @ApiProperty({ nullable: true })
    blueprintRepo!: string | null;

    @ApiProperty({ nullable: true })
    blueprintSha!: string | null;

    @ApiProperty({ enum: BLUEPRINT_MATCH_SOURCES, nullable: true })
    blueprintMatchSource!: WorkAppSpecStateDto['blueprintMatchSource'];

    @ApiProperty({ enum: APP_BLUEPRINT_APPLY_STATUSES, nullable: true })
    blueprintApplyStatus!: AppBlueprintApplyStatus | null;

    @ApiProperty({
        nullable: true,
        description: 'When `app.blueprint.matched` was recorded (FR-82).',
    })
    blueprintMatchedAt!: string | null;

    @ApiProperty({ nullable: true })
    blueprintApplyError!: string | null;

    @ApiProperty({ type: () => AppBlueprintApplyRefDto, nullable: true })
    blueprintApplyRef!: AppBlueprintApplyRefDto | null;

    @ApiProperty({ nullable: true })
    blueprintLatestVersion!: string | null;

    @ApiProperty({ nullable: true })
    blueprintUpgradeDismissedVersion!: string | null;

    @ApiProperty({ type: () => AppBlueprintUpgradePrDto, nullable: true })
    blueprintUpgradePr!: AppBlueprintUpgradePrDto | null;

    @ApiProperty({ nullable: true })
    licenseSpdx!: string | null;

    @ApiProperty({ enum: LICENSE_CLASSES, nullable: true })
    licenseClass!: LicenseClass | null;

    @ApiProperty({ enum: LICENSE_SOURCES, nullable: true })
    licenseSource!: LicenseSource | null;

    @ApiProperty()
    licenseMixed!: boolean;

    @ApiProperty()
    licenseScanIncomplete!: boolean;

    @ApiProperty({ type: () => AppLicenseEvidenceDto, nullable: true })
    licenseEvidence!: AppLicenseEvidenceDto | null;

    @ApiProperty({ type: [String], nullable: true })
    licenseObligations!: readonly string[] | null;

    @ApiProperty({ nullable: true })
    licenseCommitSha!: string | null;

    @ApiProperty({ nullable: true, description: 'Drives the re-classification fan-out.' })
    licenseRegistryHash!: string | null;

    @ApiProperty({ enum: LICENSE_REGISTRY_SOURCES, nullable: true })
    licenseRegistrySource!: LicenseRegistrySource | null;

    @ApiProperty({ nullable: true })
    licenseEvaluatedAt!: string | null;

    @ApiProperty({ type: () => LicenseAttestationDto, nullable: true })
    attestation!: LicenseAttestationDto | null;

    @ApiProperty({ description: 'A display cache; eligibility recomputes it on every call.' })
    sourceOfferRequired!: boolean;

    @ApiProperty({ nullable: true })
    displayName!: string | null;

    @ApiProperty({ nullable: true })
    trademarkNotice!: string | null;

    @ApiProperty({ type: [String], nullable: true })
    protectedPaths!: readonly string[] | null;

    @ApiProperty()
    createdAt!: string;

    @ApiProperty()
    updatedAt!: string;

    @ApiProperty({
        description:
            '`evaluatedSeq < requestedSeq` — an evaluation is queued or running, so the page keeps ' +
            'polling (plan §2.3:409, FR-18).',
    })
    evaluationPending!: boolean;

    @ApiProperty({ type: () => WorkAppSpecLinksDto })
    links!: WorkAppSpecLinksDto;
}

/** `POST …/app-spec/validate { source: 'branch' }` — the `202` body (plan §4.1:548). */
export class AppSpecEvaluationPendingDto {
    @ApiProperty({
        example: true,
        description:
            'Always `true`: the request was recorded (even when it coalesced into the job already on ' +
            'its way) and the answer does not wait for the evaluation (ACC-03-13, ACC-03-14).',
    })
    evaluationPending!: true;
}

/**
 * `POST …/app-spec/validate { source: 'content' }` — the `200` body: the
 * validator's own verdict on the text, entirely in memory (ACC-03-08).
 */
export class AppSpecDraftValidationDto implements AppSpecDraftValidation {
    @ApiProperty()
    workId!: string;

    @ApiProperty({ enum: APP_SPEC_VALIDATION_STATUSES })
    status!: AppSpecValidationStatus;

    @ApiProperty({ type: () => [AppSpecIssueDto] })
    issues!: readonly AppSpecIssueDto[];

    @ApiProperty()
    errorCount!: number;

    @ApiProperty()
    warningCount!: number;

    @ApiProperty()
    truncated!: boolean;

    @ApiProperty({
        description: '`false` for the four inputs that suppress the rule set (schema.md:508).',
    })
    rulesRan!: boolean;

    @ApiProperty({ type: [String] })
    suppressedRules!: readonly string[];
}

/** §4.2's error body, as every route of this epic answers it. */
export class AppSpecErrorDto {
    @ApiProperty({ enum: ['error'] })
    status!: 'error';

    @ApiProperty({
        enum: ['not_found', 'notAnAppWork', 'file_too_large'],
        description:
            '`not_found` — the Work does not exist, is not visible to the caller, or belongs to another ' +
            'account (404, ACC-03-41). `notAnAppWork` — the Work is not kind `app` (422). ' +
            '`file_too_large` — `content` is larger than 256 KiB (413).',
    })
    code!: 'not_found' | 'notAnAppWork' | 'file_too_large';

    @ApiProperty()
    message!: string;
}

/* -------------------------------------------------------------------------- *
 * The projection
 * -------------------------------------------------------------------------- */

/** What {@link toWorkAppSpecStateResponse} needs beyond the row itself. */
export interface WorkAppSpecStateProjection {
    /** `evaluatedSeq < requestedSeq` (FR-18) — the service's own answer. */
    readonly evaluationPending: boolean;
    /** The file link and the provider's anchor hint (plan §4.3:578-580). */
    readonly links: WorkAppSpecLinks;
}

/**
 * The state row → the DTO, as a pure function.
 *
 * Pure and exported so the route has no second copy of the field mapping and so
 * the projection can be asserted directly: every field is carried, the five
 * sequence columns are not, and every instant becomes the ISO string the
 * contract declares (`WorkAppSpecStateDto`'s fields are `string | null`, the
 * entity's are `Date | null`).
 */
export function toWorkAppSpecStateResponse(
    state: WorkAppSpecState,
    input: WorkAppSpecStateProjection,
): WorkAppSpecStateResponseDto {
    return {
        id: state.id,
        workId: state.workId,
        tenantId: state.tenantId ?? null,
        organizationId: state.organizationId ?? null,
        trackedBranch: state.trackedBranch,
        dispatchedAt: iso(state.dispatchedAt),
        headCommitSha: state.headCommitSha ?? null,
        headSpecHash: state.headSpecHash ?? null,
        validationStatus: state.validationStatus,
        issues: state.issues ?? null,
        errorCount: state.errorCount ?? 0,
        warningCount: state.warningCount ?? 0,
        issuesTruncated: state.issuesTruncated ?? false,
        effectiveCommitSha: state.effectiveCommitSha ?? null,
        effectiveSpecHash: state.effectiveSpecHash ?? null,
        effectiveSpec: state.effectiveSpec ?? null,
        effectiveAt: iso(state.effectiveAt),
        lastEvaluatedAt: iso(state.lastEvaluatedAt),
        lastEvaluationTrigger: state.lastEvaluationTrigger ?? null,
        lastEvaluationError: state.lastEvaluationError ?? null,
        blueprintId: state.blueprintId ?? null,
        blueprintVersion: state.blueprintVersion ?? null,
        blueprintRepo: state.blueprintRepo ?? null,
        blueprintSha: state.blueprintSha ?? null,
        blueprintMatchSource: state.blueprintMatchSource ?? null,
        blueprintApplyStatus: state.blueprintApplyStatus ?? null,
        blueprintMatchedAt: iso(state.blueprintMatchedAt),
        blueprintApplyError: state.blueprintApplyError ?? null,
        blueprintApplyRef: state.blueprintApplyRef ?? null,
        blueprintLatestVersion: state.blueprintLatestVersion ?? null,
        blueprintUpgradeDismissedVersion: state.blueprintUpgradeDismissedVersion ?? null,
        blueprintUpgradePr: state.blueprintUpgradePr ?? null,
        licenseSpdx: state.licenseSpdx ?? null,
        licenseClass: state.licenseClass ?? null,
        licenseSource: state.licenseSource ?? null,
        licenseMixed: state.licenseMixed ?? false,
        licenseScanIncomplete: state.licenseScanIncomplete ?? false,
        licenseEvidence: state.licenseEvidence ?? null,
        licenseObligations: state.licenseObligations ?? null,
        licenseCommitSha: state.licenseCommitSha ?? null,
        licenseRegistryHash: state.licenseRegistryHash ?? null,
        licenseRegistrySource: state.licenseRegistrySource ?? null,
        licenseEvaluatedAt: iso(state.licenseEvaluatedAt),
        attestation: state.attestation ?? null,
        sourceOfferRequired: state.sourceOfferRequired ?? false,
        displayName: state.displayName ?? null,
        trademarkNotice: state.trademarkNotice ?? null,
        protectedPaths: state.protectedPaths ?? null,
        createdAt: iso(state.createdAt) as string,
        updatedAt: iso(state.updatedAt) as string,
        evaluationPending: input.evaluationPending,
        links: input.links,
    };
}

/** One `Date | null` column as the ISO string the DTO declares. */
function iso(value: Date | string | null | undefined): string | null {
    if (!value) {
        return null;
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
