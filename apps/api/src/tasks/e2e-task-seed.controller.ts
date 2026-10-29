import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    UnauthorizedException,
    UnprocessableEntityException,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { isAppWorkKind } from '@ever-works/contracts';
import {
    AppChangeGuard,
    DEFAULT_SIZE_GUIDANCE,
    type AppChangeVerdict,
} from '@ever-works/agent/app-works';
import {
    DeploymentEnvironment,
    DeploymentTriggerSource,
    Task,
    Work,
    WorkDeployment,
} from '@ever-works/agent/entities';
import { TasksService } from '@ever-works/agent/tasks-domain';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope/scope-context.service';
import { E2eSeedEnabledGuard } from '../app-launcher/e2e-seed.controller';
import {
    E2eTaskSeedDto,
    type E2eTaskSeedDeliveryDto,
    type E2eTaskSeedDeploymentDto,
    type E2eTaskSeedGuardDto,
} from './e2e-task-seed.dto';

/**
 * APW-08 T29 — the non-production seed route of the App Works evolve-loop e2e specs
 * (`apps/web/e2e/app-works-delivery-chips.spec.ts`, `app-works-guard-refusals.spec.ts`).
 *
 *   | Route                                | Auth    | Gate                                                                   | Success | Refused         |
 *   | ------------------------------------ | ------- | ---------------------------------------------------------------------- | ------- | --------------- |
 *   | `POST /api/e2e/app-works/task-seed`  | session | `NODE_ENV !== 'production'` **and** `E2E_APP_LAUNCHER_SEED === 'true'` | 201     | 404 / 401 / 422 |
 *
 * ## Guarded exactly like the APW-11 seed route
 *
 * The gate is the SAME function and the SAME guard as `POST /api/e2e/app-launcher/seed`
 * (`../app-launcher/e2e-seed.controller.ts`, CONTRACTS R-40): `tasks.module.ts` registers this
 * controller only when `isE2eAppLauncherSeedEnabled()` is true at boot, and
 * {@link E2eSeedEnabledGuard} re-reads it on every request and answers the platform's opaque
 * `404` before the handler — production first, so a stray variable in a production manifest is
 * inert. One variable opens both fixture doors; the PR lane already sets it.
 *
 * ## What it writes, and why nothing else can
 *
 * Only columns the product writes from the worker, which the Task PATCH DTO rejects:
 *
 *   - **delivery** — `deliveryState`, `mergeCommitSha`, `deliveryUpdatedAt`, the merged pull
 *     request (`prNumber`, `prUrl`, `prState: 'merged'`) and, for a change that reached a
 *     Deployment, one `work_deployments` row linked through `deliveryDeploymentId`. That is what
 *     `TaskDeliveryService.getView` / `listEmbeds` read, so the board chip, the Delivery filter and
 *     the Task page's Delivery section render the platform's own answer for the state.
 *   - **guard** — the branch the refused change reached (`branchRef`, `branchState: 'pushed'`) and
 *     `branchGuardRefusal`. The refusal is NOT fixture text: the route runs the real
 *     {@link AppChangeGuard} over the given rules and diff and records its verdict the way the
 *     finalize path's post-push judgement does (`TaskWorkspaceService.guardAppChange` →
 *     `refuseChange`), so the copy a spec asserts is the guard's own sentence. An allowed verdict
 *     writes nothing and is answered, note included.
 *
 * No Build row is written (a `building` / `build_failed` chip reads the state alone), no Activity,
 * no event, no queue, no network. Nothing is deleted or overwritten beyond the named columns.
 *
 * ## Session-scoped
 *
 * The Task is read through `TasksService.getOne` with the request's own scope, so another
 * account's Task is the same `404` the product answers; a Task that is not on an App Work is a
 * `422 notAppWork` (the chain never tracks one, and a fixture must not invent one).
 */
