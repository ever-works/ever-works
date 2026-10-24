import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
    FLEET_GIT_IDENTITY_CACHE_MS,
    FLEET_GIT_IDENTITY_PER_MINUTE,
    FLEET_PUSH_CAPABILITY,
    fleetGithubNoReplyEmail,
    makeFleetLinkError,
    maskFleetGitIdentity,
    parseFleetGitIdentityReply,
    type FleetConfirmationRequiredDetails,
    type FleetGitIdentity,
    type FleetGitIdentityEmailSource,
    type FleetGitIdentitySetResult,
    type FleetLinkError,
} from '@ever-works/contracts';
import { GitHubAppInstallation } from '../../entities/github-app-installation.entity';
import { GitHubAppInstallationRepository as GitHubAppInstallationRepositoryEntity } from '../../entities/github-app-installation-repository.entity';
import { GitHubAppUserLink } from '../../entities/github-app-user-link.entity';
import { User } from '../../entities/user.entity';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetNodeRepository } from '../fleet-node.repository';
import { FleetMachineException, fleetMachineError, readFleetMachineError } from '../machine/fleet-machine.errors';
import {
    FLEET_MACHINE_NODE_PORT,
    fleetMachineCallerUserId,
    describeFleetMachineCaller,
    type FleetMachineCaller,
    type FleetMachineNodeFacts,
    type FleetMachineNodePort,
} from '../machine/fleet-machine-node.port';

/** How long one identity request waits on the machine. */
const IDENTITY_TIMEOUT_MS = 10_000;
/** The installation repositories the card names at most. */
const REPOSITORIES_SHOWN = 5;

/** The request of **Use my Ever Works identity** (CONTRACTS §2.2 class `confirm`). */
export interface FleetGitIdentitySetRequest {
    confirm?: boolean;
}

/** The identity the person would set: their display name and an email, with where it came from. */
export interface FleetGitIdentityProposal {
    name: string;
    email: string;
    emailSource: FleetGitIdentityEmailSource;
}

/**
 * Tasks on computers (FL-15 P2, spec FR-12 … FR-16) — a computer's global git
 * identity, through FL-02's `machine` channel (`git.identity`,
 * `git.setIdentity`; CONTRACTS §3.3):
 *
 *  - **read** — the `view` family; the machine's answer is kept 60 s per
 *    computer; the values are shown to the computer's OWNER only, everyone
 *    else reads set / unset (FR-13); "Ever Works can push for agents" is
 *    computed here from the `git-push` tag and the owner's GitHub App
 *    installations (the facts the push credential mint needs);
 *  - **set** — **Use my Ever Works identity**: the person's display name and
 *    their GitHub no-reply address (their account email when no GitHub
 *    account is linked, with the warning), the `commands` family, class
 *    `confirm` (`confirmation_required` naming the computer until
 *    `confirm: true`), only on the person's OWN computer (lane-log decision
 *    15), refused under the kill switch by the link's gate, then one
 *    `node.git.identity.set` audit row with the field names — never the email
 *    value (FR-15). Nothing else on the machine is written: no credential, no
 *    token, no credential helper.
 */
@Injectable()
export class FleetGitIdentityService {
    private readonly logger = new Logger(FleetGitIdentityService.name);
    private readonly cache = new Map<string, { at: number; facts: ReturnType<typeof parseFleetGitIdentityReply> }>();
    private readonly rate = new Map<string, number[]>();
    private readonly now: () => number = () => Date.now();

    constructor(
        private readonly nodes: FleetNodeRepository,
        @InjectRepository(User) private readonly users: Repository<User>,
        @InjectRepository(GitHubAppUserLink) private readonly links: Repository<GitHubAppUserLink>,
        @InjectRepository(GitHubAppInstallation) private readonly installations: Repository<GitHubAppInstallation>,
        @InjectRepository(GitHubAppInstallationRepositoryEntity)
        private readonly installationRepos: Repository<GitHubAppInstallationRepositoryEntity>,
        @Optional() @Inject(FLEET_MACHINE_NODE_PORT) private readonly node?: FleetMachineNodePort,
        @Optional() private readonly audit?: FleetAuditService,
    ) {}

