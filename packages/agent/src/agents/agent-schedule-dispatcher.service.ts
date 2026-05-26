import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { AgentStatus } from '../entities/agent.entity';
import type { Agent } from '../entities/agent.entity';
import { computeNextHeartbeat } from './heartbeat-cron';

export interface AgentDispatchEntry {
    agentId: string;
    scope: string;
    scheduledFor: string | null;
    outcome: 'dispatched' | 'skipped' | 'failed';
    message?: string;
    runId?: string;
}

export interface AgentDispatchSummary {
    limit: number;
    dueCount: number;
    dispatched: number;
    skipped: number;
    failed: number;
    recoveredStuck: number;
    entries: AgentDispatchEntry[];
}

/**
 * Side-effecting dispatcher contract injected at construction so the
 * service stays decoupled from `@ever-works/tasks`. The Trigger.dev
 * task wrapper supplies a real implementation that enqueues
 * `agent-heartbeat`; unit tests stub a synchronous one. Returns a
 * stable identifier (e.g. the Trigger.dev run handle) for the
 * dispatched run.
 */
export interface AgentHeartbeatTrigger {
    enqueue(payload: {
        agentId: string;
        userId: string;
        scheduledFor: Date;
    }): Promise<{ runId: string }>;
}

export const AGENT_HEARTBEAT_TRIGGER = 'AGENT_HEARTBEAT_TRIGGER' as const;

/**
 * Agents/Skills/Tasks PR #1017 — Phase 6.2.
 *
 * Heartbeat dispatcher. Mirrors `WorkScheduleDispatcherService.dispatchDue`
 * — finds due Agents, atomically claims each one via
 * `AgentRepository.tryClaimForRun`, and hands them to the heartbeat
 * trigger. The CAS guard is what stops two concurrent dispatcher
 * invocations from racing the same Agent into a double-run.
 *
 * Stuck-running recovery (Agents whose RUNNING claim never released
 * because the worker died mid-run) happens at the top of each call
 * — older than `AGENT_STUCK_TIMEOUT_MINUTES`, status reset to
 * ACTIVE, nextHeartbeatAt computed fresh from the cadence.
 */
@Injectable()
export class AgentScheduleDispatcherService {
    private readonly logger = new Logger(AgentScheduleDispatcherService.name);

    constructor(
        private readonly agentRepository: AgentRepository,
        private readonly agentRunRepository: AgentRunRepository,
    ) {}

    /**
     * Caller is the Trigger.dev cron wrapper, which knows how to enqueue
     * downstream `agent-heartbeat` runs. Passing the trigger in keeps
     * this package free of a `@trigger.dev/sdk` runtime dependency.
     */
    async dispatchDue(
        trigger: AgentHeartbeatTrigger,
        limit = config.agents.getMaxBatch(),
    ): Promise<AgentDispatchSummary> {
        if (!config.agents.dispatcherEnabled()) {
            this.logger.warn(
                'Agent dispatcher disabled (AGENTS_DISPATCHER_ENABLED=false), skipping',
            );
            return {
                limit,
                dueCount: 0,
                dispatched: 0,
                skipped: 0,
                failed: 0,
                recoveredStuck: 0,
                entries: [],
            };
        }

        const recoveredStuck = await this.recoverStuckRunning();

        const due = await this.agentRepository.findDueForHeartbeat(limit);
        const summary: AgentDispatchSummary = {
            limit,
            dueCount: due.length,
            dispatched: 0,
            skipped: 0,
            failed: 0,
            recoveredStuck,
            entries: [],
        };

        for (const agent of due) {
            // Review-fix C11: track whether the CAS-claim succeeded so a
            // failure between claim and enqueue can release the Agent
            // back to ACTIVE instead of leaving it stuck in RUNNING
            // for ~30 min until the stuck-recovery sweeper picks it up.
            let originalNext: Date | null = null;
            let enqueueSucceeded = false;
            try {
                originalNext = await this.agentRepository.tryClaimForRun(agent.id);
                if (!originalNext) {
                    this.logger.warn(
                        `Agent ${agent.id} was already claimed by another dispatcher worker — skipping`,
                    );
                    summary.skipped += 1;
                    summary.entries.push(
                        this.entry(agent, { outcome: 'skipped', message: 'already claimed' }),
                    );
                    continue;
                }

                // Persist a queued run row up-front so the heartbeat worker
                // can find it via `findInFlightForTaskAgent` (chat-dedup) and
                // so the Activity tab shows the run before the worker boots.
                const run = await this.agentRunRepository.createQueued({
                    agentId: agent.id,
                    userId: agent.userId,
                    triggerKind: 'heartbeat',
                });

                const handle = await trigger.enqueue({
                    agentId: agent.id,
                    userId: agent.userId,
                    scheduledFor: originalNext,
                });
                enqueueSucceeded = true;

                summary.dispatched += 1;
                summary.entries.push(
                    this.entry(agent, {
                        outcome: 'dispatched',
                        runId: run?.id ?? handle.runId,
                    }),
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(
                    `Failed to dispatch Agent ${agent.id}: ${message}`,
                    error as Error,
                );
                summary.failed += 1;
                summary.entries.push(this.entry(agent, { outcome: 'failed', message }));
                // Review-fix C11: release the CAS claim so the Agent
                // returns to ACTIVE immediately. Without this the row
                // stays in RUNNING with no worker until the next
                // stuck-recovery sweep.
                if (originalNext && !enqueueSucceeded) {
                    try {
                        await this.agentRepository.releaseAfterRun(
                            agent.id,
                            originalNext,
                            'dispatch-failed',
                        );
                    } catch (releaseErr) {
                        this.logger.warn(
                            `Failed to release CAS claim for ${agent.id} after dispatch failure: ${releaseErr}`,
                        );
                    }
                }
            }
        }

        return summary;
    }

    /**
     * Sweep Agents that are stuck in RUNNING past the stuck-timeout
     * window and reset them to ACTIVE with a fresh nextHeartbeatAt
     * computed from their cadence. The worker may have died mid-run;
     * leaving the row in RUNNING forever would make it invisible to
     * the dispatcher.
     */
    private async recoverStuckRunning(): Promise<number> {
        const stuckTimeoutMinutes = config.agents.getStuckTimeoutMinutes();
        const cutoff = new Date(Date.now() - stuckTimeoutMinutes * 60_000);
        const stuck = await this.agentRepository.findStuckRunning(cutoff);
        let count = 0;
        for (const agent of stuck) {
            const next = computeNextHeartbeat(agent.heartbeatCadence);
            await this.agentRepository.updateById(agent.id, {
                status: AgentStatus.ACTIVE,
                nextHeartbeatAt: next,
                lastRunStatus: 'recovered-stuck',
            });
            count += 1;
        }
        if (count > 0) {
            this.logger.warn(`Recovered ${count} stuck-running Agent(s)`);
        }
        return count;
    }

    private entry(
        agent: Agent,
        details: Pick<AgentDispatchEntry, 'outcome' | 'message' | 'runId'>,
    ): AgentDispatchEntry {
        return {
            agentId: agent.id,
            scope: agent.scope,
            scheduledFor: agent.nextHeartbeatAt?.toISOString() ?? null,
            outcome: details.outcome,
            message: details.message,
            runId: details.runId,
        };
    }
}