@ApiTags('Tasks')
@ApiBearerAuth('JWT-auth')
@Controller('api/e2e/app-works/task-seed')
@UseGuards(E2eSeedEnabledGuard)
export class E2eTaskSeedController {
    private readonly guard = new AppChangeGuard();

    constructor(
        private readonly tasksService: TasksService,
        @InjectRepository(Task)
        private readonly taskRows: Repository<Task>,
        @InjectRepository(Work)
        private readonly workRows: Repository<Work>,
        @InjectRepository(WorkDeployment)
        private readonly deploymentRows: Repository<WorkDeployment>,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary: 'Seed an App Work Task’s delivery / change-guard state (non-production only)',
        description:
            'Writes the worker-only delivery and branch columns of one of the caller’s App Work Tasks, plus the deciding `work_deployments` row; a `guard` body is judged by the real AppChangeGuard and its refusal recorded. Answers 404 unless `NODE_ENV !== "production"` and `E2E_APP_LAUNCHER_SEED === "true"`.',
    })
    @ApiResponse({ status: 201, description: 'What was written, and the guard verdict.' })
    @ApiResponse({ status: 404, description: 'The route is closed, or the Task is not visible.' })
    @ApiResponse({ status: 422, description: '`notAppWork`.' })
    async seed(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: E2eTaskSeedDto,
    ): Promise<E2eTaskSeedResponse> {
        const userId = typeof auth?.userId === 'string' ? auth.userId.trim() : '';
        if (userId.length === 0) {
            throw new UnauthorizedException();
        }
        const task = await this.tasksService.getOne(userId, body.taskId, this.scopeContext.getScope());
        const work = task.workId ? await this.workRows.findOne({ where: { id: task.workId } }) : null;
        if (!work || !isAppWorkKind(work.kind)) {
            throw new UnprocessableEntityException({
                code: 'notAppWork',
                message: 'Only a Task on an App Work carries a delivery chain or a change guard.',
            });
        }

        const patch: Partial<Task> = {};
        let deploymentId: string | null = task.deliveryDeploymentId ?? null;
        if (body.delivery) {
            const merge = body.delivery.mergeCommitSha ?? randomBytes(20).toString('hex');
            if (body.delivery.deployment) {
                deploymentId = await this.seedDeployment(task, work, merge, body.delivery.deployment);
            }
            Object.assign(patch, deliveryPatch(body.delivery, merge, deploymentId, task.prNumber));
        }

        let verdict: AppChangeVerdict | null = null;
        let recorded: string | null = null;
        if (body.guard) {
            verdict = this.judge(body.guard);
            if (verdict.allowed !== true) {
                recorded = refusalBody(verdict);
                patch.branchGuardRefusal = recorded;
                patch.branchRef = task.branchRef ?? `task/${(task.slug ?? 'e2e').toLowerCase()}-e2e`;
                patch.branchState = 'pushed';
            }
        }

        if (Object.keys(patch).length > 0) {
            await this.taskRows.update({ id: task.id }, patch);
        }
        const fresh = (await this.taskRows.findOne({ where: { id: task.id } })) ?? task;
        return {
            taskId: fresh.id,
            workId: work.id,
            deliveryState: fresh.deliveryState ?? null,
            mergeCommitSha: fresh.mergeCommitSha ?? null,
            deliveryDeploymentId: fresh.deliveryDeploymentId ?? null,
            prNumber: fresh.prNumber ?? null,
            guard: verdict
                ? {
                      allowed: verdict.allowed === true,
                      code: verdict.code,
                      message: verdict.message,
                      paths: [...verdict.paths],
                      changedLines: verdict.changedLines,
                      note: verdict.note,
                      branchGuardRefusal: recorded,
                  }
                : null,
        };
    }

    /** The real guard over the fixture's rules and diff (rule order and copy are the guard's). */
    private judge(guard: E2eTaskSeedGuardDto): AppChangeVerdict {
        const files = guard.files.map((file) => ({
            path: file.path,
            status: file.status ?? 'modified',
            ...(file.previousPath ? { previousPath: file.previousPath } : {}),
            additions: file.additions ?? 0,
            deletions: file.deletions ?? 0,
        }));
        return this.guard.evaluate({
            rules: {
                sourceBranch: null,
                checks: [],
                protectedPaths: guard.protectedPaths ?? [],
                humanMergePaths: [],
                instructionFiles: [],
                sizeGuidance: guard.sizeGuidance ?? DEFAULT_SIZE_GUIDANCE,
            },
            diff: {
                files,
                truncated: false,
                totalFiles: guard.totalFiles ?? files.length,
                totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
                totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
                patchBytes: 0,
            },
        });
    }

    /** One production `work_deployments` row, scoped like its Work, carrying the change. */
    private async seedDeployment(
        task: Task,
        work: Work,
        mergeCommitSha: string,
        deployment: E2eTaskSeedDeploymentDto,
    ): Promise<string> {
        const now = new Date();
        const terminal = deployment.state !== 'BUILDING';
        const appRender: Record<string, unknown> | null = deployment.rollbackFailed
            ? { failure: { code: 'rollback_failed' } }
            : deployment.withWarnings
              ? { warnings: ['e2e: a render warning'] }
              : null;
        const row = await this.deploymentRows.save(
            this.deploymentRows.create({
                workId: work.id,
                environment: DeploymentEnvironment.PRODUCTION,
                provider: E2E_TASK_SEED_PROVIDER,
                branch: 'main',
                state: deployment.state,
                commitSha: deployment.commitSha ?? mergeCommitSha,
                website: deployment.website ?? null,
                triggerSource: DeploymentTriggerSource.MANUAL,
                startedAt: now,
                completedAt: terminal ? now : null,
                tenantId: work.tenantId ?? task.tenantId ?? null,
                organizationId: work.organizationId ?? task.organizationId ?? null,
                ...(appRender ? { appRender } : {}),
            }),
        );
        return row.id;
    }
}

