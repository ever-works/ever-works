import {
    Body,
    Controller,
    Get,
    Header,
    HttpException,
    HttpStatus,
    Put,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type, Transform } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';
import {
    APP_LAUNCHER_FILTER_MAX_LENGTH,
    APP_LAUNCHER_MAX_CHANGES_PER_SAVE,
    APP_LAUNCHER_MAX_ITEMS_RESPONSE,
    APP_LAUNCHER_PIN_LIMIT,
    isAppLauncherEnvironment,
    type AppLauncherListResponse,
    type AppLauncherPinLimitErrorBody,
    type AppLauncherPlatformsResponse,
    type AppLauncherPreferenceChange,
    type AppLauncherSavePreferencesResponse,
} from '@ever-works/contracts';
import {
    AppLauncherPinLimitError,
    AppLauncherService,
    isAppLauncherPinLimitError,
    type AppLauncherPlatformInput,
} from '@ever-works/agent/app-launcher';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { config } from '../config/constants';
import { ScopeContextService } from '../scope/scope-context.service';
import { AppLauncherEnabledGuard } from './guards/app-launcher-enabled.guard';
import {
    DEFAULT_CATALOG_SELF_ID,
    PlatformCatalogService,
    type PlatformCatalogRead,
} from './platform-catalog.service';

/**
 * APW-11 (App Launcher) — the three routes of plan §4.
 *
 * Spec: `docs/specs/features/app-works/APW-11-app-launcher/spec.md` — FR-33,
 * FR-34, FR-35, FR-36, FR-37, FR-53, FR-54, FR-62, FR-65; plan §4.1 (the read),
 * §4.2 (the save), §4.3 (the public platform list) and §4.5 (the error
 * contract) are the normative sections this file implements.
 *
 *   | Route                             | Auth    | Throttle | Success | Off |
 *   | --------------------------------- | ------- | -------- | ------- | --- |
 *   | `GET  /api/me/apps`               | session | 60/min   | 200     | 404 |
 *   | `PUT  /api/me/apps/preferences`   | session | 30/min   | 200/422 | 404 |
 *   | `GET  /api/app-launcher/platforms`| public  | 120/min  | 200     | 404 |
 *
 * ## What these controllers own, and what they deliberately do not
 *
 * They resolve the request (session, scope, query/body) and hand the registry
 * the catalog packet it cannot read for itself (ADR-014: the catalog is data
 * read at runtime by `PlatformCatalogService`, plan §5.2). Everything about
 * *what a person has* — eligibility, addresses, ordering, the merged pinned
 * view, the pin limit — belongs to T6's `AppLauncherService`
 * (`packages/agent/src/app-launcher/app-launcher.service.ts`), which this file
 * calls and never second-guesses.
 *
 * ## Two controller classes in one file
 *
 * `AppLauncherController` is the session surface (`@Controller('api/me/apps')`,
 * plan §4.1/§4.2); `AppLauncherPlatformsController` is FR-37's public list
 * (`@Controller('api/app-launcher/platforms')`, plan §4.3). They are separate
 * classes because their trust boundaries differ — one is session-scoped, the
 * other is `@Public()` and anonymous — and they sit in one file because T9's
 * ownership boundary draws them together. Splitting them into
 * `app-launcher-platforms.controller.ts` later is a move, not a rewrite.
 *
 * ## Every route is behind the installation switch
 *
 * `@UseGuards(AppLauncherEnabledGuard)` on both classes: with
 * `EVER_WORKS_APP_LAUNCHER_ENABLED` unset (or anything but `'true'`) each
 * answers the same opaque **404** as a route that was never mounted — before
 * any handler runs, so a switched-off installation performs no read and no
 * write at all (FR-54, FR-65, ACC-11-28, ACC-11-50).
 */

// ---------------------------------------------------------------------------
// Bounds and constants — each one is the spec's or the plan's
// ---------------------------------------------------------------------------

