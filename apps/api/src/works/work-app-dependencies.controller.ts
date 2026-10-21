import {
    Body,
    Controller,
    Delete,
    Get,
    HttpException,
    HttpStatus,
    Optional,
    Param,
    ParseUUIDPipe,
    Post,
    Put,
    Res,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiOperation,
    ApiParam,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    AppDependenciesService,
    AppDependencySpecSourceAdapter,
    type AppDependencyListEntry,
} from '@ever-works/agent/app-dependencies';
import { isAppEnvEncryptionUnavailableError } from '@ever-works/agent/app-env';
import { config } from '@ever-works/agent/config';
import { WorkOwnershipService, type WorkAccessResult } from '@ever-works/agent/services';
import {
    APP_DEPENDENCY_KINDS,
    type AppDependencyKind,
    type AppDeployTarget,
} from '@ever-works/contracts';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { recordAppDependencyActivity } from './app-dependency-activity';

/**
 * Lane aw-deps-api (APW-07 T25, 2026-10-18) — the App dependency routes (plan §5:787-790).
 *
 * ```
 * GET    /api/works/:id/app-dependencies                  view · 200 AppDependenciesListBody
 * PUT    /api/works/:id/app-dependencies/:kind            edit · 202 { dependency }
 *                                                               · 400 invalidBody · 404 dependencyNotDeclared
 *                                                               · 422 providerNotSupported | sizeShrinkRefused
 *                                                               · 503 secureStorageUnavailable
 * POST   /api/works/:id/app-dependencies/:kind/provision  edit · 202 { dispatched, reason?, dependency }
 *                                                               · 404 dependencyNotDeclared · 409 leaseHeld
 * DELETE /api/works/:id/app-dependencies/:kind            edit · 202 { dependency }  body { confirmSlug }
 *                                                               · 404 dependencyNotDeclared · 409 deleteInProgress
 *                                                               · 422 confirmationMismatch
 * ```
 *
 * `AppDependenciesService` has implemented `list`, `configure`, `retry` and `requestDataDeletion`
 * since T16 with these exact paths in their docstrings — but nothing exposed them, so prod answered
 * `404` for `GET …/app-dependencies`, and a row that ended `failed` after its three attempts
 * (2026-10-18: `clusterUnreachable` on a worker without a plugin registry) could only be retried with
 * a database update.
 *
 * ## Access, and one answer for "not yours"
 *
 * The same posture as `work-app-env.controller.ts`: App Works off → `404 appWorksDisabled`; a Work
 * that is missing, invisible or another account's → `404 notAppWork` alike (plan §5:770-773,
 * APW07-G13); a visible Work of another kind → `404 notAppWork`; a viewer asking to write →
 * `403 editAccessRequired`.
 *
 * ## No value leaves, ever (FR-5)
 *
 * Every answer is the service's `AppDependencyListEntry`: kinds, statuses, reasons, provider ids,
 * output NAMES and resource NAMES — no config value, no output value. A `PUT` config is write-only:
 * it is handed to the service, encrypted before it is stored, and never echoed or logged here.
 *
 * ## Delete data
 *
 * The one irreversible route (FR-46), gated the way `POST app-lifecycle`'s remove-with-data is
 * (`work-app-runtime.controller.ts`, #2706): edit access, `confirmSlug` equal to the Work's slug —
 * checked by the service's `canDeleteAppDependencyData` against the slug THIS route read — and no
 * provisioning lease in flight.
 *
 * ## The controller decides nothing the service decides
 *
 * Paths, access level, body shape, throttles, the Activity row and the status mapping live here;
 * every state transition is `AppDependenciesService`'s.
 */
