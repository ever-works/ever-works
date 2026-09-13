import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { NodeAgentProfileView } from '@ever-works/contracts';
import { NodeAgentProfile } from '../entities/node-agent-profile.entity';
import { FleetAuditService } from '../fleet/fleet-audit.service';
import { FleetJobRepository } from '../fleet/fleet-job.repository';
import { FleetNodeRepository } from '../fleet/fleet-node.repository';
import { computerAuditDetails } from './computer-audit';
import { NodeAgentProfileRepository } from './node-agent-profile.repository';

/** The Agent a profile belongs to, as the caller already resolved it (ownership checked). */
export interface ComputerAgentRef {
    id: string;
    name: string;
    organizationId: string | null;
}

export type ResetNodeAgentProfileOutcome =
    | { reset: NodeAgentProfileView }
    | { refused: 'node-not-found' | 'profile-not-found' | 'name-mismatch' | 'run-live' };

/**
 * Agent computers — each Agent's own logins and files on each Node.
 *
 * The platform half of per-Agent isolation: one opaque profile key per
 * (Node, Agent), minted lazily the first time the Agent's computer is opened
 * on that machine and handed to the node with every live view. The node
 * maps the key to a directory of its own; nothing here ever holds a path.
 *
 * A reset ROTATES the key rather than deleting the row: the history (when it
 * was created, when it was last reset and by whom) is exactly what the
 * isolation panel shows, and a fresh key is how the machine learns that the
 * directory it holds for that Agent must be wiped before it is used again.
 */
@Injectable()
export class NodeAgentProfileService {
    private readonly logger = new Logger(NodeAgentProfileService.name);

    constructor(
        private readonly profiles: NodeAgentProfileRepository,
        private readonly nodes: FleetNodeRepository,
        private readonly jobs: FleetJobRepository,
        @Optional() private readonly audit?: FleetAuditService,
    ) {}

    /** The profile for (Node, Agent), created on first use. */
    async ensure(input: {
        userId: string;
        organizationId: string | null;
        nodeId: string;
        agentId: string;
    }): Promise<NodeAgentProfile> {
        const existing = await this.profiles.findForNodeAgent(input.nodeId, input.agentId);
        if (existing) return existing;
        try {
            return await this.profiles.create({
                userId: input.userId,
                organizationId: input.organizationId,
                nodeId: input.nodeId,
                agentId: input.agentId,
                profileKey: mintProfileKey(),
            });
        } catch (error) {
            // A concurrent open created it first — the unique index is the
            // arbiter, and the winner's row is the one both callers use.
            const raced = await this.profiles.findForNodeAgent(input.nodeId, input.agentId);
            if (raced) return raced;
            throw error;
        }
    }

    /** The isolation panel's read. Null when the Agent never opened its computer on that machine. */
    async getView(
        userId: string,
        nodeId: string,
        agentId: string,
    ): Promise<NodeAgentProfileView | null> {
        const row = await this.profiles.findForNodeAgent(nodeId, agentId);
        return row && row.userId === userId ? toProfileView(row) : null;
    }

    /** The node's report of what the profile holds. False when the key is stale or unknown. */
    async recordSelfReport(input: {
        nodeId: string;
        agentId: string;
        profileKey: string;
        signedInSiteCount: number;
        diskBytes: number;
    }): Promise<boolean> {
        return this.profiles.recordUsage(input.nodeId, input.agentId, input.profileKey, {
            signedInSiteCount: clampCount(input.signedInSiteCount, 100_000),
            diskBytes: clampCount(input.diskBytes, 2 ** 50),
            lastUsedAt: new Date(),
        });
    }

    /**
     * Reset one Agent's logins and files on one Node.
     *
     * Refused, by value: when the typed name does not match the Agent's
     * name, when the Node is not the caller's, when there is nothing to
     * reset, and — the one that protects work — while a job for that Agent
     * is live on that Node. A reset never lands under a running Run.
     */
    async reset(input: {
        userId: string;
        agent: ComputerAgentRef;
        nodeId: string;
        confirmAgentName: string;
    }): Promise<ResetNodeAgentProfileOutcome> {
        if (
            typeof input.confirmAgentName !== 'string' ||
            input.confirmAgentName.trim() !== input.agent.name.trim()
        ) {
            return { refused: 'name-mismatch' };
        }
        const node = await this.nodes.findById(input.nodeId);
        if (!node || node.userId !== input.userId) {
            return { refused: 'node-not-found' };
        }
        const row = await this.profiles.findForNodeAgent(input.nodeId, input.agent.id);
        if (!row || row.userId !== input.userId) {
            return { refused: 'profile-not-found' };
        }
        if (await this.hasLiveJob(input.userId, input.nodeId, input.agent.id)) {
            return { refused: 'run-live' };
        }

        const before = toCount(row.signedInSiteCount);
        const previousRef = toProfileRef(row.profileKey);
        const patch = {
            profileKey: mintProfileKey(),
            signedInSiteCount: 0,
            diskBytes: 0,
            lastResetAt: new Date(),
            lastResetByUserId: input.userId,
        };
        if (!(await this.profiles.reset(row.id, row.profileKey, patch))) {
            // Someone else reset it between the read and the write; theirs stands.
            const current = await this.profiles.findForNodeAgent(input.nodeId, input.agent.id);
            return current ? { reset: toProfileView(current) } : { refused: 'profile-not-found' };
        }
        await this.audit?.tryRecord({
            action: 'computer.profile-reset',
            actorUserId: input.userId,
            ownerUserId: node.userId,
            nodeId: node.id,
            details: computerAuditDetails('computer.profile-reset', {
                agentId: input.agent.id,
                profileRef: previousRef,
                signedInSiteCountBefore: before,
            }),
        });
        return { reset: toProfileView({ ...row, ...patch } as NodeAgentProfile) };
    }

    private async hasLiveJob(userId: string, nodeId: string, agentId: string): Promise<boolean> {
        try {
            const active = await this.jobs.findActiveForUser(userId);
            return active.some(
                (job) =>
                    job.nodeId === nodeId &&
                    job.kind !== 'computer-session' &&
                    (job.payload as Record<string, unknown> | null)?.agentId === agentId,
            );
        } catch (error) {
            // Fail closed: if we cannot tell whether a Run is live, do not reset under it.
            this.logger.warn(
                `profile reset refused for agent ${agentId} on node ${nodeId}: live-job check failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return true;
        }
    }
}

/**
 * A short display reference for a profile — never the key the node
 * resolves, so a screenshot of the isolation panel or an audit row cannot
 * be replayed as that Agent's profile.
 */
export function toProfileRef(profileKey: string): string {
    return typeof profileKey === 'string' ? profileKey.slice(0, 8) : '';
}

function mintProfileKey(): string {
    return randomBytes(16).toString('hex');
}

function toCount(value: string | number | null | undefined): number {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function clampCount(value: unknown, max: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(Math.trunc(value), 0), max)
        : 0;
}

export function toProfileView(row: NodeAgentProfile): NodeAgentProfileView {
    const iso = (value?: Date | null) => (value ? new Date(value).toISOString() : null);
    return {
        nodeId: row.nodeId,
        agentId: row.agentId,
        profileRef: toProfileRef(row.profileKey),
        createdAt: iso(row.createdAt),
        lastUsedAt: iso(row.lastUsedAt),
        signedInSiteCount: toCount(row.signedInSiteCount),
        diskBytes: toCount(row.diskBytes),
        lastResetAt: iso(row.lastResetAt),
    };
}
