import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ownershipScopeOf } from '../database/ownership-scope';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { TaskStatus, type Task } from '../entities/task.entity';
import type { Work } from '../entities/work.entity';
import {
    AppBuildFailedEvent,
    AppBuildSucceededEvent,
    type AppBuildEventPayload,
} from '../events/app-build.events';
import { TaskChatService } from '../tasks-domain/task-chat.service';
import { TasksService } from '../tasks-domain/tasks.service';
import { PROVISION_LABEL } from './app-change-guard';
import { AppProvisioningService } from './app-provisioning.service';

/**
 * APW-04 — the provisioning feedback loop: what the platform learns when it builds, boots
 * and smoke-tests a provisioned App spec goes BACK to the provisioning Task, and the Agent
 * gets a bounded number of follow-up iterations to fix it.
 *
 * ## Sources
 *
 *   - `app.build.succeeded` / `app.build.failed` (APW-05, `events/app-build.events.ts`,
 *     emitted in the API process by `AppBuildsService`);
 *   - `app.deploy.failed` / `app.smoke.failed` / `app.smoke.passed` (APW-06). These are
 *     emitted in the isolated App runtime worker through `APP_RUNTIME_EVENT_SINK`, whose
 *     API relay is APW-06 T28; the handlers are here so they fire the day the relay
 *     publishes them on the API's event bus. The upstream-sync smoke failure already
 *     reaches the API today through `APP_PROVISION_EVENTS_PORT` (a re-provision Task).
 *
 * ## Which Task, and what happens
 *
 * The Work's most recent `app-provision` Task (not cancelled, at most 14 days old).
 *
 *   - **Open Task** (`todo`/`in_progress`/`in_review`/`blocked`): the evidence is posted on
 *     the Task, and the Task's Agent is dispatched again on the same Task — a follow-up
 *     iteration on the same branch / pull request.
 *   - **Delivered Task** (`done` — its pull request merged): a failure on the default
 *     branch means the merged spec does not work, so a NEW `app-provision` Task is filed
 *     through `AppProvisioningService.start` (trigger `build-failed`) with the evidence and
 *     a link to the previous one.
 *   - **Success** on an open Task: the evidence is posted (no dispatch).
 *
 * ## Bounded
 *
 * Each iteration is counted on the Task as a `provision-attempt-<n>` label and carried
 * across the chain. At {@link MAX_PROVISION_ATTEMPTS} the loop stops and posts that a
 * person has to look — it never retries forever on a repository it cannot run.
 *
 * Every handler swallows its own errors: an event listener must never break the emitter.
 */

/** Follow-up iterations after the first provisioning run. */
export const MAX_PROVISION_ATTEMPTS = 3;

/** The label prefix that counts iterations on a provisioning Task. */
export const PROVISION_ATTEMPT_LABEL_PREFIX = 'provision-attempt-';

const RELEVANT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const OPEN: readonly TaskStatus[] = [
    TaskStatus.TODO,
    TaskStatus.IN_PROGRESS,
    TaskStatus.IN_REVIEW,
    TaskStatus.BLOCKED,
    TaskStatus.BACKLOG,
];

/** The runtime event payload as this listener reads it (names and ids only, §9.4). */
interface RuntimeEventPayload {
    readonly workId?: string;
    readonly deploymentId?: string;
    readonly code?: string;
    readonly reason?: string;
}

/** One piece of evidence, normalised across build and runtime events. */
export interface ProvisioningEvidence {
    readonly workId: string;
    readonly outcome: 'failed' | 'succeeded';
    readonly stage: 'build' | 'deploy' | 'smoke';
    readonly branch: string | null;
    readonly summary: string;
}

@Injectable()
export class AppProvisioningFeedbackService {
    private readonly logger = new Logger(AppProvisioningFeedbackService.name);

    constructor(
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly taskRepository?: TaskRepository,
        @Optional() private readonly tasks?: TasksService,
        @Optional() private readonly chat?: TaskChatService,
        @Optional() private readonly provisioning?: AppProvisioningService,
    ) {}

    @OnEvent(AppBuildFailedEvent.EVENT_NAME)
    async onBuildFailed(event: AppBuildFailedEvent): Promise<void> {
        await this.safely(() => this.handle(buildEvidence(event?.payload, 'failed')));
    }

