import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    fleetSessionBranchPrefix,
    proposeFleetSessionBranch,
    type FleetSessionBranchProposal,
} from '@ever-works/contracts';
import { AgentRepository } from '../../database/repositories/agent.repository';
import { User } from '../../entities/user.entity';
import { FleetCheckoutService } from '../checkouts/fleet-checkout.service';
import { fleetSessionError, readFleetSessionError } from '../sessions/fleet-session.errors';
import { FleetSessionService, type FleetSessionActor } from '../sessions/fleet-session.service';
import { FleetSessionTaskService } from '../sessions/fleet-session-task.service';

const UUID = /^[0-9a-f-]{36}$/i;

/** `GET /api/fleet/sessions/branch-proposal` query (plan §5). */
export interface FleetSessionBranchProposalQuery {
    nodeId: string;
    /** The checkout the new worktree is made of (its repository is checked for uniqueness). */
    checkoutId: string;
    /** An Agent session: the prefix is the Agent's slug. Absent: an owner session (the person's handle). */
    agentId?: string;
    firstMessage?: string;
    title?: string;
    /** A session from a Task keeps the Task's branch (spec FR-4). */
    taskId?: string;
}

/**
 * Session git & actions (FL-06) — the agent-side half that is not the
 * checkout's own (FL-14 owns `fleet_checkouts`, FL-04 owns `fleet_sessions`):
 *
 *  - **the branch rule** for a new session's worktree (spec FR-3 … FR-5, U9):
 *    `<prefix>/<slug>`, never a name the repository ever had — on the remote
 *    or on any checkout row of the same remote, the bin included — with a
 *    numeric suffix, and the Task's own branch for a session from a Task.
 *
 * Every read runs the audiences of the two services it composes: the
 * computer's `sessions` audience (the start dialog is a session act) and the
 * checkout's `view` audience.
 */
@Injectable()
export class FleetSessionGitService {
    private readonly logger = new Logger(FleetSessionGitService.name);

    constructor(
        private readonly sessions: FleetSessionService,
        private readonly checkouts: FleetCheckoutService,
        @Optional() private readonly agents?: AgentRepository,
        @Optional() private readonly taskRules?: FleetSessionTaskService,
        @Optional() @InjectRepository(User) private readonly users?: Repository<User>,
    ) {}

    /**
     * Propose the branch of a new session's worktree (spec S1, FR-3 … FR-5,
     * U9). Refusals: the computer (404 / `permission_denied`), the checkout
     * not on that computer (`invalid`), an Agent that is not the person's
     * (404). The remote's branch names are read when the computer can be
     * asked; when it cannot, the rows alone are checked and `remoteChecked`
     * says so (the node's create checks the remote once more).
     */
    async branchProposal(
        actor: FleetSessionActor,
        query: FleetSessionBranchProposalQuery,
    ): Promise<FleetSessionBranchProposal> {
        const { node } = await this.sessions.nodeFor(query.nodeId, actor);
        if (typeof query.checkoutId !== 'string' || !UUID.test(query.checkoutId)) {
            throw fleetSessionError('invalid', 'checkoutId', { field: 'checkoutId' });
        }
        let used: Awaited<ReturnType<FleetCheckoutService['takenBranchNames']>>;
        try {
            used = await this.checkouts.takenBranchNames(query.checkoutId, { userId: actor.userId });
        } catch (error) {
            const typed = readFleetSessionError(error);
            if (typed) throw fleetSessionError(typed.code, typed.hint, typed.details);
            throw error;
        }
        if (used.checkout.nodeId !== node.id) {
            throw fleetSessionError('invalid', `that checkout is not on ${node.name}`, { field: 'checkoutId' });
        }

        let prefix = 'session';
        let organizationId: string | null = null;
        const agentId = actor.agentId ?? query.agentId;
        if (agentId) {
            const agent = this.agents && UUID.test(agentId) ? await this.agents.findById(agentId) : null;
            if (!agent || agent.userId !== actor.userId) throw fleetSessionError('not_found', 'no such Agent');
            prefix = fleetSessionBranchPrefix(agent.slug || agent.name);
            organizationId = agent.organizationId ?? null;
        } else {
            prefix = fleetSessionBranchPrefix(await this.handleOf(actor.userId));
        }

        let taskBranch: string | null = null;
        if (query.taskId && this.taskRules) {
            const task = await this.taskRules.branchFor(actor.userId, query.taskId, organizationId);
            if (!task) throw fleetSessionError('not_found', 'no such Task', { field: 'taskId' });
            taskBranch = task.branch;
        }

        const proposal = proposeFleetSessionBranch({
            prefix,
            taskBranch,
            firstMessage: query.firstMessage ?? null,
            title: query.title ?? null,
            taken: used.taken,
        });
        const repository = used.checkout.repository;
        const where = repository ?? 'this repository';
        proposal.reason =
            proposal.source === 'task'
                ? 'the Task’s own branch'
                : proposal.suffixed
                  ? `${proposal.base} exists — using ${proposal.branch}`
                  : `never used before on ${where}`;
        proposal.repository = repository;
        proposal.remoteChecked = used.remoteChecked;
        return proposal;
    }

    /** The person's account handle (the owner-session prefix, spec §8b default). */
    private async handleOf(userId: string): Promise<string> {
        if (!this.users) return 'session';
        try {
            const user = await this.users.findOne({ where: { id: userId }, select: ['id', 'username'] });
            return user?.username || 'session';
        } catch (error) {
            this.logger.debug(
                `The handle of user ${userId} could not be read: ${error instanceof Error ? error.message : String(error)}`,
            );
            return 'session';
        }
    }
}
