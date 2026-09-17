import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    AgentEscalationRepository,
    AgentRunRepository,
    AGENT_NOTES_PREVIEW,
    buildAgentStatus,
    QUEUED_REASON_AGENT_PAUSED,
    type AgentNotesPreview,
    type AgentDto,
} from '@ever-works/agent/agents';
import { AgentApprovalsService } from '@ever-works/agent/agent-approvals';
import {
    AGENT_HELD_WORK_PAGE_SIZE,
    type AgentHeldWorkDto,
    type AgentHeldWorkItemDto,
    type AgentIdentityDto,
    type AgentStatusDto,
} from '@ever-works/contracts';
import type { AgentRun } from '@ever-works/agent/entities';

/**
 * The columns the status half is derived from.
 *
 * Structural on purpose: the full `AgentDto` the card is built from and
 * the narrow row the batched roster read selects both satisfy it, so
 * ONE resolver serves both and the two can never tell different stories
 * about the same agent.
 */
export interface AgentStatusSource {
    id: string;
    status: string;
    haltReason?: string | null;
    haltNote?: string | null;
    haltedAt?: Date | null;
    haltedRunId?: string | null;
    haltDetail?: { subjectLabel?: string } | null;
    haltRepeatCount?: number | null;
    errorCount?: number | null;
    lastRunAt?: Date | null;
    nextHeartbeatAt?: Date | null;
}

/**
 * AW-23 — composes the ONE payload the identity card paints from.
 *
 * FR-8 is the whole reason this service exists: the card must render
 * completely from a single request. A card that fans out to four
 * endpoints paints in four stages, and the stage where the status dot is
 * green but the reason line is still empty is precisely the "colour with
 * no sentence" this epic set out to abolish.
 *
 * Everything it composes is already stored. The status REASON is derived
 * per request by the pure resolver in `@ever-works/agent` — the same
 * function the batched roster read calls — which is what makes "the
 * compact card and the full card can never disagree" structural rather
 * than a promise.
 *
 * Every dependency below the agent itself is `@Optional()`: a card must
 * paint even where the escalation queue, the approval queue or the notes
 * store is not mounted. A missing input degrades one row, never the
 * response.
 */
@Injectable()
export class AgentIdentityService {
    private readonly logger = new Logger(AgentIdentityService.name);

    constructor(
        private readonly runs: AgentRunRepository,
        @Optional() private readonly escalations?: AgentEscalationRepository,
        @Optional() private readonly approvals?: AgentApprovalsService,
        // The memory-and-context-files work binds this; until it does the
        // Notes row renders its documented empty state. This epic adds no
        // second notes store — see `agent-notes-preview.port.ts`.
        @Optional()
        @Inject(AGENT_NOTES_PREVIEW)
        private readonly notes?: AgentNotesPreview,
    ) {}

    /**
     * The status half, on its own — used by the batched roster read,
     * where nothing else on the card is needed.
     *
     * `heldCount` and `inFlightCount` are read per agent, so the batch
     * caller passes them in rather than paying for two extra queries per
     * card it is not going to render.
     */
    buildStatus(
        agent: AgentStatusSource,
        extras: {
            inFlightRun?: AgentRun | null;
            inFlightCount?: number;
            heldCount?: number;
            openDecisionCount?: number;
            lastFailedRunId?: string | null;
        } = {},
    ): AgentStatusDto {
        const run = extras.inFlightRun ?? null;
        return buildAgentStatus(agent.id, {
            status: agent.status,
            haltReason: agent.haltReason ?? null,
            haltNote: agent.haltNote ?? null,
            haltedAt: agent.haltedAt ?? null,
            haltedRunId: agent.haltedRunId ?? null,
            haltRepeatCount: agent.haltRepeatCount ?? 0,
            // 🛑 A display name resolved through the facade the failing
            // call already went through. Never any part of a credential.
            haltSubjectLabel: agent.haltDetail?.subjectLabel ?? null,
            inFlightRunId: run?.id ?? null,
            inFlightActivity: run?.currentActivity ?? null,
            inFlightStartedAt: run?.startedAt ?? null,
            inFlightCount: extras.inFlightCount ?? (run ? 1 : 0),
            heldCount: extras.heldCount ?? 0,
            openDecisionCount: extras.openDecisionCount ?? 0,
            lastFailedRunId: extras.lastFailedRunId ?? null,
            consecutiveFailures: agent.errorCount ?? 0,
            nextHeartbeatAt: agent.nextHeartbeatAt ?? null,
            lastRunAt: agent.lastRunAt ?? null,
        });
    }

