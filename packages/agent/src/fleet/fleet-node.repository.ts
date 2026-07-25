import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { FleetNode, FleetNodeKind, FleetNodeStatus } from '../entities/fleet-node.entity';

export interface CreateFleetNodeData {
    userId: string;
    organizationId?: string | null;
    name: string;
    kind: FleetNodeKind;
    status: FleetNodeStatus;
    enrollmentTokenHash: string;
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

    async delete(id: string): Promise<void> {
        await this.repository.delete(id);
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
}
