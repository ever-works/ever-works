import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { FleetAgentNodeAffinity } from '../entities/fleet-agent-node-affinity.entity';
import {
    FleetNode,
    FleetNodeKind,
    FleetNodeStatus,
    FleetNodeWorkerState,
} from '../entities/fleet-node.entity';

export interface CreateFleetNodeData {
    userId: string;
    organizationId?: string | null;
    name: string;
    kind: FleetNodeKind;
    status: FleetNodeStatus;
    enrollmentTokenHash: string;
    /** When the credential above was minted — drives token expiry. */
    credentialIssuedAt?: Date | null;
    capabilities?: string[];
}

/** Columns the enroll CAS is allowed to stamp alongside the flip. */
export interface ConsumeEnrollmentPatch {
    enrollmentTokenHash: string;
    status: FleetNodeStatus;
    lastHeartbeatAt: Date;
    platform?: string | null;
    version?: string | null;
    capabilities?: string[];
    /** Agent-CLI version reported by the machine (not the daemon's own). */
    cliVersion?: string | null;
    /** Free bytes on the node's workspace volume. */
    diskFreeBytes?: number | null;
    /** Which account / seat the agent CLI is logged in as (EW-777). */
    modelIdentity?: string | null;
    /** What the node's worker reported doing at enroll time (EW-776). */
    workerState?: FleetNodeWorkerState | null;
    /** Why (quarantine / throttle reason), already sanitized and capped. */
    workerStateReason?: string | null;
    /** When that state was first observed — the enroll instant. */
    workerStateChangedAt?: Date | null;
}

/**
 * Feature-owned repository (provided by `FleetModule`, not
 * `DatabaseModule` — same split as `MeetingRepository`).
 */
@Injectable()
export class FleetNodeRepository {
    constructor(
        @InjectRepository(FleetNode)
        private readonly repository: Repository<FleetNode>,
    ) {}

    async create(data: CreateFleetNodeData): Promise<FleetNode> {
        return this.repository.save(
            this.repository.create({
                ...data,
                capabilities: data.capabilities ?? [],
            }),
        );
    }

    async findById(id: string): Promise<FleetNode | null> {
        return this.repository.findOne({ where: { id } });
    }

    /** Credential lookup (sha256 hex) — enroll resolves the row by it. */
    async findByCredentialHash(hash: string): Promise<FleetNode | null> {
        return this.repository.findOne({ where: { enrollmentTokenHash: hash } });
    }

