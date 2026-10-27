import { Injectable, Logger, Optional } from '@nestjs/common';
import { AgentApprovalsService } from '@ever-works/agent/agent-approvals';
import {
    buildFleetHeldCallPayload,
    fleetHeldCallSubjectKey,
    type FleetHeldCallFiler,
    type FleetHeldCallInput,
} from '@ever-works/agent/fleet';

/**
 * FL-19 P2 (spec S3, FR-7; CONTRACTS R-33) — the API half of "a held fleet act
 * becomes a Decision". The run loop asks it (under `FLEET_HELD_CALL_FILER`)
 * when the AW-24 ladder holds a call; for a catalogued, state-changing fleet
 * tool it files ONE Agent Action Approval Queue proposal — `actionType:
 * 'other'`, `payload.kind: 'fleet-tool-call'`, `humanDecisionRequired` (a
 * guardrail may block it, never approve it) — and answers its id.
 *
 * De-duplicated per (Agent, tool, arguments, hour): a retry inside the hour
 * finds the pending one. Anything that is not a held fleet act (a read, an
 * unknown tool, arguments too large to keep) answers null and the hold stays a
 * plain hold.
 */
@Injectable()
export class FleetHeldCallService implements FleetHeldCallFiler {
    private readonly logger = new Logger(FleetHeldCallService.name);

    constructor(@Optional() private readonly approvals?: AgentApprovalsService) {}

    async file(input: FleetHeldCallInput): Promise<{ decisionId: string } | null> {
        if (!this.approvals) return null;
        const payload = buildFleetHeldCallPayload(input);
        if (!payload) return null;
        const subjectKey = fleetHeldCallSubjectKey(payload);
        try {
            const proposal = await this.approvals.createProposal(input.userId, {
                agentId: input.agentId,
                actionType: 'other',
                title: payload.summary,
                runId: input.runId,
                payload: { ...payload },
                humanDecisionRequired: true,
                subjectKey,
            });
            return { decisionId: proposal.id };
        } catch (error) {
            // The (actionType, subjectKey) index refused a second proposal: hand back the
            // pending one; a decided one (or any other failure) keeps the plain hold.
            const existing = await this.approvals
                .findBySubjectKey(input.userId, 'other', subjectKey)
                .catch(() => null);
            if (existing && existing.status === 'pending') return { decisionId: existing.id };
            this.logger.warn(
                `Held fleet call ${payload.tool} for Agent ${input.agentId} filed no Decision: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }
}
