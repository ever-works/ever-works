import { Injectable, Logger, Optional } from '@nestjs/common';
import { isAppWorkKind } from '@ever-works/contracts';
import { WorkRepository } from '../database/repositories/work.repository';
import { TaskStatus, type Task } from '../entities/task.entity';
import { AgentEscalationService } from '../agents/agent-escalation.service';
import { heuristicConfidence } from '../agents/escalation-confidence';
import { GitFacadeService } from '../facades/git.facade';
import { TaskTransitionService } from '../tasks-domain/task-transition.service';
import { pickOwnerRepo, requireTaskRepository } from '../tasks-domain/task-repository';
import { resolveMaxGateAttempts } from '../tasks-domain/task-gates';
import { advisoryAppCheckLegs } from '../tasks-domain/app-check-legs';
import type { TaskAppChecks, TaskAppChecksExhaustion } from '../tasks-domain/task-app-checks.port';
import { AppWorkRulesService } from './app-work-rules.service';

/**
 * APW-08 T16 (APW08-G04; FR-16, FR-17) — the App Works side of
 * `TASK_APP_CHECKS`: every App read the two shared CI services must not make
 * themselves (see `tasks-domain/task-app-checks.port.ts`).
 *
 * ## The rules are read at the PR BASE, resolved here
 *
 * Which legs are advisory comes from the App rules (`AppWorkRulesService`) at
 * the tip of the pull request's BASE branch, resolved server-side through the
 * git facade — the same rule `AppWorkChangeGateService` applies, for the same
 * reason: the branch under review is the agent's, and an agent that could
 * flip its failing check to `required: false` in the spec it is changing
 * would be judged by its own edit. No caller supplies the commit.
 *
 * ## Exhaustion is a Block and an escalation, once
 *
 * The caller (`TaskCiAutoResumeService.fileStopNotice`) has already claimed
 * the Task's one-shot stop marker, so this runs at most once per Task. The
 * escalation carries a dedup key on the Task anyway, so a second writer that
 * got past a lost marker could not raise it twice. The Block is best-effort
 * and recorded separately: a Task a person already moved (done, cancelled,
 * blocked) is left where it is, and the escalation is still raised.
 */
@Injectable()
export class TaskAppChecksService implements TaskAppChecks {
    private readonly logger = new Logger(TaskAppChecksService.name);

    constructor(
        private readonly works: WorkRepository,
        // Every collaborator below is @Optional(): an install without one
        // degrades to "nothing is advisory" / "no escalation" — the safe
        // direction for each — rather than failing to construct.
        @Optional() private readonly rules?: AppWorkRulesService,
        @Optional() private readonly git?: GitFacadeService,
        @Optional() private readonly transitions?: TaskTransitionService,
        @Optional() private readonly escalations?: AgentEscalationService,
    ) {}

    async resumeBudget(task: Task): Promise<number | null> {
        const work = await this.appWorkOf(task);
        if (!work) return null;
        // FR-17 — "up to the Work's gate-attempt budget (1–5, default 2)":
        // the platform's one resolution of that budget (Task value, else Work
        // value, else 2, clamped), so the cloud gate and the CI loop agree.
        return resolveMaxGateAttempts(task, work);
    }

    async advisoryLegs(task: Task, baseRef?: string | null): Promise<ReadonlySet<string> | null> {
        const work = await this.appWorkOf(task);
        if (!work || !this.rules || !this.git) return null;
        try {
            const { owner, repo } = pickOwnerRepo(requireTaskRepository(work, 'App check legs'));
            const branch =
                (baseRef && baseRef.trim()) ||
                (work.taskIsolationBaseBranch && work.taskIsolationBaseBranch.trim()) ||
                'main';
            const tip = await this.git.getLatestCommit(owner, repo, branch, {
                userId: task.userId,
                providerId: work.gitProvider,
                workId: work.id,
            });
            const baseSha = typeof tip?.sha === 'string' ? tip.sha.trim() : '';
            if (!baseSha) return null;
            const rules = await this.rules.resolve(
                { id: work.id, taskIsolationBaseBranch: branch },
                baseSha,
            );
            return advisoryAppCheckLegs(rules.checks);
        } catch (error) {
            // An unreadable spec classifies NOTHING as advisory: the provider's
            // roll-up then stands, which can keep a red gate red and never
            // turn it green.
            this.logger.warn(
                `Task ${task.id}: App rules at the PR base could not be read; no leg is advisory (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    async escalateExhausted(task: Task, exhaustion: TaskAppChecksExhaustion): Promise<boolean> {
        const work = await this.appWorkOf(task);
        if (!work) return false;
        await this.block(task);
        if (!this.escalations) return false;
        const name = work.name?.trim() || 'This app';
        const pr = exhaustion.prNumber ? ` #${exhaustion.prNumber}` : '';
        const attempted = [
            {
                label: 'ci',
                outcome: `a required App check stayed red after ${exhaustion.attemptsUsed} of ${exhaustion.maxAttempts} automatic attempts`,
            },
        ];
        const row = await this.escalations.record({
            userId: task.userId,
            reasonCode: 'gate-exhausted',
            summary:
                `${name}: a required App check on pull request${pr} is still red after ` +
                `${exhaustion.attemptsUsed} of ${exhaustion.maxAttempts} automatic attempts, so the Task is blocked.`,
            decisionNeeded: 'Fix the check, raise the gate-attempt budget and unblock the Task, or close it.',
            taskId: task.id,
            workId: work.id,
            agentId: task.agentId ?? null,
            attempted,
            tenantId: task.tenantId ?? null,
            organizationId: task.organizationId ?? null,
            // One per Task: the stop marker is the Task's, and so is this.
            dedupKey: `app-ci-gate-exhausted:${task.id}`,
            confidence: heuristicConfidence({ reasonCode: 'gate-exhausted', attempted }),
            confidenceSource: 'heuristic',
        });
        return Boolean(row);
    }

    /** The Task's Work when it is an App Work; `null` otherwise or when unreadable. */
    private async appWorkOf(task: Task) {
        if (!task.workId) return null;
        try {
            const work = await this.works.findById(task.workId);
            return work && isAppWorkKind(work.kind) ? work : null;
        } catch {
            return null;
        }
    }

    /**
     * FR-17 — "the Task is Blocked". Only from the two columns a pull request's
     * CI loop runs in; a Task a person already moved stays where they put it.
     */
    private async block(task: Task): Promise<void> {
        if (!this.transitions) return;
        if (task.status !== TaskStatus.IN_PROGRESS && task.status !== TaskStatus.IN_REVIEW) return;
        try {
            await this.transitions.transition(task, TaskStatus.BLOCKED, { actorType: 'agent' });
        } catch (error) {
            this.logger.warn(
                `Task ${task.id}: could not be blocked after its CI budget was spent (${
                    error instanceof Error ? error.message : String(error)
                }); the escalation is still raised.`,
            );
        }
    }
}
