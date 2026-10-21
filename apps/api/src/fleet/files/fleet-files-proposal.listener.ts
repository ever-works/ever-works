import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AgentActionProposalDecidedEvent } from '@ever-works/agent/agent-approvals';
import {
    FLEET_FILES_COPY_PROPOSAL_KIND,
    FLEET_FILES_DELETE_PROPOSAL_KIND,
} from '@ever-works/agent/fleet';
import { FleetFilesTransferService } from './fleet-files-transfer.service';
import { FleetFilesService } from './fleet-files.service';

/**
 * Files on computers (FL-11 P2, FR-37, FR-38, CONTRACTS R-33) — runs a held
 * Agent copy or delete once a PERSON approves it in My Decisions.
 *
 * `fleet_files_copy` and `fleet_files_delete` hold every call as an Agent
 * Action Approval Queue proposal (`actionType: 'other'`, the platform-written
 * `payload.kind`). This listener runs exactly what was held — re-validated by
 * the same services a person's click goes through — AS THE PERSON WHO
 * APPROVED it (their `files` audience on each computer, `--manage`, the kill
 * switch, the limits; lane log decision 18). The approval is the delete's
 * `confirm-destructive` confirmation (no typed name); a copy runs without
 * `confirm`, so a credential-shaped file inside is refused, never moved.
 *
 * Only a person's approval acts: a guardrail decision (no `decidedById`) and a
 * rejection do nothing; a payload naming another Agent is dropped with a
 * warning. Never a file name in a log line. Best-effort like every listener of
 * this event: a failure is logged, never thrown into the request that decided.
 */
@Injectable()
export class FleetFilesProposalListener {
    private readonly logger = new Logger(FleetFilesProposalListener.name);

    constructor(
        private readonly files: FleetFilesService,
        private readonly transfers: FleetFilesTransferService,
    ) {}

    @OnEvent(AgentActionProposalDecidedEvent.EVENT_NAME, { async: true })
    async handleProposalDecided(event: AgentActionProposalDecidedEvent): Promise<void> {
        if (event.actionType !== 'other' || event.status !== 'approved') return;
        if (event.decidedVia !== 'user' || !event.decidedById) return;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (
            payload.kind !== FLEET_FILES_COPY_PROPOSAL_KIND &&
            payload.kind !== FLEET_FILES_DELETE_PROPOSAL_KIND
        )
            return;
        if (payload.agentId !== event.agentId) {
            this.logger.warn(`Approved file act ${event.proposalId} names another Agent; not run`);
            return;
        }
        const caller = { kind: 'user' as const, userId: event.decidedById };
        try {
            if (payload.kind === FLEET_FILES_DELETE_PROPOSAL_KIND) {
                const result = await this.files.deleteAs(
                    caller,
                    String(payload.nodeId ?? ''),
                    { root: payload.root, path: payload.path, entries: payload.entries },
                    { approvedProposalId: event.proposalId },
                );
                this.logger.log(
                    `Approved delete ${event.proposalId} removed ${result.removed} item(s)`,
                );
                return;
            }
            const from = (payload.from ?? {}) as Record<string, unknown>;
            const to = (payload.to ?? {}) as Record<string, unknown>;
            const started = await this.transfers.copy(caller, String(from.nodeId ?? ''), {
                root: from.root,
                path: from.path,
                entries: from.entries,
                to: { nodeId: to.nodeId, root: to.root, path: to.path },
                policy: payload.replace === true ? { replaceAll: true } : {},
            });
            this.logger.log(
                `Approved copy ${event.proposalId} started as transfer ${started.transferId}`,
            );
        } catch (error) {
            this.logger.warn(
                `Approved file act ${event.proposalId} did not run: ${error instanceof Error ? error.message.split('\n', 1)[0] : String(error)}`,
            );
        }
    }
}