    /** Owner-scoped listing, oldest first (stable table order). */
    async findByUser(userId: string): Promise<FleetNode[]> {
        return this.repository.find({
            where: { userId },
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * CAS-consume an enrollment token: the row must STILL be
     * `enrolling` and STILL carry the presented token hash — a raced
     * second enroll (or a revoked/disabled node) matches zero rows and
     * returns false. The winning update atomically swaps the credential
     * hash to the node-secret hash and flips the node online.
     */
    async consumeEnrollment(
        id: string,
        expectedTokenHash: string,
        patch: ConsumeEnrollmentPatch,
    ): Promise<boolean> {
        const result = await this.repository.update(
            { id, status: 'enrolling', enrollmentTokenHash: expectedTokenHash },
            patch,
        );
        return (result.affected ?? 0) === 1;
    }

    async update(id: string, patch: Partial<FleetNode>): Promise<void> {
        await this.repository.update(id, patch);
    }

    /**
     * Delete a node registration AND everything that only existed because
     * the node did.
     *
     * Today that is `fleet_agent_node_affinities` — the durable "run this
     * Agent on THAT machine" pins. There is deliberately no FK on that
     * table (see `1787508800000-CreateFleetAgentNodeAffinity`), so the
     * cascade is explicit here rather than in the schema. Left alone, a
     * removed node left its pins behind: the affinity service kept
     * resolving them, `FleetJobService.enqueue` kept stamping
     * `targetNodeId` with a machine that no longer exists, and the job sat
     * queued forever — pinned to a ghost.
     *
     * One transaction, so a failure to delete the pins leaves the node in
     * place too. A half-applied removal is the one outcome worse than
     * either whole one: the row is gone and the pins are not, which is
     * exactly the state this method exists to prevent.
     *
     * `fleet_jobs.targetNodeId` is NOT cleaned up on purpose — those rows
     * are history, and deleting a machine must not delete the record of
     * what it did.
     */
    async delete(id: string): Promise<void> {
        await this.repository.manager.transaction(async (manager) => {
            await manager.delete(FleetAgentNodeAffinity, { nodeId: id });
            await manager.delete(FleetNode, { id });
        });
    }

    /**
     * Offline sweep, piggybacked on list reads (no dedicated cron):
     * every `online` node of this owner whose last heartbeat is older
     * than `cutoff` flips to `offline`. Returns the flipped count.
     */
    async sweepOffline(userId: string, cutoff: Date): Promise<number> {
        const result = await this.repository.update(
            { userId, status: 'online', lastHeartbeatAt: LessThan(cutoff) },
            { status: 'offline' },
        );
        return result.affected ?? 0;
    }

    /**
     * The rows {@link sweepOffline} is ABOUT to flip, read before the
     * flip so each one can be named in a notice.
     *
     * Separate from the bulk sweep rather than replacing it: the sweep is
     * one UPDATE and returns a count, which is all the list read needs;
     * the notice path needs the node's name and last-seen time, and
     * getting those from a bulk UPDATE is not something either engine
     * offers portably. The bulk sweep stays as the catch-all — anything
     * this read missed (a row that went stale between the two statements)
     * is still flipped, just without a notice.
     */
    async findStaleOnline(userId: string, cutoff: Date): Promise<FleetNode[]> {
        return this.repository.find({
            where: { userId, status: 'online', lastHeartbeatAt: LessThan(cutoff) },
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * CAS one stale `online` row to `offline` and claim its notice.
     *
     * True EXACTLY ONCE per online → offline transition: the WHERE clause
     * still requires `online` and a heartbeat older than the cutoff, so a
     * node that beat back in the meantime is not flipped at all, and a
     * second replica sweeping the same owner concurrently loses the race
     * and files nothing. `offlineNoticedAt` is stamped in the same
     * statement — a marker written by a second UPDATE could be lost
     * between the two.
     */
    async markOfflineIfStale(id: string, cutoff: Date): Promise<boolean> {
        const result = await this.repository.update(
            { id, status: 'online', lastHeartbeatAt: LessThan(cutoff) },
            { status: 'offline', offlineNoticedAt: new Date() },
        );
        return (result.affected ?? 0) === 1;
    }

    /**
     * Nodes that have now been `offline` longer than the escalation
     * window and have not yet had the louder notice filed for THIS
     * outage.
     *
     * `offlineLongNoticedAt IS NULL` is the whole dedup: the marker is
     * cleared by the beat that brings a node back, so one outage produces
     * one notice however many times the sweep runs.
     *
     * `offlineNoticedAt IS NOT NULL` makes the escalation strictly a
     * FOLLOW-UP to a first notice this system actually filed. Without it,
     * the first list read after this feature ships would file a "gone for
     * over 30 minutes" notice for every node that has been offline since
     * before the feature existed — an inbox full of news about machines
     * their owner retired months ago.
     */
    async findOfflineUnnoticed(userId: string, longCutoff: Date): Promise<FleetNode[]> {
        return this.repository.find({
            where: {
                userId,
                status: 'offline',
                lastHeartbeatAt: LessThan(longCutoff),
                offlineNoticedAt: Not(IsNull()),
                offlineLongNoticedAt: IsNull(),
            },
            order: { createdAt: 'ASC' },
        });
    }

    /** CAS the long-offline notice marker. True for exactly one caller. */
    async markLongOfflineNoticed(id: string): Promise<boolean> {
        const result = await this.repository.update(
            { id, offlineLongNoticedAt: IsNull() },
            { offlineLongNoticedAt: new Date() },
        );
        return (result.affected ?? 0) === 1;
    }

    /**
     * Fleet cost accounting (EW-777) — claim the ONE per-day daily-ceiling
     * trip for a node. Returns true exactly once per (node, UTC day): the
     * caller that wins files the Inbox notice; every other crossing on the
     * same day still drains, but says nothing new.
     *
     * Two conditional UPDATEs rather than one `OR`: `trippedOn IS NULL`
     * and `trippedOn <> :day` are each an atomic CAS on both engines, and
     * a NULL never matches `<>`, so the pair covers a never-tripped row and
     * a row tripped on an earlier day without a driver-specific predicate.
     */
    async casTripDailyCeiling(id: string, day: string): Promise<boolean> {
        const fresh = await this.repository.update(
            { id, dailyCostTrippedOn: IsNull() },
            { dailyCostTrippedOn: day },
        );
        if ((fresh.affected ?? 0) === 1) return true;
        const rolled = await this.repository.update(
            { id, dailyCostTrippedOn: Not(day) },
            { dailyCostTrippedOn: day },
        );
        return (rolled.affected ?? 0) === 1;
    }
}
