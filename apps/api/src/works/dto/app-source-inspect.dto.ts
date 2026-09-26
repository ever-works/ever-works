import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import {
    APP_REPOSITORY_MODES,
    APP_SOURCE_BLUEPRINT_MATCH_SOURCES,
    APP_SOURCE_BLUEPRINT_STATUSES,
    APP_SOURCE_LICENSE_CLASSES,
    APP_SOURCE_LICENSE_SOURCES,
    APP_SOURCE_REASON_CODES,
    type AppBlueprintPreview,
    type AppBlueprintPrompt,
    type AppDeployTargetAvailability,
    type AppModeAvailability,
    type AppRepositoryMode,
    type AppSourceInspectRequest,
    type AppSourceInspectResponse,
    type AppSourceLicensePreview,
    type AppSourceReasonCode,
    type AppTargetOwner,
} from '@ever-works/contracts';

/**
 * APW-01 T17 — the two OpenAPI shapes of `POST /api/works/app-source/inspect`
 * (plan §4.1, `plan.md:465-490`).
 *
 * ## The request DTO validates, the controller decides nothing
 *
 * `repositoryUrl` is bounded at 400 characters and trimmed here, because that is
 * the limit the parser itself applies (`parseRepositoryWorkSource` refuses a
 * longer string) — a body that could never parse is refused by the pipe with a
 * field name instead of by the service with a reason code.
 *
 * `gitProvider` is deliberately **not** validated against a literal list. The
 * only rule that decides whether a provider id is meaningful is the URL parser's
 * host table (`repository-work-source.ts`'s `HOST_RULES`), and a second list here
 * would be a second answer to that question: it would refuse a provider the day
 * the parser learns a new host, or accept one for a host it never matches. The
 * service compares this value with the parsed host and answers
 * `400 invalid_url` when they disagree (plan §4.1's error table).
 *
 * ## The response DTO is a mirror, and `implements` is what keeps it one
 *
 * Every class below `implements` the contract type it documents, so a field added
 * to `@ever-works/contracts`'s `AppSourceInspectResponse` fails `type-check` here
 * until the Swagger document describes it too. The classes are **never
 * instantiated** — the route answers the service's own `AppSourceInspectResponse`
 * — so the `!` declarations are the shape, not a value.
 *
 * `deployTargets` is spelled out key by key rather than as a bare
 * `Record<...>`: Swagger cannot introspect an index signature, and the deploy
 * picker (APW-01 T22) reads this document to learn which targets exist.
 */

/* -------------------------------------------------------------------------- *
 * Request
 * -------------------------------------------------------------------------- */

export class AppSourceInspectRequestDto implements AppSourceInspectRequest {
    @ApiProperty({
        description:
            'The existing GitHub repository to inspect — an `https://github.com/<owner>/<repo>` your ' +
            'connected account can reach. Trimmed before parsing, at most 400 characters (the parser’s ' +
            'own limit). Only the host rules the parser knows are accepted.',
        example: 'https://github.com/ever-works/ever-works',
        maxLength: 400,
    })
    @IsString()
    @MaxLength(400)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    repositoryUrl!: string;

    @ApiPropertyOptional({
        description:
            'The git provider the client believes hosts the repository. Checked against the URL parser’s ' +
            'host rules, never against a list copied here: a value that disagrees with the parsed host ' +
            'answers `400 invalid_url`.',
        example: 'github',
    })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    gitProvider?: string;

