import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    APP_LAUNCHER_DESCRIPTION_MAX_LENGTH,
    APP_LAUNCHER_ENVIRONMENTS,
    APP_LAUNCHER_ITEM_KINDS,
    APP_LAUNCHER_MANAGE_STATES,
    APP_LAUNCHER_NAME_MAX_LENGTH,
    APP_LAUNCHER_ORIGIN_NOT_ALLOWED,
    APP_LAUNCHER_PIN_LIMIT,
    APP_LAUNCHER_PLATFORM_STATUSES,
    APP_LAUNCHER_REJECTION_REASONS,
    APP_LAUNCHER_SECTIONS,
    APP_LAUNCHER_WORK_CHIPS,
    EVER_ID_ERROR_CODE_WIRE_VALUES,
    type AppLauncherEnvironment,
    type AppLauncherItem,
    type AppLauncherItemKind,
    type AppLauncherListResponse,
    type AppLauncherManageState,
    type AppLauncherPinLimitErrorBody,
    type AppLauncherPlatformStatus,
    type AppLauncherPlatformsResponse,
    type AppLauncherRejection,
    type AppLauncherRejectionReason,
    type AppLauncherSavePreferencesResponse,
    type AppLauncherSection,
    type AppLauncherWorkChip,
} from '@ever-works/contracts';

/**
 * APW-11 (App Launcher) — the response shapes of the three launcher routes, as
 * the generated OpenAPI document describes them.
 *
 * The controllers return the contract types of `@ever-works/contracts`
 * (`packages/contracts/src/apps/app-launcher.ts`); these classes exist only so
 * `@nestjs/swagger` can describe those shapes, and each `implements` its contract
 * type so a field added to the contract fails this build until it is described
 * here too. Nothing is ever instantiated from them.
 *
 * They are what makes the published fragment
 * (`docs/specs/features/app-works/contracts/openapi/apw-11.openapi.yaml`) a subset
 * of the generated document: `apps/api/src/openapi/__tests__/app-works-contract.spec.ts`
 * fails when a property the fragment requires is not required here.
 */

/** One launcher tile (contract `AppLauncherItem`). */
export class AppLauncherItemDto implements AppLauncherItem {
    @ApiProperty({
        description: '`platform:<catalogId>` or `work:<uuid>`.',
        example: 'platform:ever-works',
    })
    key: string;

    @ApiProperty({ enum: [...APP_LAUNCHER_ITEM_KINDS] })
    kind: AppLauncherItemKind;

    @ApiProperty({
        enum: [...APP_LAUNCHER_SECTIONS],
        description: 'The section the tile renders under; `pinned` wins over the kind.',
    })
    section: AppLauncherSection;

    @ApiProperty({ maxLength: APP_LAUNCHER_NAME_MAX_LENGTH })
    name: string;

    @ApiPropertyOptional({
        maxLength: APP_LAUNCHER_DESCRIPTION_MAX_LENGTH,
        description: 'Ever apps only.',
    })
    description?: string;

    @ApiPropertyOptional({
        description: 'An inline `data:image/svg+xml;base64,…` or `data:image/png;base64,…` icon.',
    })
    iconDataUri?: string;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'An `https` address; `null` exactly when `manageState` is not `listed`.',
    })
    url: string | null;

    @ApiProperty({ type: String, nullable: true, description: 'The host of `url`.' })
    host: string | null;

    @ApiPropertyOptional({ description: 'The **You are here** tile; it is not a link.' })
    current?: boolean;

    @ApiPropertyOptional({
        enum: [...APP_LAUNCHER_PLATFORM_STATUSES],
        description: 'Ever apps only. A `soon` tile is shown and cannot be opened.',
    })
    status?: AppLauncherPlatformStatus;

    @ApiPropertyOptional({ description: "Works only: the Work's kind." })
    workKind?: string;

    @ApiPropertyOptional({ enum: [...APP_LAUNCHER_WORK_CHIPS], description: 'Works only.' })
    chip?: AppLauncherWorkChip;

    @ApiProperty()
    visible: boolean;

    @ApiProperty()
    pinned: boolean;

    @ApiProperty({
        type: 'integer',
        nullable: true,
        description: 'Position in the pinned section, or `null` when not pinned.',
    })
    pinOrder: number | null;

    @ApiProperty({ type: 'integer', description: 'Position inside its section.' })
    order: number;

    @ApiProperty({ enum: [...APP_LAUNCHER_MANAGE_STATES] })
    manageState: AppLauncherManageState;
}