    /** `GET /api/fleet/nodes/:id/git/identity`. */
    async read(nodeId: string, caller: FleetMachineCaller, options: { fresh?: boolean } = {}): Promise<FleetGitIdentity> {
        const port = this.port();
        this.consume(fleetMachineCallerUserId(caller));
        const facts = await port.authorize({
            nodeId,
            verb: 'git.identity',
            caller,
            actionFamily: 'view',
            stateChanging: false,
        });
        const cached = this.cache.get(facts.id);
        let raw = cached && !options.fresh && this.now() - cached.at < FLEET_GIT_IDENTITY_CACHE_MS ? cached.facts : null;
        if (!raw) {
            const reply = await port.request({
                nodeId: facts.id,
                verb: 'git.identity',
                caller,
                actionFamily: 'view',
                stateChanging: false,
                params: {},
                timeoutMs: IDENTITY_TIMEOUT_MS,
                awaitOperationMs: IDENTITY_TIMEOUT_MS,
            });
            if ('operationId' in reply && reply.operationId) {
                throw fleetMachineError('busy', `${facts.name} is still reading its git settings; try again in a moment`);
            }
            raw = parseFleetGitIdentityReply(reply.result);
            this.cache.set(facts.id, { at: this.now(), facts: raw });
        }
        const identity = await this.compose(facts, raw);
        return maskFleetGitIdentity(identity, facts.userId === fleetMachineCallerUserId(caller));
    }

    /** What **Use my Ever Works identity** would set for this person (the dialog's confirmation, FR-14). */
    async proposal(userId: string): Promise<FleetGitIdentityProposal> {
        const user = await this.users.findOne({ where: { id: userId } });
        const name = (user?.displayName?.trim() || user?.username?.trim() || '').slice(0, 200);
        const link = await this.links.findOne({ where: { userId } }).catch(() => null);
        const noReply = link ? fleetGithubNoReplyEmail(link.githubUserId, link.githubLogin) : null;
        const email = noReply ?? (user?.email?.trim() || '');
        if (!name) throw fleetMachineError('invalid', 'set a display name on your account first', { field: 'name' });
        if (!email) {
            throw fleetMachineError('invalid', 'connect your GitHub account or add an email to your account first', {
                field: 'email',
            });
        }
        return { name, email, emailSource: noReply ? 'github-noreply' : 'account' };
    }

