import {
    Body,
    Controller,
    Get,
    HttpException,
    HttpStatus,
    Optional,
    Param,
    ParseUUIDPipe,
    Post,
    Res,
    UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
    AppTargetService,
    type AppDeploymentHistoryEntry,
    type AppLogsReadBody,
    type AppOpsAccepted,
    type AppTargetRefusal,
} from '@ever-works/agent/app-runtime';
import { WorkOwnershipService, type WorkAccessResult } from '@ever-works/agent/services';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { recordAppOpsActivity } from './app-ops-activity';

/**
 * Lane aw-ops (APW-06 §9.1, 2026-10-27) — the live App's operations behind the Deploy tab. The
 * isolated worker could already run each of them (`app-lifecycle-ops.service.ts`, the router's
 * `smoke` op); these are the routes that let a member ask:
 *
 * ```
 * POST /api/works/:id/app-status/refresh   edit · 202 { status, op, requestId, dispatched } · 409 · 429 refresh_too_soon
 * POST /api/works/:id/app-logs              edit · 202 { … requestId }                       · 400 · 409 · 503
 * GET  /api/works/:id/app-logs/:requestId   edit · 200 { requestId, status: pending|ready|failed, tail?, code? } · 404
 * POST /api/works/:id/app-jobs/:name/run    edit · 202                                       · 400 · 409 · 422 job_confirmation_required
 * POST /api/works/:id/app-smoke             edit · 202                                       · 409
 * GET  /api/works/:id/app-deployments       view · 200 { deployments: AppDeploymentHistoryEntry[] }
 * ```
 *
 * ## Who may do what (spec S28, FR-48, ACC-06-57)
 *
 * A viewer sees status, history and smoke results (`GET app-status` on the sibling controller, and
 * `GET app-deployments` here) and nothing else: every action — and **reading logs**, which FR-48
 * keeps "only for members who can deploy" — needs `edit`. Access is resolved first and mapped as
 * plan §9.1 (APW06-G06) says: a missing Work and one the caller has no membership of answer the
 * same `404` body as an unknown id; a member below `edit` gets `403`; only then is the kind
 * checked (`404 notAppWork`). The Work owner's extra gates (`app-owner-gate.ts`) do not apply:
 * none of these choose a cluster or delete data.
 *
 * ## Limits
 *
 * Refresh: once per 15 s per Work (FR-46, enforced in the service) plus 4/min per caller; logs
 * 10/min (the read-back 120/min, because the drawer polls it); a job or a smoke run 5/min.
 *
 * ## Nothing secret crosses
 *
 * Every op is an `app-cluster-op` dispatch of names and ids. A log tail is redacted again here,
 * at read time, with the App's secret env values (`AppTargetService.readLogs`).
 */