/** `GET /api/me/apps` → `meta` (contract `AppLauncherListResponse['meta']`). */
export class AppLauncherListMetaDto implements Readonly<AppLauncherListResponse['meta']> {
    @ApiProperty({ enum: [...APP_LAUNCHER_ENVIRONMENTS] })
    environment: AppLauncherEnvironment;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'The catalog version read, or `null` when no catalog is available.',
    })
    catalogVersion: string | null;

    @ApiProperty({
        description: 'False when the catalog could not be read and only the current app is listed.',
    })
    catalogAvailable: boolean;

    @ApiProperty({ description: '`global`, `personal`, or the active Organization id.' })
    scopeKey: string;

    @ApiProperty({ type: 'integer', description: 'How many Works this scope holds.' })
    worksTotal: number;

    @ApiProperty({
        type: 'integer',
        description:
            'How many items are eligible in this scope, counted before `limit` and before the `q` filter.',
    })
    total: number;

    @ApiProperty({ description: 'True when the answer was cut at `limit`.' })
    truncated: boolean;

    @ApiProperty({ type: 'integer', enum: [APP_LAUNCHER_PIN_LIMIT], description: 'Always 6.' })
    pinLimit: typeof APP_LAUNCHER_PIN_LIMIT;

    @ApiProperty({ description: 'Whether App Works are available to this person.' })
    appWorksAvailable: boolean;
}

/** `GET /api/me/apps` (contract `AppLauncherListResponse`). */
export class AppLauncherListResponseDto implements AppLauncherListResponse {
    @ApiProperty({ type: [AppLauncherItemDto] })
    items: AppLauncherItemDto[];

    @ApiProperty({ type: AppLauncherListMetaDto })
    meta: AppLauncherListMetaDto;
}

/** One refused change of a save (contract `AppLauncherRejection`). */
export class AppLauncherRejectionDto implements AppLauncherRejection {
    @ApiProperty()
    key: string;

    @ApiProperty({
        enum: [...APP_LAUNCHER_REJECTION_REASONS],
        description:
            '`unknownItem` is identical for an item that does not exist and one that is not yours.',
    })
    reason: AppLauncherRejectionReason;
}

/** `PUT /api/me/apps/preferences` → 200 (contract `AppLauncherSavePreferencesResponse`). */
export class AppLauncherSavePreferencesResponseDto implements AppLauncherSavePreferencesResponse {
    @ApiProperty({ type: 'integer', description: 'How many changes were applied.' })
    saved: number;

    @ApiProperty({ type: [AppLauncherRejectionDto] })
    rejected: AppLauncherRejectionDto[];

    @ApiProperty({
        type: [AppLauncherItemDto],
        description: 'The refreshed `includeHidden=true` list.',
    })
    items: AppLauncherItemDto[];
}

/** `PUT /api/me/apps/preferences` → 422 (contract `AppLauncherPinLimitErrorBody`). */
export class AppLauncherPinLimitErrorDto implements AppLauncherPinLimitErrorBody {
    @ApiProperty({ enum: ['pinLimit'] })
    code: 'pinLimit';

    @ApiProperty({ type: 'integer', enum: [APP_LAUNCHER_PIN_LIMIT] })
    limit: typeof APP_LAUNCHER_PIN_LIMIT;
}

/** `GET /api/app-launcher/platforms` → 200 (contract `AppLauncherPlatformsResponse`). */
export class AppLauncherPlatformsResponseDto implements AppLauncherPlatformsResponse {
    @ApiProperty({ type: String, nullable: true })
    catalogVersion: string | null;

    @ApiProperty({ enum: [...APP_LAUNCHER_ENVIRONMENTS] })
    environment: AppLauncherEnvironment;

    @ApiProperty({ type: [AppLauncherItemDto] })
    platforms: AppLauncherItemDto[];
}

/** The wire codes `GET /api/me/apps` answers a refused delegated read with (403). */
export const APP_LAUNCHER_DELEGATED_REFUSAL_CODES = [
    EVER_ID_ERROR_CODE_WIRE_VALUES.insufficientScope,
    APP_LAUNCHER_ORIGIN_NOT_ALLOWED,
] as const;

/** `GET /api/me/apps` → 403: a delegated read refused (scope or origin). */
export class AppLauncherDelegatedRefusalDto {
    @ApiProperty({ enum: ['error'] })
    status: 'error';

    @ApiProperty({
        enum: [...APP_LAUNCHER_DELEGATED_REFUSAL_CODES],
        description:
            '`insufficient_scope`: the token does not carry `apps:read`. `origin_not_allowed`: the `Origin` header is absent or not on the allow-list.',
    })
    code: (typeof APP_LAUNCHER_DELEGATED_REFUSAL_CODES)[number];

    @ApiProperty()
    message: string;
}
