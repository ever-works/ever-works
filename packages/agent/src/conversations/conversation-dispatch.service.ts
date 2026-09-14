import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { ownershipRelationScopeOf, type OwnershipScope } from '../database/ownership-scope';
import type { Conversation } from '../entities/conversation.entity';
import type { ConversationMessage } from '../entities/conversation-message.entity';
import { RunDispatchGateService } from '../agents/run-dispatch-gate.service';
import { RUN_STEERING_PORT, type RunSteeringPort } from '../tasks-domain/run-steering-port';
import { JOB_RUNTIME_NOT_CONFIGURED_REASON } from '../tasks-domain/task-dispatcher';
import {
    AGENT_CONVERSATION_REPLY_DISPATCHER,
    type AgentConversationReplyDispatcher,
} from './conversation-dispatcher';
import {
    CONVERSATION_ADDRESSABLE_AGENT_STATUSES,
    CONVERSATION_REACH_REASON_AGENT_UNAVAILABLE,
    CONVERSATION_REACH_REASON_DISPATCH_CEILING,
    CONVERSATION_REACH_REASON_DISPATCH_FAILED,
    CONVERSATION_REACH_REASON_STEERED,
    MAX_DISPATCH_PER_MESSAGE,
    type ConversationReach,
} from './conversation.types';

export interface ConversationDispatchRequest {
    conversation: Conversation;
    message: ConversationMessage;
    /** Who sent the message; every run is owned by and admitted for them. */
    userId: string;
    /** The body the Agents receive (unresolved mentions already stripped). */
    agentVisibleBody: string;
    /** Resolved Agent mentions, in first-mention order. */
    mentionedAgentIds: readonly string[];
}

/**
 * The reply contract — which Agents a message starts a reply for, and what
 * became of each.
 *
 *  - `direct` with an addressed Agent → that Agent replies to every message
 *    (FR-87). A direct Conversation with no Agent is the assistant thread,
 *    answered on its existing path, so nothing is dispatched here.
 *  - `group` / organization channel with mentions → exactly the mentioned
 *    Agents (FR-88); without mentions → every addressable participant
 *    (FR-89). Those kinds are created by later phases; the rule is stated
 *    here once so it is not re-derived per kind.
 *  - the same Agent mentioned twice → one reply (FR-91).
 *  - at most eight replies start from one message; the rest are `queued`
 *    with `dispatch-ceiling` (FR-90).
 *
 * Per Agent the outcome is one of:
 *  - `skipped` — the Agent is paused, a draft, errored or archived;
 *  - `delivered` + `steered` — it already had a live run answering this
 *    Conversation, and the message went into that run (FR-92);
 *  - `delivered` — a run was created and handed to the job runtime;
 *  - `refused` — the dispatch gate would not start the reply right now (the
 *    reason is the gate's own: `concurrency-limit`, `insufficient-credits`,
 *    `kill-switch`), no job runtime is configured, or the enqueue failed.
 *
 * Background work goes out ONLY through {@link AGENT_CONVERSATION_REPLY_DISPATCHER}
 * — this file imports no job-runtime SDK.
 *
 * A gate refusal is reported as NOT sent, never as `queued`, and parks no
 * run row: the gate's drain promotes parked runs per Work and per Task, a
 * Conversation reply has neither, so nothing would ever offer it again and
 * the person would wait for a reply that is not coming. Instead
 * `ConversationMessageService` marks the message `failed` with a failure code
 * for the reason, and Retry — the existing retry route — dispatches it again
 * through this same gate once capacity exists. This is the posture the
 * heartbeat dispatcher takes for Work-less runs, made visible to the sender.
 */
@Injectable()
export class ConversationDispatchService {
    private readonly logger = new Logger(ConversationDispatchService.name);

    constructor(
        private readonly agents: AgentRepository,
        private readonly runs: AgentRunRepository,
        @Optional()
        @Inject(AGENT_CONVERSATION_REPLY_DISPATCHER)
        private readonly dispatcher?: AgentConversationReplyDispatcher,
        @Optional()
        @Inject(RUN_STEERING_PORT)
        private readonly steering?: RunSteeringPort,
        @Optional() private readonly dispatchGate?: RunDispatchGateService,
    ) {}

    /** The Agents a message addresses, before any per-Agent outcome. */
    resolveTargets(conversation: Conversation, mentionedAgentIds: readonly string[]): string[] {
        switch (conversation.kind ?? 'direct') {
            case 'direct':
                return conversation.agentId ? [conversation.agentId] : [];
            default:
                return unique(mentionedAgentIds);
        }
    }

    async dispatch(request: ConversationDispatchRequest): Promise<ConversationReach[]> {
        const targets = this.resolveTargets(request.conversation, request.mentionedAgentIds);
        const reach: ConversationReach[] = [];
        for (const [index, agentId] of targets.entries()) {
            if (index >= MAX_DISPATCH_PER_MESSAGE) {
                reach.push({
                    agentId,
                    outcome: 'queued',
                    reason: CONVERSATION_REACH_REASON_DISPATCH_CEILING,
                });
                continue;
            }
            reach.push(await this.dispatchOne(request, agentId));
        }
        return reach;
    }

