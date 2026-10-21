import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { isFleetToolError } from '@ever-works/contracts';
import { AgentActionProposalDecidedEvent } from '../agent-approvals/agent-action-proposal-decided.event';
import { AgentRepository } from '../database/repositories/agent.repository';
import { INBOX_PRODUCER, type InboxProducer } from '../inbox/inbox-producer.port';
import {
    fleetHeldCallConfirmFields,
    heldFleetToolEntry,
    isFleetHeldCallPayload,
    isFleetHeldCallStale,
    type FleetHeldToolCallPayload,
} from '../fleet/fleet-held-call';
import { AgentToolService } from './agent-tool.service';
import { RUN_KILL_SWITCH, type RunKillSwitch } from './run-kill-switch';

/**
 * FL-19 P2 (spec S3, U12; CONTRACTS R-33) — runs a held fleet act once a
 * PERSON approves its Decision in My Decisions.
 *
 * The run loop filed a `fleet-tool-call` proposal when the trust ladder held a
 * state-changing fleet tool (`fleet-held-call.ts`). On approval this listener
 * re-runs exactly that call:
 *
 *  - only a person's approval acts (a guardrail decision has no
 *    `decidedById`; a rejection does nothing — the row is the record);
 *  - a payload that names another Agent, a tool that is not a catalogued fleet
 *    act, or an approval more than 24 h after the hold (spec U12 default) runs
 *    nothing — the owner is told the Agent must ask again;
 *  - the fleet stop switch still wins (it is checked again now, not at hold time);
 *  - the call goes through the Agent's OWN assembled tools
 *    (`resolveGrantedTools`), so a tool grant revoked since the hold, a family
 *    switched off, or a computer whose audience no longer includes the owner
 *    refuses it here exactly as it would in a run; the family service audits
 *    it as `agent:<id>`;
 *  - the approval supplies the confirmation (`confirm`, the blast-radius
 *    acknowledgement; a typed `confirmName` only if the Agent sent one).
 *
 * Best-effort like every listener of this event: nothing is thrown back into
 * the request that decided, and an approved act that did not happen always
 * files an Inbox notice — an approval never fails silently.
 */
@Injectable()
export class FleetHeldCallListener {
    private readonly logger = new Logger(FleetHeldCallListener.name);

    constructor(
        private readonly agents: AgentRepository,
        private readonly tools: AgentToolService,
        @Optional() @Inject(RUN_KILL_SWITCH) private readonly killSwitch?: RunKillSwitch,
        @Optional() @Inject(INBOX_PRODUCER) private readonly inbox?: InboxProducer,
    ) {}

    @OnEvent(AgentActionProposalDecidedEvent.EVENT_NAME, { async: true })
    async handleProposalDecided(event: AgentActionProposalDecidedEvent): Promise<void> {
        if (event.actionType !== 'other' || event.status !== 'approved') return;
        if (event.decidedVia !== 'user' || !event.decidedById) return;
        if (!isFleetHeldCallPayload(event.payload)) return;
        const payload = event.payload as FleetHeldToolCallPayload;
        try {
            await this.run(event, payload);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Approved fleet call ${event.proposalId} (${payload.tool}) did not run: ${reason}`);
            await this.notice(event, payload, reason);
        }
    }

    private async run(event: AgentActionProposalDecidedEvent, payload: FleetHeldToolCallPayload): Promise<void> {
        if (payload.agentId !== event.agentId) throw new Error('the Decision names another Agent.');
        const entry = heldFleetToolEntry(payload.tool);
        if (!entry) throw new Error(`${payload.tool} is not a fleet act this platform runs.`);
        if (isFleetHeldCallStale(payload)) {
            throw new Error(
                'it was approved more than 24 hours after the Agent asked, so nothing ran; the Agent must ask again.',
            );
        }
        if (this.killSwitch && (await this.killSwitch.shouldHaltDispatch().catch(() => true))) {
            throw new Error('all computers are stopped; clear it under Settings → Fleet and ask the Agent again.');
        }
        const agent = await this.agents.findById(event.agentId);
        if (!agent || agent.userId !== event.userId) throw new Error('the Agent no longer exists.');
        const { tools } = await this.tools.resolveGrantedTools(agent, {
            runId: payload.runId ?? 'no-run',
            editsThisRunByFile: new Set(),
        });
        const tool = tools.find((candidate) => candidate.name === entry.name);
        if (!tool) {
            throw new Error(
                `${entry.name} is not available to this Agent any more (its tool grant, or the family switched off).`,
            );
        }
        const result = await tool.invoke({ ...payload.args, ...fleetHeldCallConfirmFields(payload) });
        if (isFleetToolError(result)) {
            throw new Error(`${result.error.code}: ${result.error.hint}`);
        }
        if (result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string') {
            throw new Error(String((result as { error: string }).error));
        }
        this.logger.log(`Approved fleet call ${event.proposalId} (${entry.name}) ran for Agent ${event.agentId}`);
    }

    private async notice(
        event: AgentActionProposalDecidedEvent,
        payload: FleetHeldToolCallPayload,
        reason: string,
    ): Promise<void> {
        if (!this.inbox) return;
        try {
            await this.inbox.notice(event.userId, {
                title: 'An approved computer action did NOT run',
                body: `You approved "${payload.summary}", but it did not run: ${reason.slice(0, 300)}`,
                agentId: event.agentId,
            });
        } catch (error) {
            this.logger.warn(
                `Not-run notice for fleet call ${event.proposalId} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