/** FR-36 / plan §4.1: the registry's read budget, per person per minute. */
export const APP_LAUNCHER_READS_PER_MINUTE = 60;

/** FR-36 / plan §4.2: the write budget, per person per minute. */
export const APP_LAUNCHER_WRITES_PER_MINUTE = 30;

/** Plan §4.3: the public catalog read's budget — it is anonymous, so it is the widest. */
export const APP_LAUNCHER_PLATFORM_READS_PER_MINUTE = 120;

/**
 * Plan §4.2:405 and §3.2 — a tile's position inside its section is `0..9999`.
 * Declared here because `isLauncherSortOrder` (the service's own guard for the
 * same bound) is module-private; the two numbers are the same number, and this
 * one is only the DTO's `400` boundary.
 */
export const APP_LAUNCHER_SORT_ORDER_MAX = 9999;

/**
 * Plan §4.2:405 — the key shapes a save may name: `platform:<catalogId>`
 * (lower-case id, 2..40 chars) or `work:<uuid>`. Anything else is a `400`
 * (plan §4.5), so a malformed key never reaches the service's eligibility check
 * — which answers `unknownItem` for a key it does not know, and must not have to
 * parse one.
 */
export const APP_LAUNCHER_ITEM_KEY_PATTERN = /^(platform:[a-z0-9-]{2,40}|work:[0-9a-f-]{36})$/;

/**
 * Plan §4.3: FR-37's one-hour cacheability, with a ten-minute stale window so a
 * browser can render an expired copy while it revalidates. Exported so
 * ACC-11-27 asserts the header the route actually sends rather than a string
 * retyped in a spec.
 */
export const APP_LAUNCHER_PLATFORMS_CACHE_CONTROL =
    'public, max-age=3600, stale-while-revalidate=600';

/**
 * Plan §4.3: the public list is anonymous catalog data, so it is readable from
 * any origin — and it carries **no** credentials, which is why
 * `Access-Control-Allow-Credentials` is never set: a wildcard origin with
 * credentials is both invalid and exactly the shape a confused-deputy attack
 * wants.
 */
export const APP_LAUNCHER_PUBLIC_ORIGIN = '*';

// ---------------------------------------------------------------------------
// Request shapes (plan §4.1's query table, §4.2's body)
// ---------------------------------------------------------------------------

/**
 * `GET /api/me/apps` — the paging and filtering inputs of plan §4.1:356-364 and
 * FR-63.
 *
 * `includeHidden` is the string `'true' | 'false'` the plan's table names, and
 * anything else is a `400` rather than a coerced truthy: **Manage apps**
 * (`includeHidden=true`) is the only caller that must be exactly right, and a
 * typo silently falling back to the panel's shorter list would look like data
 * loss. `limit` is `1..200` with the service's own default (200) when absent
 * (FR-34, FR-63).
 *
 * `q` is FR-63's filter, and it is the one input plan §4.1's table does not
 * list — added because the table's own claim ("`limit`/`order` are the only
 * paging inputs — no eligible item needs a second endpoint to be reached") only
 * holds if a person with more than 200 eligible items can name the one they
 * want, and a client-side filter can only narrow the rows the response already
 * carried (spec.md:303-305). It is trimmed here, so `?q=%20cal%20` and `?q=cal`
 * are one request, and capped at {@link APP_LAUNCHER_FILTER_MAX_LENGTH}: a
 * filter longer than an item's name (FR-57) could never match, so it is a `400`
 * rather than a read of the whole eligible set that returns nothing.
 *
 * The name `q` is deliberate: it is the conventional free-text needle, and it
 * keeps the route's declared surface distinct from `includeHidden`/`limit`,
 * which select *what* is returned rather than *which* rows match. Because the
 * platform's pipe runs with `forbidNonWhitelisted`, a parameter this class does
 * not declare is still a `400` — `?filter=cal` included.
 */