    /** `POST /api/fleet/nodes/:id/git/identity` — **Use my Ever Works identity**. */
    async set(
        nodeId: string,
        caller: FleetMachineCaller,
        request: FleetGitIdentitySetRequest = {},
    ): Promise<FleetGitIdentitySetResult> {
        const port = this.port();
        const userId = fleetMachineCallerUserId(caller);
        this.consume(userId);
        const requestedBy = describeFleetMachineCaller(caller);
        let facts: FleetMachineNodeFacts;
        try {
            facts = await port.authorize({
                nodeId,
                verb: 'git.setIdentity',
                caller,
                actionFamily: 'commands',
                stateChanging: true,
                target: 'git identity',
            });
        } catch (error) {
            const refusal = readFleetMachineError(error);
            if (refusal && refusal.code !== 'not_found') {
                const owner = port.describe ? await port.describe(nodeId).catch(() => null) : null;
                await this.record(caller, nodeId, owner, { requestedBy, outcome: 'refused', code: refusal.code });
            }
            throw error;
        }
        if (facts.userId !== userId) {
            // The global identity is the computer owner's own: only they set it (lane-log decision 15).
            await this.record(caller, facts.id, facts, { requestedBy, outcome: 'refused', code: 'permission_denied' });
            throw fleetMachineError('permission_denied', `only the owner of ${facts.name} can set its git identity`);
        }
        const proposal = await this.proposal(userId);
        if (request.confirm !== true) {
            const details: FleetConfirmationRequiredDetails & Record<string, unknown> = {
                class: 'confirm',
                summary: `Set the global Git identity on ${facts.name} for every repository there?`,
                name: proposal.name,
                email: proposal.email,
                emailSource: proposal.emailSource,
            };
            throw fleetMachineError('confirmation_required', 'send confirm: true to confirm', details);
        }

        let result: unknown;
        try {
            const reply = await port.request({
                nodeId: facts.id,
                verb: 'git.setIdentity',
                caller,
                actionFamily: 'commands',
                stateChanging: true,
                target: 'git identity',
                params: { name: proposal.name, email: proposal.email },
                timeoutMs: IDENTITY_TIMEOUT_MS,
                awaitOperationMs: IDENTITY_TIMEOUT_MS,
            });
            if ('operationId' in reply && reply.operationId) {
                throw fleetMachineError('busy', `${facts.name} is still writing its git settings; look again in a moment`, {
                    operationId: reply.operationId,
                });
            }
            result = reply.result;
        } catch (error) {
            const known: FleetLinkError =
                readFleetMachineError(error) ?? makeFleetLinkError('internal', 'the computer could not be reached');
            await this.record(caller, facts.id, facts, {
                requestedBy,
                outcome: known.code === 'operation_failed' || known.code === 'internal' ? 'failed' : 'refused',
                code: known.code,
                emailSource: proposal.emailSource,
            });
            if (error instanceof FleetMachineException) throw error;
            this.logger.warn(
                `git.setIdentity on node ${facts.id} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw new FleetMachineException(known);
        }

        const record = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
        const fields = Array.isArray(record.fields)
            ? (record.fields.filter((field) => field === 'user.name' || field === 'user.email') as Array<
                  'user.name' | 'user.email'
              >)
            : (['user.name', 'user.email'] as Array<'user.name' | 'user.email'>);
        const raw = parseFleetGitIdentityReply(result);
        this.cache.set(facts.id, { at: this.now(), facts: raw });
        // FR-15: the field names, never the values.
        await this.record(caller, facts.id, facts, {
            requestedBy,
            outcome: 'ok',
            fields,
            emailSource: proposal.emailSource,
        });
        const identity = await this.compose(facts, raw);
        return { ...identity, fields, emailSource: proposal.emailSource };
    }

    /** Forget a computer's cached identity (its node reconnected, a test). */
    forget(nodeId: string): void {
        this.cache.delete(nodeId);
    }

    private async compose(
        facts: FleetMachineNodeFacts,
        raw: ReturnType<typeof parseFleetGitIdentityReply>,
    ): Promise<FleetGitIdentity> {
        return {
            nodeId: facts.id,
            name: raw.name,
            email: raw.email,
            helper: raw.helper,
            canPushForAgents: await this.canPushForAgents(facts),
            readAt: raw.readAt ?? new Date(this.now()).toISOString(),
        };
    }

    /**
     * "Ever Works can push for agents there" (spec FR-12): the computer
     * advertises the scoped push capability (`git-push`) and the owner has a
     * GitHub App installation that covers at least one repository — the facts
     * the push credential mint needs. Never throws.
     */
    private async canPushForAgents(facts: FleetMachineNodeFacts): Promise<FleetGitIdentity['canPushForAgents']> {
        try {
            const node = await this.nodes.findById(facts.id);
            if (!node || !(node.capabilities ?? []).includes(FLEET_PUSH_CAPABILITY)) {
                return { ok: false, reason: `${facts.name} cannot use scoped push credentials yet (update its node)` };
            }
            const installations = await this.installations.find({
                where: { createdByUserId: facts.userId, deletedAt: IsNull() },
            });
            const repositories: string[] = [];
            for (const installation of installations) {
                if ((installation as { suspendedAt?: Date | null }).suspendedAt) continue;
                const rows = await this.installationRepos.find({
                    where: { installationEntityId: installation.id },
                    order: { fullName: 'ASC' },
                    take: REPOSITORIES_SHOWN,
                });
                for (const row of rows) {
                    if (repositories.length < REPOSITORIES_SHOWN && !repositories.includes(row.fullName))
                        repositories.push(row.fullName);
                }
            }
            if (repositories.length === 0) {
                return { ok: false, reason: 'install the Ever Works GitHub App on a repository first' };
            }
            return { ok: true, repositories };
        } catch (error) {
            this.logger.debug(
                `Push coverage for node ${facts.id} not read: ${error instanceof Error ? error.message : String(error)}`,
            );
            return { ok: false, reason: 'the GitHub App installations could not be read' };
        }
    }

    /** Identity reads and sets per person per minute (CONTRACTS §10.1). */
    private consume(userId: string): void {
        const now = this.now();
        const recent = (this.rate.get(userId) ?? []).filter((at) => now - at < 60_000);
        if (recent.length >= FLEET_GIT_IDENTITY_PER_MINUTE) {
            throw fleetMachineError('limit_exceeded', 'too many git identity requests; wait a minute', {
                limit: FLEET_GIT_IDENTITY_PER_MINUTE,
            });
        }
        recent.push(now);
        this.rate.set(userId, recent);
    }

    private port(): FleetMachineNodePort {
        if (!this.node) throw fleetMachineError('unreachable', 'this deployment cannot reach computers');
        return this.node;
    }

    private async record(
        caller: FleetMachineCaller,
        nodeId: string,
        facts: FleetMachineNodeFacts | null,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action: 'node.git.identity.set',
            actorUserId: fleetMachineCallerUserId(caller),
            ownerUserId: facts?.userId ?? null,
            nodeId,
            details: { family: 'commands', target: 'git identity', confirmationClass: 'confirm', ...details },
        });
    }
}