/** `work_deployments.provider` — the fixture says who wrote the row. */
export const E2E_TASK_SEED_PROVIDER = 'e2e-seed';

/** What a seed answers: the columns as now stored, and the guard's verdict when one was asked. */
export interface E2eTaskSeedResponse {
    taskId: string;
    workId: string;
    deliveryState: string | null;
    mergeCommitSha: string | null;
    deliveryDeploymentId: string | null;
    prNumber: number | null;
    guard: {
        allowed: boolean;
        code: string | null;
        message: string | null;
        paths: string[];
        changedLines: number;
        note: string | null;
        /** The text recorded on `branchGuardRefusal` (null for an allowed change). */
        branchGuardRefusal: string | null;
    } | null;
}

/** The delivery columns of a change in `delivery.state`. */
function deliveryPatch(
    delivery: E2eTaskSeedDeliveryDto,
    mergeCommitSha: string,
    deploymentId: string | null,
    existingPrNumber: number | null | undefined,
): Partial<Task> {
    const prNumber = delivery.prNumber ?? existingPrNumber ?? 1;
    return {
        deliveryState: delivery.state,
        mergeCommitSha,
        deliveryUpdatedAt: new Date(),
        deliveryDeploymentId: deploymentId,
        prNumber,
        prUrl: `https://github.com/e2e-seed/app/pull/${prNumber}`,
        prState: 'merged',
    };
}

/**
 * The refusal as the finalize path's post-push judgement records it when no pull request was
 * opened (`TaskWorkspaceService.guardAppChange`): the guard's sentence, the consequence, then the
 * offending paths.
 */
function refusalBody(verdict: AppChangeVerdict): string {
    const paths = verdict.paths.length
        ? ['', 'Paths:', ...verdict.paths.map((path) => `- \`${path}\``)]
        : [];
    return [
        `${verdict.message} The branch was pushed but no pull request was opened.`,
        ...paths,
    ].join('\n');
}