    /** Everything the full card paints, in one round trip. */
    async build(agent: AgentDto): Promise<AgentIdentityDto> {
        const [inFlightRun, inFlightCount, held, openDecisionCount, notesPreview] =
            await Promise.all([
                this.safe(() => this.runs.findNewestInFlightForAgent(agent.id), null),
                this.safe(() => this.runs.countInFlightForAgent(agent.id), 0),
                this.safe(
                    () => this.runs.listQueuedForAgent(agent.id, QUEUED_REASON_AGENT_PAUSED, 0),
                    { total: 0, items: [] as AgentRun[] },
                ),
                this.countOpenDecisions(agent),
                this.notesPreview(agent.id),
            ]);

        // Only asked for when the reason is going to need it — an agent
        // that is working has no failing run to link to.
        const lastFailedRunId =
            agent.haltedRunId ??
            (agent.errorCount > 0
                ? ((await this.safe(() => this.runs.findNewestFailedForAgent(agent.id), null))
                      ?.id ?? null)
                : null);

        const status = this.buildStatus(agent, {
            inFlightRun,
            inFlightCount,
            heldCount: held.total,
            openDecisionCount,
            lastFailedRunId,
        });

        return {
            agent: {
                id: agent.id,
                name: agent.name,
                slug: agent.slug,
                title: agent.title ?? null,
                status: agent.status,
                avatarMode: agent.avatarMode,
                avatarIcon: agent.avatarIcon ?? null,
            },
            status,
            // P1 ships the SHAPE. The four-rung ladder, its defaults and
            // its drift count are the next phase; until then every agent
            // renders "Level not set" and nothing is promoted.
            level: { value: null, driftCount: 0, readiness: null },
            notesPreview,
            // The Personality file arrives with the voice phase; the row
            // renders its empty state until then.
            personalityPreview: null,
            workingOn:
                inFlightRun && inFlightRun.status === 'running'
                    ? {
                          runId: inFlightRun.id,
                          activity: inFlightRun.currentActivity ?? null,
                          startedAt: (inFlightRun.startedAt ?? inFlightRun.createdAt).toISOString(),
                      }
                    : null,
            nextRunAt: agent.nextHeartbeatAt ? agent.nextHeartbeatAt.toISOString() : null,
        };
    }

    /** What is being held for this agent, in the order a Resume releases it. */
    async listHeld(agentId: string, limit = AGENT_HELD_WORK_PAGE_SIZE): Promise<AgentHeldWorkDto> {
        const held = await this.safe(
            () => this.runs.listQueuedForAgent(agentId, QUEUED_REASON_AGENT_PAUSED, limit),
            { total: 0, items: [] as AgentRun[] },
        );
        return { total: held.total, items: held.items.map(toHeldItem) };
    }

    /**
     * Open escalations plus pending approval proposals — the two things
     * that mean "this agent is waiting on a person" (FR-15).
     *
     * Either half being unavailable degrades the count, never the card.
     */
    private async countOpenDecisions(agent: AgentDto): Promise<number> {
        const [escalations, approvals] = await Promise.all([
            this.escalations
                ? this.safe(() => this.escalations!.countOpenForAgent(agent.id, agent.userId), 0)
                : Promise.resolve(0),
            this.approvals
                ? this.safe(() => this.approvals!.countPendingForAgent(agent.userId, agent.id), 0)
                : Promise.resolve(0),
        ]);
        return escalations + approvals;
    }

    private async notesPreview(agentId: string): Promise<string | null> {
        if (!this.notes) return null;
        return this.safe(() => this.notes!.previewForAgent(agentId), null);
    }

    /**
     * Read-side fail-SOFT, the deliberate opposite of the brake's
     * fail-closed. A failed read must never blank the card or invent a
     * state — it degrades one row to its empty value and says so in the
     * log.
     */
    private async safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
        try {
            return await read();
        } catch (err) {
            this.logger.warn(`Agent identity: a read failed and was degraded: ${err}`);
            return fallback;
        }
    }
}

/**
 * Which path the held work arrived on, from the run's own trigger kind.
 *
 * `title` is the run's summary — never its error message, and never a
 * credential: a held run has not run, so it has neither.
 */
function toHeldItem(run: AgentRun): AgentHeldWorkItemDto {
    const kind: AgentHeldWorkItemDto['kind'] =
        run.triggerKind === 'chat' || run.triggerKind === 'conversation'
            ? 'chat'
            : run.triggerKind === 'task'
              ? 'task'
              : 'other';
    return {
        runId: run.id,
        kind,
        title: run.summary ?? null,
        heldAt: run.createdAt.toISOString(),
    };
}