@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api/works')
@UseGuards(AuthSessionGuard)
export class WorkAppOpsController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly targets: AppTargetService,
        @Optional() private readonly activity?: ActivityLogService,
    ) {}

    @Post(':id/app-status/refresh')
    @Throttle({ long: { limit: 4, ttl: 60_000 } })
    @ApiOperation({
        summary: "Refresh an App Work's runtime status from its cluster",
        description:
            'Queues a status read on the isolated worker and answers 202 at once; the snapshot lands in ' +
            'GET app-status. Once every 15 seconds per App Work.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async refreshStatus(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) response: OpsResponse,
    ): Promise<AcceptedBody> {
        await this.authorize(id, auth.userId, 'edit');
        return accepted(await this.targets.refreshStatus(id, auth.userId), response);
    }

    @Post(':id/app-logs')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: "Fetch the last log lines of one of an App Work's components or jobs",
        description:
            'Body `{ component | job, deploymentId?, previous?, lines? (1–500, default 200) }`. Answers 202 ' +
            'with a request id; read the tail back with GET app-logs/:requestId (kept 5 minutes).',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    // Lane B1 (chat and MCP parity): the body is parsed by the service, so describe it here —
    // without a schema the generated MCP tool `request_app_logs` would offer no argument at all.
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                component: {
                    type: 'string',
                    description:
                        'One component of the App spec. Give a component or a job, not both.',
                },
                job: {
                    type: 'string',
                    description: 'One job of the App spec. Give a component or a job, not both.',
                },
                deploymentId: { type: 'string', description: 'A Deployment of this App Work.' },
                previous: { type: 'boolean', description: "The previous container's logs." },
                lines: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
            },
        },
    })
    async requestLogs(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body()
        body: {
            component?: unknown;
            job?: unknown;
            deploymentId?: unknown;
            previous?: unknown;
            lines?: unknown;
        },
        @Res({ passthrough: true }) response: OpsResponse,
    ): Promise<AcceptedBody> {
        await this.authorize(id, auth.userId, 'edit');
        return accepted(await this.targets.requestLogs(id, auth.userId, body ?? {}), response);
    }

    @Get(':id/app-logs/:requestId')
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Read back one log request',
        description:
            '`pending` until the worker answers, then `ready` with the redacted tail or `failed` with a ' +
            "code. 404 for an unknown, expired or another App Work's request id.",
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'requestId', description: 'The id POST app-logs answered' })
    async readLogs(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('requestId') requestId: string,
    ): Promise<AppLogsReadBody> {
        // FR-48: logs are for members who can deploy — the read as much as the request.
        await this.authorize(id, auth.userId, 'edit');
        const result = await this.targets.readLogs(id, requestId);
        if ('refusal' in result) throw refusalException(result.refusal);
        return (result as { body: AppLogsReadBody }).body;
    }

    @Post(':id/app-jobs/:name/run')
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiOperation({
        summary: "Run one of an App Work's jobs now",
        description:
            'Runs the App spec job with the live image and env. The body must carry ' +
            '`confirmFirstDeploy: true` — the member confirmed the run (a job can change the app’s data). ' +
            '409 while a Deployment runs or while a run of the same job is going.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'name', description: 'The App spec job name' })
    async runJob(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('name') name: string,
        @Body() body: { confirmFirstDeploy?: unknown },
        @Res({ passthrough: true }) response: OpsResponse,
    ): Promise<AcceptedBody> {
        await this.authorize(id, auth.userId, 'edit');
        const answer = accepted(
            await this.targets.runJob(id, auth.userId, name, body ?? {}),
            response,
        );
        const jobName = String(name ?? '').slice(0, 63);
        recordAppOpsActivity(this.activity, {
            userId: auth.userId,
            workId: id,
            action: 'app.job.requested',
            summary: `Requested a run of the ${jobName} job`,
            details: { jobName, requestId: answer.requestId, dispatched: answer.dispatched },
        });
        return answer;
    }

    @Post(':id/app-smoke')
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiOperation({
        summary: "Run an App Work's smoke checks against the live Deployment",
        description:
            'Queues the in-cluster and public checks of the App spec on the isolated worker; the result ' +
            'lands on the live Deployment (GET app-status `smoke`). Never rolls anything back.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async runSmoke(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) response: OpsResponse,
    ): Promise<AcceptedBody> {
        await this.authorize(id, auth.userId, 'edit');
        const answer = accepted(await this.targets.runSmoke(id, auth.userId), response);
        recordAppOpsActivity(this.activity, {
            userId: auth.userId,
            workId: id,
            action: 'app.smoke.requested',
            summary: 'Requested a smoke check run',
            details: { requestId: answer.requestId, dispatched: answer.dispatched },
        });
        return answer;
    }

    @Get(':id/app-deployments')
    @ApiOperation({
        summary: "An App Work's Deployment history",
        description:
            'The last 20 Deployments, newest first: ids, states, trigger, Build, commit, image digest, ' +
            'times and a smoke count. No render facts, env or hosts.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async listDeployments(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ deployments: AppDeploymentHistoryEntry[] }> {
        await this.authorize(id, auth.userId, 'view');
        return { deployments: await this.targets.listDeployments(id) };
    }

    /**
     * Plan §9.1 (APW06-G06): (a) missing or not a member → the unknown-id `404`; (b) a member
     * below `edit` → `403`; (c) only then the kind (`404 notAppWork`).
     */
    private async authorize(
        workId: string,
        userId: string,
        level: 'view' | 'edit',
    ): Promise<WorkAccessResult> {
        let access: WorkAccessResult;
        try {
            access = await this.ownership.ensureCanView(workId, userId);
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

        if (level === 'edit') {
            try {
                access = await this.ownership.ensureCanEdit(workId, userId);
            } catch (error) {
                if (error instanceof HttpException) {
                    const status = error.getStatus();
                    if (status === HttpStatus.NOT_FOUND || status === HttpStatus.FORBIDDEN) {
                        throw new HttpException(
                            {
                                status: 'error',
                                code: 'forbidden',
                                message: 'You need permission to deploy this App Work to do that.',
                            },
                            HttpStatus.FORBIDDEN,
                        );
                    }
                }
                throw error;
            }
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

/** The `202` body every queued op answers. */
interface AcceptedBody {
    status: 'accepted';
    op: AppOpsAccepted['op'];
    requestId: string;
    dispatched: boolean;
}

function accepted(
    result: AppOpsAccepted | { ok: false; refusal: AppTargetRefusal },
    response: OpsResponse,
): AcceptedBody {
    if ('refusal' in result) {
        if (result.refusal.retryAfterSeconds && typeof response.setHeader === 'function') {
            response.setHeader('Retry-After', String(result.refusal.retryAfterSeconds));
        }
        throw refusalException(result.refusal);
    }
    const ok = result as AppOpsAccepted;
    response.status(HttpStatus.ACCEPTED);
    return { status: 'accepted', op: ok.op, requestId: ok.requestId, dispatched: ok.dispatched };
}

function refusalException(refusal: AppTargetRefusal): HttpException {
    return new HttpException(
        {
            status: 'error',
            code: refusal.code,
            message: refusal.message,
            ...(refusal.unmet ? { unmet: refusal.unmet } : {}),
            ...(refusal.retryAfterSeconds ? { retryAfterSeconds: refusal.retryAfterSeconds } : {}),
        },
        refusal.httpStatus,
    );
}

/** The `@Res({ passthrough: true })` surface this controller needs — nothing else. */
interface OpsResponse {
    status(code: number): unknown;
    setHeader?(name: string, value: string): unknown;
}
