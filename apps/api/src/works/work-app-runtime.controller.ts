import {
    Body,
    Controller,
    Get,
    HttpException,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Put,
    Res,
    UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
    AppTargetService,
    type AppStatusBody,
    type AppTargetBody,
    type AppTargetRefusal,
} from '@ever-works/agent/app-runtime';
import { WorkOwnershipService, type WorkAccessResult } from '@ever-works/agent/services';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * APW-06 T33 (lane aw-deploy-2, 2026-10-17) — the App target and status routes the web's Deploy tab
 * calls (`apps/web/src/lib/api/app-runtime.ts`, plan §9.1):
 *
 * ```
 * GET  /api/works/:id/app-target         → 200 AppTargetView
 * PUT  /api/works/:id/app-target         → 200 AppTargetView | 422 APP_TARGET_REFUSED | 409 APP_WORK_DELETING
 * POST /api/works/:id/app-target/check   → 202 { status: 'accepted', requestId, dispatched }
 * GET  /api/works/:id/app-status         → 200 AppStatusView
 * POST /api/works/:id/app-rollback       → 202 | 409 | 422 (the deploy answer)   (lane aw-deploy-3)
 * POST /api/works/:id/app-lifecycle      → 202 { status, action, requestId }      (lane aw-deploy-3)
 * ```
 *
 * ## Access first (APW06-G06)
 *
 * Every route resolves access before anything else: `GET` needs `view`, the rest `edit`. A Work
 * that is missing, invisible, or another account's answers the same `404`, so a route cannot be
 * used to discover whose Work is whose; a visible Work that is not an App Work answers
 * `404 notAppWork` (plan §9.1 (c)).
 *
 * ## The kubeconfig (ACC-06-56)
 *
 * `POST …/check` is the only place it is accepted. It is stored write-only by
 * {@link AppTargetService.check}, never parsed, never loaded, never logged and never echoed: the
 * `202` carries a request id and nothing else, and `GET app-target` returns the worker's
 * secret-free `clusterCheck` result.
 */