export class ListAppLauncherQueryDto {
    @IsOptional()
    @IsIn(['true', 'false'])
    includeHidden?: 'true' | 'false';

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(APP_LAUNCHER_MAX_ITEMS_RESPONSE)
    limit?: number;

    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(APP_LAUNCHER_FILTER_MAX_LENGTH)
    q?: string;
}

/**
 * One change inside a save (plan §4.2:403-406, §3.3).
 *
 * A merge patch: an absent field keeps its stored value (FR-29). There is
 * deliberately no `pinOrder` — pinning appends after the merged view's last pin
 * and the ranking is recomputed inside the save's transaction, so a client can
 * never send a rank the server has to trust (FR-62, plan §4.2:429-432).
 */
export class AppLauncherPreferenceChangeDto implements AppLauncherPreferenceChange {
    @IsString()
    @Matches(APP_LAUNCHER_ITEM_KEY_PATTERN)
    key: string;

    @IsOptional()
    @IsBoolean()
    visible?: boolean;

    @IsOptional()
    @IsBoolean()
    pinned?: boolean;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(APP_LAUNCHER_SORT_ORDER_MAX)
    order?: number;
}

/**
 * `PUT /api/me/apps/preferences` — `1..200` changes in one save (FR-28, plan
 * §4.2:400-406). `@ArrayMinSize(1)` is deliberate: an empty save is a client
 * bug, and answering `200 { saved: 0 }` for it would hide the bug behind a
 * success the person reads as **Saved**.
 */
export class SaveAppLauncherPreferencesDto {
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(APP_LAUNCHER_MAX_CHANGES_PER_SAVE)
    @ValidateNested({ each: true })
    @Type(() => AppLauncherPreferenceChangeDto)
    changes: AppLauncherPreferenceChangeDto[];
}

// ---------------------------------------------------------------------------
// `GET /api/me/apps`, `PUT /api/me/apps/preferences` (session)
// ---------------------------------------------------------------------------