    @OnEvent(AppBuildSucceededEvent.EVENT_NAME)
    async onBuildSucceeded(event: AppBuildSucceededEvent): Promise<void> {
        await this.safely(() => this.handle(buildEvidence(event?.payload, 'succeeded')));
    }

    @OnEvent('app.deploy.failed')
    async onDeployFailed(event: unknown): Promise<void> {
        await this.safely(() => this.handle(runtimeEvidence(event, 'deploy', 'failed')));
    }

    @OnEvent('app.smoke.failed')
    async onSmokeFailed(event: unknown): Promise<void> {
        await this.safely(() => this.handle(runtimeEvidence(event, 'smoke', 'failed')));
    }

    @OnEvent('app.smoke.passed')
    async onSmokePassed(event: unknown): Promise<void> {
        await this.safely(() => this.handle(runtimeEvidence(event, 'smoke', 'succeeded')));
    }

    /** The loop's one decision. Public for the specs; answers what it did. */
    async handle(
        evidence: ProvisioningEvidence | null,
    ): Promise<'ignored' | 'posted' | 'iterated' | 'reprovisioned' | 'exhausted'> {
        if (!evidence || !this.works || !this.taskRepository) return 'ignored';
        const work = await this.works.findById(evidence.workId);
        if (!work) return 'ignored';
        const task = await this.latestProvisionTask(work);
        if (!task) return 'ignored';

        const open = OPEN.includes(task.status);
        // A build of some other branch while the provisioning PR is still open says nothing
        // about the provisioning branch.
        if (open && evidence.branch && task.branchRef && evidence.branch !== task.branchRef) {
            return 'ignored';
        }

        if (evidence.outcome === 'succeeded') {
            if (!open) return 'ignored';
            await this.post(work, task, `✅ ${evidence.summary}`);
            return 'posted';
        }

        const attempt = attemptOf(task) + 1;
        if (attempt > MAX_PROVISION_ATTEMPTS) {
            await this.post(
                work,
                task,
                `❌ ${evidence.summary}\n\nThe provisioning loop stopped after ${MAX_PROVISION_ATTEMPTS} follow-up ` +
                    'iterations. A person needs to look at this repository before trying again.',
            );
            return 'exhausted';
        }

        if (open) {
            await this.post(
                work,
                task,
                `❌ ${evidence.summary}\n\nFollow-up iteration ${attempt} of ${MAX_PROVISION_ATTEMPTS}: read the ` +
                    'failure, fix `.works/works.yml` (or `.works/overlay/**`) on this branch, and say what you changed.',
            );
            await this.label(work, task, attempt);
            if (task.agentId && this.tasks) {
                try {
                    await this.tasks.runTask(
                        work.userId,
                        task.id,
                        { agentId: task.agentId },
                        ownershipScopeOf(work),
                    );
                } catch (error) {
                    // RUN_ALREADY_IN_FLIGHT included: the live run reads the new comment.
                    this.logger.log(
                        `Provisioning follow-up for Task ${task.id} not dispatched (${errorText(error)}).`,
                    );
                }
            }
            return 'iterated';
        }

        // Delivered (merged) — a new provisioning Task carries the chain forward.
        if (!this.provisioning) return 'ignored';
        const result = await this.provisioning.start({
            workId: work.id,
            trigger: 'build-failed',
            restart: true,
            attempt,
            note:
                `${evidence.summary} The App spec merged from Task ${task.slug} (/tasks/${task.id}) does not work yet; ` +
                `this is follow-up iteration ${attempt} of ${MAX_PROVISION_ATTEMPTS}.`,
        });
        return result.started ? 'reprovisioned' : 'ignored';
    }

