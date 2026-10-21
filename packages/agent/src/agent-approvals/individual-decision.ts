import type { AgentActionProposal } from '../entities/agent-action-proposal.entity';
import {
    AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND,
    AGENT_FILE_EDIT_PROPOSAL_KIND,
} from '../agents/agent-proposal-kinds';

/**
 * Proposals whose approval does something that cannot be undone, so bulk
 * approval never decides them: a merge onto a real branch, the release of a
 * held Agent email draft (AW-05), and — prompt-injection hardening — an
 * agent's rewrite of its own trusted identity files and an agent-proposed
 * closure of one of the owner's escalations. Those last two exist precisely
 * so a PERSON reads them; "approve all" would make the gate a formality.
 *
 * A LEAF module (type-only entity import, constants from a leaf file) so the
 * integration API's inbox relay can apply the same rule without pulling in the
 * approval service's runtime graph. Re-exported from `agent-approvals.service`
 * for every existing importer.
 */
export function requiresIndividualDecision(
    row: Pick<AgentActionProposal, 'actionType' | 'payload'>,
): boolean {
    if (row.actionType === 'merge_pull_request') return true;
    if (row.actionType === 'send_message' && row.payload?.kind === 'email-draft') return true;
    return (
        row.actionType === 'other' &&
        (row.payload?.kind === AGENT_FILE_EDIT_PROPOSAL_KIND ||
            row.payload?.kind === AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND)
    );
}