@ApiTags('App Launcher')
@ApiBearerAuth('JWT-auth')
@Controller('api/me/apps')
@UseGuards(AppLauncherEnabledGuard)
export class AppLauncherController {
    constructor(
        private readonly launcher: AppLauncherService,
        private readonly catalog: PlatformCatalogService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    /**
     * FR-33's registry read — the merged, ordered list plus the facts a client
     * must not re-derive (plan §4.1).
     *
     * The person is the **session** (`@CurrentUser()`), never a parameter, and
     * the scope is the active request scope: one person's arrangement is never
     * readable by another, and a request can never name somebody else's scope
     * (FR-53). The catalog is read once per request and handed in; the service
     * echoes its version and availability in `meta` (S9/S10).
     *
     * `q` is handed to the registry as `filter`, which narrows the eligible set
     * **before** the response cap — so `?includeHidden=true&limit=200&q=<name>`
     * reaches the 240th of 250 eligible items, which neither the cap nor any
     * client-side filter can (FR-63).
     */
    @Get()
    @Throttle({ long: { limit: APP_LAUNCHER_READS_PER_MINUTE, ttl: 60_000 } })
    @ApiOperation({
        summary: 'List the App Launcher items for the signed-in person',
        description:
            'The merged, ordered list of pinned items, Ever apps and the person’s own Works, with each tile’s address, chip, visibility and Manage-apps state resolved server-side. `includeHidden=true` is the Manage apps view: it also returns hidden and not-live items, up to `limit` (1..200); `q` filters them by name, case- and accent-insensitively, before that cap, and `meta.total` reports the eligible count the filter never changes.',
    })
    @ApiResponse({ status: 200, description: 'The ordered list plus its `meta` facts.' })
    @ApiResponse({
        status: 400,
        description: '`limit` outside 1..200, `q` longer than its cap, or an unknown query shape.',
    })
    @ApiResponse({ status: 401, description: 'No session.' })
    @ApiResponse({ status: 404, description: 'The App Launcher is switched off.' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListAppLauncherQueryDto,
    ): Promise<AppLauncherListResponse> {
        const catalog = await this.catalog.read();
        return this.launcher.listForUser(
            { id: auth.userId },
            this.scopeContext.getScope(),
            this.platformInputs(catalog),
            {
                includeHidden: query.includeHidden === 'true',
                limit: query.limit,
                filter: query.q,
                environment: catalog.environment,
                catalogVersion: catalog.catalogVersion,
                catalogAvailable: catalog.catalogAvailable,
            },
        );
    }

    /**
     * FR-35's save — merge-patch per item, the whole save refused on the pin
     * limit, then the refreshed **Manage apps** list (plan §4.2).
     *
     * §4.5's error map is applied here and only here: a malformed body is Nest's
     * `400` from the DTO above, an unknown or unreachable key is a `200` with a
     * per-item `unknownItem` rejection (the service's answer), and the pin-limit
     * refusal — which invalidates the *resulting arrangement*, not one tile — is
     * the `422 { code: 'pinLimit', limit: 6 }` of FR-25/FR-62. The body comes
     * from {@link AppLauncherPinLimitError} itself, so the code and the number
     * have exactly one source.
     */
    @Put('preferences')
    @Throttle({ long: { limit: APP_LAUNCHER_WRITES_PER_MINUTE, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Save the signed-in person’s App Launcher arrangement',
        description:
            'A merge patch per item: show/hide, pin/unpin and the explicit order of a section being reordered. Pinning past six items refuses the whole save with 422 and writes nothing; an unknown or inaccessible key is answered per item with `unknownItem`.',
    })
    @ApiResponse({ status: 200, description: '`{ saved, rejected, items }` — the refreshed list.' })
    @ApiResponse({
        status: 400,
        description: 'Bad key shape, order out of range, or 1..200 violated.',
    })
    @ApiResponse({ status: 401, description: 'No session.' })
    @ApiResponse({ status: 404, description: 'The App Launcher is switched off.' })
    @ApiResponse({
        status: 422,
        description: 'The pin limit would be exceeded: `{ code: "pinLimit", limit: 6 }`.',
    })
    async savePreferences(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: SaveAppLauncherPreferencesDto,
    ): Promise<AppLauncherSavePreferencesResponse> {
        const catalog = await this.catalog.read();
        try {
            return await this.launcher.savePreferences(
                auth.userId,
                this.scopeContext.getScope(),
                body.changes,
                this.platformInputs(catalog),
            );
        } catch (error) {
            if (isAppLauncherPinLimitError(error)) {
                throw new HttpException(pinLimitBody(error), HttpStatus.UNPROCESSABLE_ENTITY);
            }
            throw error;
        }
    }

    /**
     * The packet the registry is handed (plan §4.1 step 1).
     *
     * When the catalog handed back nothing at all — the outage path, where
     * `catalogAvailable` is `false` and there is no last-good copy, **or** a
     * catalog that carries no address for this environment — the current
     * platform is synthesised so FR-13's **You're here** tile is always
     * renderable. It uses the same key the catalog entry uses
     * (`platform:<EVER_WORKS_PLATFORM_CATALOG_SELF_ID>`), which is what makes a
     * pin survive an outage, and the name the platform already shows for itself
     * (`config.branding.appName()`, the reader `api.controller.ts:95` uses). No
     * catalog content is compiled into this file (FR-8, ADR-014): the tile
     * carries a name and no address.
     *
     * `catalogAvailable` is **not** touched here — `meta` still reports exactly
     * what the read said, so the panel can render S9/S10 correctly whether the
     * list came from the catalog or from this one synthesised tile.
     */
    private platformInputs(catalog: PlatformCatalogRead): AppLauncherPlatformInput[] {
        if (catalog.platforms.length > 0) {
            return [...catalog.platforms];
        }
        return [this.currentPlatform()];
    }

    /** The synthesised **You're here** tile of plan §4.1 step 1. */
    private currentPlatform(): AppLauncherPlatformInput {
        const selfId =
            (process.env.EVER_WORKS_PLATFORM_CATALOG_SELF_ID ?? '').trim() ||
            DEFAULT_CATALOG_SELF_ID;
        return {
            key: `platform:${selfId}`,
            name: config.branding.appName(),
            url: null,
            host: null,
            current: true,
        };
    }
}

// ---------------------------------------------------------------------------
// `GET /api/app-launcher/platforms` (public)
// ---------------------------------------------------------------------------

/**
 * FR-37's public list: the Ever apps catalog, readable signed out, for P2 hosts
 * and for a visitor who has not signed in (plan §4.3).
 *
 * `@Public()` because there is nothing personal in the answer — the catalog is
 * public data read at runtime (FR-8) — and the installation switch still
 * applies: a switched-off launcher answers `404` here too, so the surface is
 * invisible as a whole rather than half-visible (FR-54, FR-65).
 */
@ApiTags('App Launcher')
@Controller('api/app-launcher/platforms')
@Public()
@UseGuards(AppLauncherEnabledGuard)
export class AppLauncherPlatformsController {
    constructor(private readonly catalog: PlatformCatalogService) {}

    /**
     * The catalog for one environment (plan §4.3, FR-10).
     *
     * `?environment=` selects the addresses' environment and is validated by the
     * contract's own predicate — an unrecognised value is **ignored** rather
     * than answered with `400`, and the catalog service then applies
     * `EVER_WORKS_PLATFORM_CATALOG_ENV` / `production`. Failing closed this way
     * keeps FR-10's guarantee (nothing ever sends a person to another
     * environment's address) without turning a stale bookmark into an error
     * page.
     *
     * The response is exactly plan §4.3's shape — `catalogVersion`,
     * `environment` and the platform tiles, whose preference fields are their
     * defaults, because this route carries no preference state at all. It is
     * cacheable for an hour (FR-37) and carries `Access-Control-Allow-Origin: *`
     * with no credentials.
     */
    @Get()
    @Throttle({ long: { limit: APP_LAUNCHER_PLATFORM_READS_PER_MINUTE, ttl: 60_000 } })
    @Header('Cache-Control', APP_LAUNCHER_PLATFORMS_CACHE_CONTROL)
    @Header('Access-Control-Allow-Origin', APP_LAUNCHER_PUBLIC_ORIGIN)
    @ApiOperation({
        summary: 'List the Ever apps platforms (public)',
        description:
            'The runtime platform catalog for one environment — public data, cacheable for an hour, no credentials.',
    })
    @ApiResponse({ status: 200, description: '`{ catalogVersion, environment, platforms }`.' })
    @ApiResponse({ status: 404, description: 'The App Launcher is switched off.' })
    async list(@Query('environment') environment?: string): Promise<AppLauncherPlatformsResponse> {
        const catalog = await this.catalog.read(
            isAppLauncherEnvironment(environment) ? environment : undefined,
        );
        return {
            catalogVersion: catalog.catalogVersion,
            environment: catalog.environment,
            platforms: catalog.platforms,
        };
    }
}

// ---------------------------------------------------------------------------
// §4.5's 422 body
// ---------------------------------------------------------------------------

/**
 * The `422` payload of plan §4.5:506 — `{ code: 'pinLimit', limit: 6 }`.
 *
 * Taken from the error when it is T6's {@link AppLauncherPinLimitError}, so the
 * code and the number keep their single source; the fallback covers the
 * look-alike object `isAppLauncherPinLimitError` also admits (a bundled
 * boundary can hand over a plain `{ code: 'pinLimit' }`, which is exactly why
 * that predicate exists). Either way the body is the contract's
 * {@link AppLauncherPinLimitErrorBody} and never a message.
 */
function pinLimitBody(error: AppLauncherPinLimitError): AppLauncherPinLimitErrorBody {
    if (error instanceof AppLauncherPinLimitError && error.body) {
        return error.body;
    }
    return { code: 'pinLimit', limit: APP_LAUNCHER_PIN_LIMIT };
}