    private async latestProvisionTask(work: Work): Promise<Task | null> {
        const { rows } = await this.taskRepository!.findByUserIdFiltered(
            work.userId,
            { workId: work.id, label: PROVISION_LABEL, limit: 10 },
            ownershipScopeOf(work),
        );
        const now = Date.now();
        return (
            [...rows]
                .filter((task) => task.status !== TaskStatus.CANCELLED)
                .filter(
                    (task) => now - timeOf(task.updatedAt ?? task.createdAt) <= RELEVANT_WINDOW_MS,
                )
                .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt))[0] ?? null
        );
    }

    private async post(work: Work, task: Task, body: string): Promise<void> {
        if (!this.chat) return;
        try {
            await this.chat.post(
                work.userId,
                { taskId: task.id, authorType: 'user', authorId: work.userId, body },
                {},
                ownershipScopeOf(work),
            );
        } catch (error) {
            this.logger.warn(
                `Posting provisioning feedback on Task ${task.id} failed (${errorText(error)}).`,
            );
        }
    }

    private async label(work: Work, task: Task, attempt: number): Promise<void> {
        if (!this.tasks) return;
        const labels = [
            ...(task.labels ?? []).filter(
                (label) => !label.startsWith(PROVISION_ATTEMPT_LABEL_PREFIX),
            ),
            `${PROVISION_ATTEMPT_LABEL_PREFIX}${attempt}`,
        ];
        try {
            await this.tasks.update(work.userId, task.id, { labels }, ownershipScopeOf(work));
        } catch (error) {
            this.logger.warn(
                `Counting provisioning attempt ${attempt} on Task ${task.id} failed (${errorText(error)}).`,
            );
        }
    }

    private async safely(run: () => Promise<unknown>): Promise<void> {
        try {
            await run();
        } catch (error) {
            this.logger.warn(`Provisioning feedback failed (${errorText(error)}).`);
        }
    }
}

/** The iteration a provisioning Task is on (0 for the first run). */
export function attemptOf(task: Pick<Task, 'labels'>): number {
    let max = 0;
    for (const label of task.labels ?? []) {
        if (!label.startsWith(PROVISION_ATTEMPT_LABEL_PREFIX)) continue;
        const n = Number.parseInt(label.slice(PROVISION_ATTEMPT_LABEL_PREFIX.length), 10);
        if (Number.isInteger(n) && n > max) max = n;
    }
    return max;
}

export function buildEvidence(
    payload: AppBuildEventPayload | undefined,
    outcome: 'failed' | 'succeeded',
): ProvisioningEvidence | null {
    if (!payload?.workId) return null;
    const where = `${payload.branch ? `branch \`${payload.branch}\`` : 'the default branch'}${
        payload.commitSha ? ` at \`${payload.commitSha.slice(0, 12)}\`` : ''
    }`;
    const summary =
        outcome === 'succeeded'
            ? `Build #${payload.number} succeeded on ${where}${
                  payload.deployable
                      ? ' and is deployable'
                      : payload.notDeployableReason
                        ? ` but is not deployable (${payload.notDeployableReason})`
                        : ''
              }.`
            : `Build #${payload.number} failed on ${where}${payload.failureClass ? ` (failure class: ${payload.failureClass})` : ''}. ` +
              `The build log is on the Work's Builds tab (/works/${payload.workId}/builds).`;
    return {
        workId: payload.workId,
        outcome,
        stage: 'build',
        branch: payload.branch || null,
        summary,
    };
}

export function runtimeEvidence(
    event: unknown,
    stage: 'deploy' | 'smoke',
    outcome: 'failed' | 'succeeded',
): ProvisioningEvidence | null {
    const raw = (event ?? {}) as { payload?: RuntimeEventPayload } & RuntimeEventPayload;
    const payload: RuntimeEventPayload = raw.payload ?? raw;
    if (!payload?.workId) return null;
    const code = payload.code ?? payload.reason ?? null;
    const what = stage === 'deploy' ? 'The deployment' : 'The smoke tests';
    const summary =
        outcome === 'succeeded'
            ? `${what} passed${payload.deploymentId ? ` (deployment ${payload.deploymentId})` : ''}.`
            : `${what} failed${code ? ` (${code})` : ''}${payload.deploymentId ? ` for deployment ${payload.deploymentId}` : ''}. ` +
              `The details are on the Work's Deploy tab (/works/${payload.workId}/deploy).`;
    return { workId: payload.workId, outcome, stage, branch: null, summary };
}

function timeOf(value: Date | string | null | undefined): number {
    if (!value) return 0;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