@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api/works')
@UseGuards(AuthSessionGuard)
export class WorkAppRuntimeController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly targets: AppTargetService,
    ) {}

    @Get(':id/app-target')
    @ApiOperation({
        summary: "An App Work's deploy target, its settings and the last cluster check",
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async getAppTarget(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AppTargetBody> {
        await this.authorize(id, auth.userId, 'view');
        return this.targets.getTarget(id, auth.userId);
    }

    @Put(':id/app-target')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({ summary: "Change an App Work's deploy target and its settings" })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async putAppTarget(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: { target?: unknown; settings?: unknown },
    ): Promise<AppTargetBody> {
        await this.authorize(id, auth.userId, 'edit');
        const result = await this.targets.putTarget(id, auth.userId, body ?? {});
        if ('refusal' in result) throw refusalException(result.refusal);
        return (result as { body: AppTargetBody }).body;
    }

    @Post(':id/app-target/check')
    @Throttle({ long: { limit: 6, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Store a kubeconfig (write-only) and queue the isolated worker’s cluster check',
        description:
            'Answers 202 at once. The kubeconfig is never echoed; the result lands in GET app-target ' +
            '`clusterCheck` / `clusterCheckedAt`. A body without `kubeconfig` re-checks the stored one.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async checkAppTarget(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: { kubeconfig?: unknown; kubeContext?: unknown },
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<{ status: 'accepted'; requestId: string; dispatched: boolean }> {
        await this.authorize(id, auth.userId, 'edit');
        const result = await this.targets.check(id, auth.userId, body ?? {});
        if ('refusal' in result) throw refusalException(result.refusal);
        response.status(HttpStatus.ACCEPTED);
        const accepted = result as { requestId: string; dispatched: boolean };
        return {
            status: 'accepted',
            requestId: accepted.requestId,
            dispatched: accepted.dispatched,
        };
    }

    @Get(':id/app-status')
    @ApiOperation({ summary: "An App Work's runtime state, its URL and the current Deployment" })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async getAppStatus(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AppStatusBody> {
        await this.authorize(id, auth.userId, 'view');
        return this.targets.getStatus(id);
    }

    /**
     * Lane aw-deploy-3 — `POST :id/app-rollback` (plan §9.1, FR-34): roll back to an earlier Live
     * Deployment. Answers with the deploy request's own status (`202`, `409`, `422`, `503`) and
     * the same body shape as `POST :id/deploy`.
     */
    @Post(':id/app-rollback')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({ summary: 'Roll an App Work back to an earlier Live Deployment' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async rollbackApp(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: { deploymentId?: unknown; runPreDeployJobs?: unknown },
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<Record<string, unknown>> {
        await this.authorize(id, auth.userId, 'edit');
        const answer = await this.targets.rollback(id, auth.userId, body ?? {});
        if ('refusal' in answer) throw refusalException(answer.refusal);
        const result = (
            answer as unknown as { result: Record<string, unknown> & { httpStatus: number } }
        ).result;
        response.status(result.httpStatus);
        const notices = (list: unknown) =>
            (Array.isArray(list) ? list : []).map(
                (entry: { code?: unknown; message?: unknown }) => ({
                    code: String(entry?.code ?? ''),
                    message: String(entry?.message ?? ''),
                }),
            );
        return {
            status: result.status,
            code: result.code,
            deploymentId: result.deploymentId,
            queuedDeploymentId: result.queuedDeploymentId,
            runningDeploymentId: result.runningDeploymentId,
            dispatched: result.dispatched,
            deduplicated: result.deduplicated,
            unmet: notices(result.unmet),
            advisory: notices(result.advisory),
            warnings: notices(result.warnings),
        };
    }

    /**
     * Lane aw-deploy-3 — `POST :id/app-lifecycle` (plan §9.1): `{ action: 'pause' | 'resume' |
     * 'remove' | 'cancel-deploy', deleteData?, confirmSlug? }`, run by the isolated worker as an
     * `app-cluster-op`. `deleteData` requires `confirmSlug === work.slug`.
     */
    @Post(':id/app-lifecycle')
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Pause, resume, remove or cancel the running Deployment of an App Work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async lifecycleApp(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: { action?: unknown; deleteData?: unknown; confirmSlug?: unknown },
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<{ status: 'accepted'; action: string; requestId: string; dispatched: boolean }> {
        const access = await this.authorize(id, auth.userId, 'edit');
        const answer = await this.targets.lifecycle(
            { id, slug: (access.work as { slug?: string | null }).slug ?? null },
            auth.userId,
            body ?? {},
        );
        if ('refusal' in answer) throw refusalException(answer.refusal);
        const accepted = answer as { requestId: string; dispatched: boolean; action: string };
        response.status(HttpStatus.ACCEPTED);
        return {
            status: 'accepted',
            action: accepted.action,
            requestId: accepted.requestId,
            dispatched: accepted.dispatched,
        };
    }

    /** `view`/`edit` access to a visible App Work, or the one refusal each failure gets. */
    private async authorize(
        workId: string,
        userId: string,
        level: 'view' | 'edit',
    ): Promise<WorkAccessResult> {
        let access: WorkAccessResult;
        try {
            access =
                level === 'edit'
                    ? await this.ownership.ensureCanEdit(workId, userId)
                    : await this.ownership.ensureCanView(workId, userId);
        } catch (error) {
            if (error instanceof HttpException) {
                const status = error.getStatus();
                if (status === HttpStatus.NOT_FOUND || status === HttpStatus.FORBIDDEN) {
                    throw new HttpException(
                        { status: 'error', message: `Work with id '${workId}' not found` },
                        HttpStatus.NOT_FOUND,
                    );
                }
            }
            throw error;
        }

        if (access.work.kind !== 'app') {
            throw new HttpException(
                {
                    status: 'error',
                    code: 'notAppWork',
                    message: `Work ${workId} is not an App Work.`,
                },
                HttpStatus.NOT_FOUND,
            );
        }
        return access;
    }
}

function refusalException(refusal: AppTargetRefusal): HttpException {
    return new HttpException(
        {
            status: 'error',
            code: refusal.code,
            message: refusal.message,
            ...(refusal.unmet ? { unmet: refusal.unmet } : {}),
        },
        refusal.httpStatus,
    );
}

/** The `@Res({ passthrough: true })` surface this controller needs — nothing else. */
interface StatusOnlyResponse {
    status(code: number): unknown;
}
