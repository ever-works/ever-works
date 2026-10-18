import {
    Body,
    Controller,
    Get,
    HttpException,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Put,
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
import {
    AppEnvEditorService,
    isAppEnvEditorRefusal,
    isAppEnvRefusalError,
} from '@ever-works/agent/app-env';
import { config } from '@ever-works/agent/config';
import { WorkOwnershipService, type WorkAccessResult } from '@ever-works/agent/services';
import {
    APP_ENV_PUTS_PER_MINUTE,
    type AppEnvListResponse,
    type AppEnvPatchResponse,
} from '@ever-works/contracts';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * APW-07 T24 (lane aw-env-smtp, 2026-10-18) — the App env routes (plan §5:784-785).
 *
 * ```
 * GET /api/works/:id/app-env   view · 200 AppEnvListResponse
 * PUT /api/works/:id/app-env   edit · 200 AppEnvPatchResponse
 *                                    · 400 invalidBody | tooManyNames | undeclaredName (+ names)
 *                                    · 409 specUnavailable · 503 secureStorageUnavailable | storeUnavailable
 * ```
 *
 * Until these routes there was no way to set an App env value after create: `appEnv` on
 * `POST /api/works` was the only door, so a required prompted value the creator left out
 * (`env_required_unset`) blocked every Deploy for good.
 *
 * ## No value leaves, ever
 *
 * `GET` answers names, sources, phases, `set` and `masked` — never a stored value (FR-5); the only two
 * values on the wire are the App spec's own public `value` literals and a keypair's public half, both
 * already public. `PUT` answers per-name outcomes and the refreshed table, again without a value.
 *
 * ## Access, and one answer for "not yours"
 *
 * The same posture as the Builds routes: a Work that does not exist, is not visible or is another
 * account's answers `404 notAppWork` alike; a visible Work of another kind is `404 notAppWork`; a
 * viewer asking to write is `403 editAccessRequired`. With App Works off every route is
 * `404 appWorksDisabled`.
 *
 * ## The controller decides nothing the services decide
 *
 * `AppEnvEditorService` owns the merge patch (declared-name check, set/unset split) and `AppEnvService`
 * the write itself (validation, ceilings, Activity row, `app.env.changed` — whose consumers rebuild for
 * a build-phase name and redeploy for a runtime one). This file holds the paths, the access level, the
 * 30-per-minute PUT ceiling (`APP_ENV_PUTS_PER_MINUTE`) and the status mapping.
 */
@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api/works')
@UseGuards(AuthSessionGuard)
export class WorkAppEnvController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly editor: AppEnvEditorService,
    ) {}

    /** `GET /api/works/:id/app-env` — the declared env, the prompted values and the injected names. */
    @Get(':id/app-env')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: "Read an App Work's Environment",
        description:
            'Every env entry the effective App spec declares (prompted, generated, literal, derived and ' +
            'dependency-injected), plus any value the owner set, with set / masked / secret / phase. ' +
            'Never a secret value.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: '`AppEnvListResponse`.' })
    @ApiResponse({
        status: 404,
        description: 'Missing, invisible, not an App Work, or App Works off.',
    })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AppEnvListResponse> {
        await this.authorize(id, auth.userId, 'view');
        const canEdit = await this.canEdit(id, auth.userId);
        return this.editor.describe(id, { userId: auth.userId, canEdit });
    }

    /** `PUT /api/works/:id/app-env` — set (string) or remove (`null`) declared values. */
    @Put(':id/app-env')
    @Throttle({ long: { limit: APP_ENV_PUTS_PER_MINUTE, ttl: 60_000 } })
    @ApiOperation({
        summary: "Change an App Work's Environment values",
        description:
            'A merge patch `{ values: { NAME: string | null } }`: a string sets the name, `null` removes ' +
            'the stored value. Every name must be declared by the effective App spec. Emits ' +
            '`app.env.changed` (a build-phase name rebuilds, a runtime one redeploys) and writes one ' +
            'Activity row with the names — never a value.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiBody({
        schema: {
            type: 'object',
            required: ['values'],
            properties: {
                values: {
                    type: 'object',
                    additionalProperties: { type: 'string', nullable: true },
                },
            },
        },
    })
    @ApiResponse({
        status: 200,
        description: '`AppEnvPatchResponse` — per-name outcomes and the table.',
    })
    @ApiResponse({ status: 400, description: '`invalidBody` · `tooManyNames` · `undeclaredName`.' })
    @ApiResponse({ status: 403, description: '`editAccessRequired` — a viewer.' })
    @ApiResponse({ status: 409, description: '`specUnavailable` — no usable App spec yet.' })
    @ApiResponse({ status: 503, description: '`secureStorageUnavailable` · `storeUnavailable`.' })
    async patch(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: unknown,
    ): Promise<AppEnvPatchResponse> {
        await this.authorize(id, auth.userId, 'edit');
        try {
            return await this.editor.patch(id, { userId: auth.userId, canEdit: true }, body);
        } catch (error) {
            if (isAppEnvEditorRefusal(error)) {
                throw refusal(error.code, error.status, error.message, error.names);
            }
            if (isAppEnvRefusalError(error)) {
                throw refusal(error.code, error.status, error.message);
            }
            throw error;
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
                `Work ${workId} is not an App Work, so it has no App env.`,
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

    /** Whether the viewer may write — the card hides **Edit** otherwise (the PUT re-checks). */
    private async canEdit(workId: string, userId: string): Promise<boolean> {
        try {
            await this.ownership.ensureCanEdit(workId, userId);
            return true;
        } catch {
            return false;
        }
    }
}

/** One stable refusal body: `{ status: 'error', code, message, names? }`. */
function refusal(code: string, status: number, message: string, names?: string[]): HttpException {
    return new HttpException(
        {
            status: 'error',
            code,
            message,
            ...(names && names.length > 0 ? { names } : {}),
        },
        status,
    );
}

function isStatus(error: unknown, status: number): boolean {
    return error instanceof HttpException && error.getStatus() === status;
}