    @ApiPropertyOptional({
        description:
            'An Apps catalog id the member picked. The resolver previews exactly that entry, and a create ' +
            'that names a Blueprint the catalog does not return for this upstream is refused with ' +
            '`400 blueprint_mismatch` (APW-01 FR-29b, FR-56).',
        example: 'cal-diy',
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    // The catalog id shape, the same rule `CreateWorkDto.blueprintId` carries:
    // lowercase letters, digits and hyphens, starting alphanumeric.
    @Matches(/^[a-z0-9][a-z0-9-]{0,99}$/)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    blueprintId?: string;
}

/* -------------------------------------------------------------------------- *
 * Response — one class per nested shape of the contract
 * -------------------------------------------------------------------------- */

/**
 * Four names for the contract's own nested shapes, and nothing more: a class may
 * only `implements` an identifier (TS2500), so an inline indexed access cannot be
 * used directly. They are aliases — the interface remains the single definition, and
 * the `implements` clause below still fails `type-check` the moment a field is added
 * to it.
 */
type AppSourceRepositoryShape = AppSourceInspectResponse['repository'];
type AppSourceAccessShape = AppSourceInspectResponse['access'];
type AppSourceModesShape = AppSourceInspectResponse['modes'];
type AppSourceDeployTargetsShape = AppSourceInspectResponse['deployTargets'];

/** `AppSourceInspectResponse.repository` (plan §3.2, `plan.md:372-390`). */
export class AppSourceRepositoryDto implements AppSourceRepositoryShape {
    @ApiProperty({ example: 'ever-works' })
    owner!: string;

    @ApiProperty({ example: 'ever-works' })
    repo!: string;

    @ApiProperty({ example: 'ever-works/ever-works' })
    fullName!: string;

    @ApiProperty({ example: 'https://github.com/ever-works/ever-works' })
    url!: string;

    @ApiPropertyOptional()
    description?: string;

    @ApiProperty({ example: 'main' })
    defaultBranch!: string;

    @ApiProperty({ example: 42 })
    stars!: number;

    @ApiProperty({ example: 1_024 })
    sizeKb!: number;

    @ApiProperty({ enum: ['public', 'private', 'internal'] })
    visibility!: 'public' | 'private' | 'internal';

    @ApiProperty()
    archived!: boolean;

    @ApiProperty({ description: 'A repository with no commits: no mode can be offered for it.' })
    empty!: boolean;

    @ApiProperty()
    isFork!: boolean;

    @ApiPropertyOptional({ description: 'The immediate parent, when the repository is a fork.' })
    parent?: string;

    @ApiPropertyOptional({ description: "The fork network's root, when the provider reports one." })
    source?: string;

    @ApiProperty({ description: 'False refuses Fork with `forking_disabled` (FR-12).' })
    allowForking!: boolean;

    @ApiPropertyOptional({
        description: 'The old coordinates, when the repository moved (APW-02 FR-15).',
    })
    movedFrom?: string;

    @ApiProperty({ description: 'True refuses Private copy with `uses_lfs` (FR-12).' })
    usesLfs!: boolean;
}

/** `AppSourceInspectResponse.access` — what the caller’s own account may do. */
export class AppSourceAccessDto implements AppSourceAccessShape {
    @ApiProperty({ description: 'False refuses Link and offers Fork instead (FR-12).' })
    canPush!: boolean;

    @ApiProperty()
    canAdmin!: boolean;
}

/** One mode’s availability; `reason` is present exactly when it is not available. */
export class AppModeAvailabilityDto implements AppModeAvailability {
    @ApiProperty()
    available!: boolean;

    @ApiPropertyOptional({
        enum: APP_SOURCE_REASON_CODES,
        description:
            'Present exactly when `available` is false — the one code that explains it (FR-5).',
    })
    reason?: AppSourceReasonCode;
}

/** One deploy target’s availability, with the plugin id a create would persist. */
export class AppDeployTargetAvailabilityDto
    extends AppModeAvailabilityDto
    implements AppDeployTargetAvailability
{
    @ApiPropertyOptional({
        description:
            'The enabled apps-capable plugin id the create request persists. Present only for an ' +
            'available non-`none` target (FR-34).',
    })
    providerId?: string;
}

/** `AppSourceInspectResponse.modes`, spelled out so Swagger can document it. */
export class AppRepositoryModesDto implements AppSourceModesShape {
    @ApiProperty({ type: () => AppModeAvailabilityDto })
    link!: AppModeAvailabilityDto;

    @ApiProperty({ type: () => AppModeAvailabilityDto })
    fork!: AppModeAvailabilityDto;

    @ApiProperty({ type: () => AppModeAvailabilityDto })
    'private-copy'!: AppModeAvailabilityDto;
}

/** `AppSourceInspectResponse.deployTargets` (FR-33, R-12). */
export class AppDeployTargetsDto implements AppSourceDeployTargetsShape {
    @ApiProperty({
        type: () => AppDeployTargetAvailabilityDto,
        description: '**None — don’t deploy yet**: always available, and the default (R-12).',
    })
    none!: AppDeployTargetAvailabilityDto;

    @ApiProperty({ type: () => AppDeployTargetAvailabilityDto })
    'your-cluster'!: AppDeployTargetAvailabilityDto;

    @ApiProperty({ type: () => AppDeployTargetAvailabilityDto })
    'ever-works-apps'!: AppDeployTargetAvailabilityDto;
}

/** An existing fork in one of the caller’s accounts (FR-9, FR-19). */
export class AppTargetOwnerExistingForkDto implements NonNullable<AppTargetOwner['existingFork']> {
    @ApiProperty()
    owner!: string;

    @ApiProperty()
    repo!: string;

    @ApiProperty()
    fullName!: string;

    @ApiProperty()
    url!: string;

    @ApiProperty({ description: 'Another account already uses this fork in Ever Works (FR-26).' })
    inUseByAnotherAccount!: boolean;
}

/** One account the caller can fork into (plan §3.2, `plan.md:389-397`). */
export class AppTargetOwnerDto implements AppTargetOwner {
    @ApiProperty({ example: 'ever-works' })
    login!: string;

    @ApiProperty({ enum: ['user', 'organization'] })
    type!: 'user' | 'organization';

    @ApiProperty()
    available!: boolean;

    @ApiPropertyOptional({ enum: APP_SOURCE_REASON_CODES })
    reason?: AppSourceReasonCode;

    @ApiPropertyOptional({ type: () => AppTargetOwnerExistingForkDto })
    existingFork?: AppTargetOwnerExistingForkDto;

    @ApiProperty({
        description:
            'Required, never omitted: an owner the provider-call budget did not reach keeps its computed ' +
            'availability, carries no reason code and reports `false` here (FR-9, ACC-01-26).',
    })
    existingForkChecked!: boolean;
}

/** One prompted value a Blueprint asks for — never a value (FR-55). */
export class AppBlueprintPromptDto implements AppBlueprintPrompt {
    @ApiProperty()
    name!: string;

    @ApiPropertyOptional()
    description?: string;

    @ApiProperty()
    required!: boolean;
}

/** The Blueprint preview, and how it was matched (FR-29b, FR-56). */
export class AppBlueprintPreviewDto implements AppBlueprintPreview {
    @ApiProperty({
        enum: APP_SOURCE_BLUEPRINT_STATUSES,
        description:
            '`unavailable` means the catalog could not be consulted at all — never “no match” (T11’s ' +
            'unbound-port answer).',
    })
    status!: AppSourceInspectResponse['blueprint']['status'];

    @ApiPropertyOptional()
    id?: string;

    @ApiPropertyOptional()
    version?: string;

    @ApiPropertyOptional()
    verified?: boolean;

    @ApiPropertyOptional()
    name?: string;

    @ApiPropertyOptional({
        description:
            'The entry’s trademark notice, shown when present (APW-01 tasks.md, the Quick Start prompt).',
    })
    notice?: string;

    @ApiPropertyOptional({ enum: APP_SOURCE_BLUEPRINT_MATCH_SOURCES })
    matchSource?: AppSourceInspectResponse['blueprint']['matchSource'];

    @ApiPropertyOptional({ type: () => [AppBlueprintPromptDto] })
    prompts?: AppBlueprintPromptDto[];
}

/** The licence class inspect read (FR-8, Resolution R-3). */
export class AppSourceLicensePreviewDto implements AppSourceLicensePreview {
    @ApiProperty({ nullable: true, example: 'MIT' })
    spdx!: string | null;

    @ApiProperty({
        enum: APP_SOURCE_LICENSE_CLASSES,
        description: '`unknown` is a first-class answer, never a guessed class.',
    })
    class!: AppSourceLicensePreview['class'];

    @ApiProperty({
        enum: APP_SOURCE_LICENSE_SOURCES,
        description: '`user` cannot appear here: nothing is persisted before create.',
    })
    source!: AppSourceLicensePreview['source'];
}

/** The caller’s OWN existing App Work — never another account’s (FR-23). */
export class AppExistingAppWorkDto implements NonNullable<
    AppSourceInspectResponse['existingAppWork']
> {
    @ApiProperty()
    id!: string;

    @ApiProperty()
    name!: string;

    @ApiProperty()
    slug!: string;
}

/** The whole inspection (plan §4.1; the create form renders every field of it). */
export class AppSourceInspectResponseDto implements AppSourceInspectResponse {
    @ApiProperty({ type: () => AppSourceRepositoryDto })
    repository!: AppSourceRepositoryDto;

    @ApiProperty({ type: () => AppSourceAccessDto })
    access!: AppSourceAccessDto;

    @ApiProperty({ type: () => AppRepositoryModesDto })
    modes!: AppRepositoryModesDto;

    @ApiProperty({
        enum: APP_REPOSITORY_MODES,
        nullable: true,
        description: '`null` when neither Link nor Fork is available.',
    })
    defaultMode!: AppRepositoryMode | null;

    @ApiProperty({
        type: () => [AppTargetOwnerDto],
        description: 'The caller first, then the offered organizations A–Z.',
    })
    targetOwners!: AppTargetOwnerDto[];

    @ApiProperty({ type: () => AppBlueprintPreviewDto })
    blueprint!: AppBlueprintPreviewDto;

    @ApiProperty({ type: () => AppSourceLicensePreviewDto })
    license!: AppSourceLicensePreviewDto;

    @ApiProperty({ type: () => AppDeployTargetsDto })
    deployTargets!: AppDeployTargetsDto;

    @ApiPropertyOptional({ type: () => AppExistingAppWorkDto })
    existingAppWork?: AppExistingAppWorkDto;

    @ApiProperty({
        description:
            'True when the existing-fork scan did not reach every offered owner (FR-9, ACC-01-26). ' +
            'Required, so a client cannot silently render a partial scan as complete.',
    })
    scanIncomplete!: boolean;

    @ApiPropertyOptional({
        description: 'ISO timestamp, present when `rate_limited` refused something.',
    })
    retryAfter?: string;
}