@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api/works')
@UseGuards(AuthSessionGuard)
export class WorkAppDependenciesController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly dependencies: AppDependenciesService,
        // The deploy target for the `GET` body. Optional: without it the body says `null`, and the
        // cards still render — they only need the rows.
        @Optional() private readonly specs?: AppDependencySpecSourceAdapter,
        @Optional() private readonly activity?: ActivityLogService,
    ) {}

    /** `GET /api/works/:id/app-dependencies` — every dependency card of one App Work. */
    @Get(':id/app-dependencies')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: "Read an App Work's dependencies",
        description:
            'One entry per active dependency (and its kept history row when it was released): kind, ' +
            'provider, status, reason, attempts, backup state, output names and kept resource names. ' +
            'Never a configuration or output value.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: '`{ workId, deployTarget, dependencies, canEdit }`.' })
    @ApiResponse({
        status: 404,
        description: 'Missing, invisible, not an App Work, or App Works off.',
    })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AppDependenciesListBody> {
        await this.authorize(id, auth.userId, 'view');
        const [dependencies, canEdit, deployTarget] = await Promise.all([
            this.dependencies.list(id, { userId: auth.userId }),
            this.canEdit(id, auth.userId),
            this.deployTarget(id),
        ]);
        return { workId: id, deployTarget, dependencies, refreshing: false, canEdit };
    }

    /** `PUT /api/works/:id/app-dependencies/:kind` — provider, prompted config and volume size. */
    @Put(':id/app-dependencies/:kind')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: "Configure one of an App Work's dependencies",
        description:
            'Choose the provider, give its prompted settings (write-only, encrypted before storage) ' +
            'and/or grow its volume, then schedule a fresh provisioning attempt. A smaller `sizeGiB` ' +
            'than the provisioned one is refused.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'kind', enum: [...APP_DEPENDENCY_KINDS] })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                providerId: { type: 'string' },
                config: { type: 'object', additionalProperties: { type: 'string' } },
                sizeGiB: { type: 'integer', minimum: 1 },
            },
        },
    })
    @ApiResponse({ status: 202, description: '`{ dependency }` — the refreshed card.' })
    async configure(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('kind') kindParam: string,
        @Body() body: unknown,
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<{ dependency: AppDependencyListEntry | null }> {
        await this.authorize(id, auth.userId, 'edit');
        const kind = this.parseKind(kindParam);
        const input = parseConfigureBody(body);

        const dependency = await this.mapRefusals(() =>
            this.dependencies.configure(id, kind, { ...input, userId: auth.userId }),
        );

        recordAppDependencyActivity(this.activity, {
            userId: auth.userId,
            workId: id,
            action: 'app.dependency.configured',
            summary: `Dependency ${kind} configured`,
            kinds: [kind],
            details: {
                providerId: dependency?.provider.providerId ?? input.providerId ?? null,
                configChanged: input.config !== undefined,
                ...(input.sizeGiB !== undefined ? { sizeGiB: input.sizeGiB } : {}),
            },
        });

        response.status(HttpStatus.ACCEPTED);
        return { dependency };
    }

    /** `POST /api/works/:id/app-dependencies/:kind/provision` — the card's **Retry**. */
    @Post(':id/app-dependencies/:kind/provision')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: "Retry provisioning one of an App Work's dependencies",
        description:
            'Clears the failure and its attempt count and schedules a fresh attempt. Refused `409 ' +
            'leaseHeld` while a worker is provisioning it.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'kind', enum: [...APP_DEPENDENCY_KINDS] })
    @ApiResponse({
        status: 202,
        description:
            '`{ status: "accepted", dispatched, reason?, dependency }` — `dispatched: false` with ' +
            '`dispatcherUnavailable` means the row is `pending` and the next reconcile sends it.',
    })
    @ApiResponse({ status: 409, description: '`leaseHeld` — a worker holds this dependency now.' })
    async retry(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('kind') kindParam: string,
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<AppDependencyRetryBody> {
        await this.authorize(id, auth.userId, 'edit');
        const kind = this.parseKind(kindParam);

        const answer = await this.mapRefusals(() => this.dependencies.retry(id, kind));
        if (!answer.dispatched && answer.reason === 'leaseHeld') {
            throw refusal(
                'leaseHeld',
                HttpStatus.CONFLICT,
                'This dependency is being provisioned right now. Try again in a moment.',
            );
        }

        recordAppDependencyActivity(this.activity, {
            userId: auth.userId,
            workId: id,
            action: 'app.dependency.retried',
            summary: `Dependency ${kind} retried`,
            kinds: [kind],
            details: { trigger: 'retry', dispatched: answer.dispatched },
        });

        const dependency = await this.entry(id, kind, auth.userId);
        response.status(HttpStatus.ACCEPTED);
        return {
            status: 'accepted',
            dispatched: answer.dispatched,
            ...(answer.reason ? { reason: answer.reason } : {}),
            dependency,
        };
    }

    /** `DELETE /api/works/:id/app-dependencies/:kind` — **Delete data**, the irreversible one. */
    @Delete(':id/app-dependencies/:kind')
    @Throttle({ long: { limit: 5, ttl: 3_600_000 } })
    @ApiOperation({
        summary: "Delete one of an App Work's dependency data — cannot be undone",
        description:
            'Requires `{ confirmSlug }` equal to the App Work slug. Deletes the volumes, databases or ' +
            'buckets the provider created for this dependency.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'kind', enum: [...APP_DEPENDENCY_KINDS] })
    @ApiBody({
        schema: {
            type: 'object',
            required: ['confirmSlug'],
            properties: { confirmSlug: { type: 'string' } },
        },
    })
    @ApiResponse({ status: 202, description: '`{ dependency }` — now `deleting`.' })
    @ApiResponse({ status: 409, description: '`deleteInProgress` — a provisioning lease is held.' })
    @ApiResponse({ status: 422, description: '`confirmationMismatch` — the slug does not match.' })
    async deleteData(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('kind') kindParam: string,
        @Body() body: unknown,
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<{ dependency: AppDependencyListEntry | null }> {
        const access = await this.authorize(id, auth.userId, 'edit');
        const kind = this.parseKind(kindParam);
        const confirmSlug = text((body as { confirmSlug?: unknown } | null)?.confirmSlug);
        const workSlug = text((access.work as { slug?: unknown }).slug);

        const dependency = await this.mapRefusals(() =>
            this.dependencies.requestDataDeletion(id, kind, {
                confirmSlug: confirmSlug || null,
                // An App Work without a slug cannot be confirmed: `''` never equals a typed slug
                // because an empty `confirmSlug` is passed as `null` above.
                workSlug,
                hasEditAccess: true,
            }),
        );

        recordAppDependencyActivity(this.activity, {
            userId: auth.userId,
            workId: id,
            action: 'app.dependency.data_delete_requested',
            summary: `Data deletion requested for dependency ${kind}`,
            kinds: [kind],
            details: { providerId: dependency?.provider.providerId ?? null },
        });

        response.status(HttpStatus.ACCEPTED);
        return { dependency };
    }

    /* ---------------------------------------------------------------------- */

    /** `:kind` must be one of the four (FR-35); anything else is a dependency nobody declared. */
    private parseKind(kind: string): AppDependencyKind {
        if ((APP_DEPENDENCY_KINDS as readonly string[]).includes(kind)) {
            return kind as AppDependencyKind;
        }
        throw refusal(
            'dependencyNotDeclared',
            HttpStatus.NOT_FOUND,
            `"${String(kind).slice(0, 40)}" is not a dependency kind.`,
        );
    }

    /** The service's typed refusals (and the cipher's) as their HTTP answers. */
    private async mapRefusals<T>(run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        } catch (error) {
            if (isAppDependencyRefusal(error)) {
                throw refusal(
                    error.code,
                    REFUSAL_STATUS[error.code] ?? statusOr(error.status),
                    error.message,
                );
            }
            if (isAppEnvEncryptionUnavailableError(error)) {
                throw refusal(
                    'secureStorageUnavailable',
                    HttpStatus.SERVICE_UNAVAILABLE,
                    'Secure storage is not configured, so provider settings cannot be saved.',
                );
            }
            throw error;
        }
    }

    /** The refreshed card of one kind, or `null` (a read failure never fails the write). */
    private async entry(
        workId: string,
        kind: AppDependencyKind,
        userId: string,
    ): Promise<AppDependencyListEntry | null> {
        try {
            const entries = await this.dependencies.list(workId, { userId });
            return entries.find((candidate) => candidate.kind === kind) ?? null;
        } catch {
            return null;
        }
    }

    private async deployTarget(workId: string): Promise<AppDeployTarget | null> {
        if (!this.specs?.read) return null;
        try {
            return (await this.specs.read(workId))?.deployTarget ?? null;
        } catch {
            return null;
        }
    }

    /** View (or edit) access to a visible App Work, or the one refusal each failure gets. */
    private async authorize(
        workId: string,
        userId: string,
        level: 'view' | 'edit',
    ): Promise<WorkAccessResult> {
        if (!config.everWorks.apps.worksEnabled()) {
            throw refusal(
                'appWorksDisabled',
                HttpStatus.NOT_FOUND,
                'App Works is turned off on this installation.',
            );
        }

        let access: WorkAccessResult;
        try {
            access = await this.ownership.ensureCanView(workId, userId);
        } catch (error) {
            if (isStatus(error, HttpStatus.NOT_FOUND) || isStatus(error, HttpStatus.FORBIDDEN)) {
                throw refusal('notAppWork', HttpStatus.NOT_FOUND, `Work ${workId} not found.`);
            }
            throw error;
        }

        if (access.work?.kind !== 'app') {
            throw refusal(
                'notAppWork',
                HttpStatus.NOT_FOUND,
                `Work ${workId} is not an App Work, so it has no App dependencies.`,
            );
        }

        if (level === 'edit') {
            try {
                access = await this.ownership.ensureCanEdit(workId, userId);
            } catch (error) {
                if (
                    isStatus(error, HttpStatus.FORBIDDEN) ||
                    isStatus(error, HttpStatus.NOT_FOUND)
                ) {
                    throw refusal(
                        'editAccessRequired',
                        HttpStatus.FORBIDDEN,
                        'You need edit access to this App Work to do that.',
                    );
                }
                throw error;
            }
        }

        return access;
    }

    /** Whether the viewer may write — the card hides its buttons otherwise (each write re-checks). */
    private async canEdit(workId: string, userId: string): Promise<boolean> {
        try {
            await this.ownership.ensureCanEdit(workId, userId);
            return true;
        } catch {
            return false;
        }
    }
}

/** `GET /api/works/:id/app-dependencies` (plan §5:787). `refreshing` is always `false` today. */
export interface AppDependenciesListBody {
    workId: string;
    deployTarget: AppDeployTarget | null;
    dependencies: AppDependencyListEntry[];
    refreshing: boolean;
    canEdit: boolean;
}

/** `POST …/:kind/provision`'s `202`. */
export interface AppDependencyRetryBody {
    status: 'accepted';
    dispatched: boolean;
    reason?: string;
    dependency: AppDependencyListEntry | null;
}

/**
 * Each `AppDependencyRefusalCode` → its status (plan §5:798-802). The service carries a status too;
 * this table is the route's own contract, so a service-side drift cannot silently change an answer.
 */
const REFUSAL_STATUS: Record<string, number> = {
    dependencyNotDeclared: HttpStatus.NOT_FOUND,
    confirmationMismatch: HttpStatus.UNPROCESSABLE_ENTITY,
    deleteInProgress: HttpStatus.CONFLICT,
    sizeShrinkRefused: HttpStatus.UNPROCESSABLE_ENTITY,
    providerNotSupported: HttpStatus.UNPROCESSABLE_ENTITY,
    secureStorageUnavailable: HttpStatus.SERVICE_UNAVAILABLE,
};

/** The configuration ceilings — a prompt schema is a handful of fields, never a blob store. */
const CONFIG_MAX_KEYS = 32;
const CONFIG_KEY_MAX_LENGTH = 64;
const CONFIG_VALUE_MAX_BYTES = 8_192;
const SIZE_GIB_MAX = 16_384;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `PUT …/:kind`'s body, checked: `{ providerId?, config?, sizeGiB? }` with at least one of them. */
function parseConfigureBody(body: unknown): {
    providerId?: string;
    config?: Record<string, string>;
    sizeGiB?: number;
} {
    const invalid = (message: string) =>
        refusal('invalidBody', HttpStatus.BAD_REQUEST, `Invalid dependency settings: ${message}`);

    if (!body || typeof body !== 'object' || Array.isArray(body))
        throw invalid('expected an object.');
    const raw = body as { providerId?: unknown; config?: unknown; sizeGiB?: unknown };
    const input: { providerId?: string; config?: Record<string, string>; sizeGiB?: number } = {};

    if (raw.providerId !== undefined && raw.providerId !== null) {
        if (typeof raw.providerId !== 'string' || !PROVIDER_ID_PATTERN.test(raw.providerId)) {
            throw invalid('providerId must be a provider id.');
        }
        input.providerId = raw.providerId;
    }

    if (raw.config !== undefined && raw.config !== null) {
        if (typeof raw.config !== 'object' || Array.isArray(raw.config)) {
            throw invalid('config must be an object of strings.');
        }
        const entries = Object.entries(raw.config as Record<string, unknown>);
        if (entries.length > CONFIG_MAX_KEYS) throw invalid('config has too many fields.');
        const parsed: Record<string, string> = {};
        for (const [key, value] of entries) {
            if (!key || key.length > CONFIG_KEY_MAX_LENGTH)
                throw invalid('config has an invalid field name.');
            // The field NAME is safe to say; the value never is (FR-5).
            if (typeof value !== 'string') throw invalid(`config.${key} must be a string.`);
            if (Buffer.byteLength(value, 'utf8') > CONFIG_VALUE_MAX_BYTES) {
                throw invalid(`config.${key} is too large.`);
            }
            parsed[key] = value;
        }
        input.config = parsed;
    }

    if (raw.sizeGiB !== undefined && raw.sizeGiB !== null) {
        const size = raw.sizeGiB;
        if (
            typeof size !== 'number' ||
            !Number.isInteger(size) ||
            size < 1 ||
            size > SIZE_GIB_MAX
        ) {
            throw invalid(`sizeGiB must be a whole number between 1 and ${SIZE_GIB_MAX}.`);
        }
        input.sizeGiB = size;
    }

    if (
        input.providerId === undefined &&
        input.config === undefined &&
        input.sizeGiB === undefined
    ) {
        throw invalid('give a providerId, a config or a sizeGiB.');
    }
    return input;
}

/** `AppDependencyRefusalError`, by shape as well as by class (one bundle can hold two copies). */
function isAppDependencyRefusal(
    value: unknown,
): value is { code: string; message: string; status: number } {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { name?: unknown }).name === 'AppDependencyRefusalError' &&
        typeof (value as { code?: unknown }).code === 'string'
    );
}

function statusOr(status: unknown): number {
    return typeof status === 'number' && status >= 400 && status < 600
        ? status
        : HttpStatus.UNPROCESSABLE_ENTITY;
}

/** One stable refusal body: `{ status: 'error', code, message }`. */
function refusal(code: string, status: number, message: string): HttpException {
    return new HttpException({ status: 'error', code, message }, status);
}

function isStatus(error: unknown, status: number): boolean {
    return error instanceof HttpException && error.getStatus() === status;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** The `@Res({ passthrough: true })` surface this controller needs — nothing else. */
interface StatusOnlyResponse {
    status(code: number): unknown;
}