    private async dispatchOne(
        request: ConversationDispatchRequest,
        agentId: string,
    ): Promise<ConversationReach> {
        const { conversation, message, userId } = request;
        const scope = ownershipRelationScopeOf(conversation);

        let agent: Awaited<ReturnType<AgentRepository['findByIdAndUser']>>;
        try {
            agent = await this.agents.findByIdAndUser(agentId, userId, scope);
        } catch (err) {
            this.logger.warn(
                `Conversation ${conversation.id}: Agent lookup failed: ${describe(err)}`,
            );
            agent = null;
        }
        if (!agent) {
            return {
                agentId,
                outcome: 'skipped',
                reason: CONVERSATION_REACH_REASON_AGENT_UNAVAILABLE,
            };
        }
        if (!CONVERSATION_ADDRESSABLE_AGENT_STATUSES.includes(agent.status)) {
            return { agentId, outcome: 'skipped', reason: agent.status };
        }

        const steeredRunId = await this.trySteerLiveRun(request, agentId, scope);
        if (steeredRunId) {
            return {
                agentId,
                outcome: 'delivered',
                reason: CONVERSATION_REACH_REASON_STEERED,
                runId: steeredRunId,
            };
        }

        if (!this.dispatcher) {
            return { agentId, outcome: 'refused', reason: JOB_RUNTIME_NOT_CONFIGURED_REASON };
        }

        const admission = await this.admit(userId, conversation);
        if (!admission.admitted) {
            this.logger.log(
                `Conversation ${conversation.id}: reply by Agent ${agentId} not started (${admission.queuedReason}).`,
            );
            // Not sent — see the class note on why this is never `queued`.
            return {
                agentId,
                outcome: 'refused',
                reason: admission.queuedReason ?? null,
            };
        }

        let runId: string | null = null;
        try {
            const run = await this.runs.createQueued({
                agentId,
                userId,
                triggerKind: 'conversation',
                conversationMessageId: message.id,
                workId: null,
                tenantId: conversation.tenantId ?? null,
                organizationId: conversation.organizationId ?? null,
            });
            runId = run.id;
            const handle = await this.dispatcher.enqueue({
                agentId,
                userId,
                conversationId: conversation.id,
                triggeringMessageId: message.id,
                // Run-scoped: unique per reply, so a Retry (a new run) is never
                // swallowed by the runtime's idempotency, while a duplicate
                // enqueue of the SAME run still is.
                dedupKey: `conversation:${message.id}:${agentId}:${run.id}`,
                runId: run.id,
                tenantId: conversation.tenantId ?? null,
                organizationId: conversation.organizationId ?? null,
            });
            if (handle?.runId) {
                try {
                    await this.runs.setTriggerRunId(run.id, handle.runId);
                } catch (stampErr) {
                    this.logger.warn(
                        `Failed to stamp triggerRunId on AgentRun ${run.id}: ${describe(stampErr)}`,
                    );
                }
            }
            return { agentId, outcome: 'delivered', runId: run.id };
        } catch (err) {
            const notConfigured =
                err instanceof Error && err.name === 'JobRuntimeNotConfiguredError';
            const reason = notConfigured
                ? JOB_RUNTIME_NOT_CONFIGURED_REASON
                : CONVERSATION_REACH_REASON_DISPATCH_FAILED;
            this.logger.warn(
                `Conversation ${conversation.id}: reply by Agent ${agentId} could not be dispatched (${reason}): ${describe(err)}`,
            );
            if (runId) {
                try {
                    await this.runs.markDispatchFailed(runId, `${reason}: ${describe(err)}`);
                } catch (failErr) {
                    this.logger.warn(
                        `Failed to mark AgentRun ${runId} failed: ${describe(failErr)}`,
                    );
                }
            }
            return { agentId, outcome: 'refused', reason, runId };
        }
    }

    /**
     * Returns the live run's id when the message was injected into a run this
     * Agent is already executing for this Conversation; `null` for every other
     * outcome, so a steering hiccup falls through to a fresh dispatch and can
     * never swallow a message.
     */
    private async trySteerLiveRun(
        request: ConversationDispatchRequest,
        agentId: string,
        scope: OwnershipScope | undefined,
    ): Promise<string | null> {
        if (!this.steering) return null;
        try {
            const live = await this.runs.findInFlightForConversationAgent(
                request.conversation.id,
                agentId,
                request.userId,
                scope,
            );
            if (!live) return null;
            const outcome = await this.steering.steer({
                runId: live.id,
                userId: request.userId,
                message: request.agentVisibleBody,
            });
            return outcome.dispatched === 'injected' ? live.id : null;
        } catch (err) {
            this.logger.warn(
                `Conversation ${request.conversation.id}: steering Agent ${agentId} failed, starting a new run: ${describe(err)}`,
            );
            return null;
        }
    }

    /** Fail-open: a broken safety valve must never swallow a message. */
    private async admit(
        userId: string,
        conversation: Conversation,
    ): Promise<{ admitted: boolean; queuedReason?: string }> {
        if (!this.dispatchGate) return { admitted: true };
        try {
            return await this.dispatchGate.admit({
                userId,
                workId: null,
                organizationId: conversation.organizationId ?? null,
            });
        } catch (err) {
            this.logger.warn(
                `Dispatch gate admit failed for conversation ${conversation.id} — failing open: ${describe(err)}`,
            );
            return { admitted: true };
        }
    }
}

function unique(ids: readonly string[]): string[] {
    return [...new Set(ids)];
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
