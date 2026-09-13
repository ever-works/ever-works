import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { NodeAgentProfileView } from '@ever-works/contracts';
import { NodeAgentProfile } from '../entities/node-agent-profile.entity';
import { FleetAuditService } from '../fleet/fleet-audit.service';
import { FleetJobRepository } from '../fleet/fleet-job.repository';
import { FleetNodeRepository } from '../fleet/fleet-node.repository';
import { computerAuditDetails } from './computer-audit';
import { resolveComputerSessionLimits, resolveSessionExpiry } from './computer-session.policy';
import { ComputerSessionRepository } from './computer-session.repository';
import { NodeAgentProfileRepository } from './node-agent-profile.repository';

/** The Agent a profile belongs to, as the caller already resolved it (ownership checked). */
export interface ComputerAgentRef {
    id: string;
    name: string;
    organizationId: string | null;
}

/** The columns a reset writes — and a refused reset puts back. */
type ProfileResetFields = Pick<
    NodeAgentProfile,
    'profileKey' | 'signedInSiteCount' | 'diskBytes' | 'lastResetAt' | 'lastResetByUserId'
>;

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
        // Appended LAST + @Optional(): the live views on a machine (which a
        // reset must not land under) and the machine's admission lock.
        // Absent, a reset checks claimed jobs only and runs unlocked.
        @Optional() private readonly sessions?: ComputerSessionRepository,
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
     * is live on that Node, or a live view of that Agent there is still
     * open. A reset never lands under a running Run or an open view.
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
        // The machine's admission lock — the one a live-view open holds while
        // it reads this profile's key and reserves its slot — so a view can
        // never be opened carrying the key this reset is rotating away.
        return this.withNodeLock(input.nodeId, () => this.resetUnderLock(input, node, row));
    }

    private async resetUnderLock(
        input: { userId: string; agent: ComputerAgentRef; nodeId: string },
        node: { id: string; userId: string },
        row: NodeAgentProfile,
    ): Promise<ResetNodeAgentProfileOutcome> {
        if (await this.hasLiveWork(input.userId, input.nodeId, input.agent.id)) {
            return { refused: 'run-live' };
        }

        const before = toCount(row.signedInSiteCount);
        const previousRef = toProfileRef(row.profileKey);
        // Snapshotted before the write: what a refused reset puts back.
        const previous: ProfileResetFields = {
            profileKey: row.profileKey,
            signedInSiteCount: row.signedInSiteCount,
            diskBytes: row.diskBytes,
            lastResetAt: row.lastResetAt ?? null,
            lastResetByUserId: row.lastResetByUserId ?? null,
        };
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

        // Rotate, THEN re-check. The work a node leases is claimed by the
        // fleet's own conditional write, which no lock here can join, so the
        // first check alone leaves a window: a job admitted after it and
        // before the rotation would run on the superseded profile while the
        // reset reported success. Any claim committed before the rotation is
        // visible to this second read; one committed after it started on the
        // reset profile, which is exactly the order a reset promises. Work
        // found now is put back with a compare-and-set on the key this call
        // minted (a later reset's key is never overwritten) and refused.
        if (await this.hasLiveWork(input.userId, input.nodeId, input.agent.id)) {
            await this.restore(row, patch.profileKey, previous);
            return { refused: 'run-live' };
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

    /**
     * Is anything using — or about to use — this Agent's profile on this
     * machine? Any claimed job for that Agent there (a Run, or a live view,
     * which is handed the profile key itself), and any unfinished live view
     * of that Agent there that is still within its time (a view not yet
     * claimed carries the current key in its queued job). Fails closed.
     */
    private async hasLiveWork(userId: string, nodeId: string, agentId: string): Promise<boolean> {
        try {
            const active = await this.jobs.findActiveForUser(userId);
            if (
                active.some(
                    (job) =>
                        job.nodeId === nodeId &&
                        (job.payload as Record<string, unknown> | null)?.agentId === agentId,
                )
            ) {
                return true;
            }
            if (!this.sessions) return false;
            const now = new Date();
            const limits = resolveComputerSessionLimits(process.env);
            const views = await this.sessions.findOpenForNode(nodeId);
            return views.some(
                (view) =>
                    view.agentId === agentId && resolveSessionExpiry(view, now, limits) === null,
            );
        } catch (error) {
            // Fail closed: if we cannot tell whether a Run is live, do not reset under it.
            this.logger.warn(
                `profile reset refused for agent ${agentId} on node ${nodeId}: live-work check failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return true;
        }
    }

    /** Put back the key (and usage) a refused reset rotated, only if it is still the one this reset minted. */
    private async restore(
        row: NodeAgentProfile,
        mintedKey: string,
        previous: ProfileResetFields,
    ): Promise<void> {
        try {
            const restored = await this.profiles.reset(row.id, mintedKey, previous);
            if (!restored) {
                this.logger.warn(
                    `profile ${toProfileRef(mintedKey)} for agent ${row.agentId} on node ${row.nodeId} was reset again before it could be restored`,
                );
            }
        } catch (error) {
            this.logger.error(
                `profile for agent ${row.agentId} on node ${row.nodeId} could not be restored after a refused reset: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private async withNodeLock<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
        return this.sessions && typeof this.sessions.withAdmissionLock === 'function'
            ? this.sessions.withAdmissionLock({ nodeId }, fn)
            : fn();
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
