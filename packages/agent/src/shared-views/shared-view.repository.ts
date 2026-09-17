import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { SharedViewSectionsDto, SharedViewStatus } from '@ever-works/contracts/api';
import { SharedView, sharedViewDefaults } from '../entities/shared-view.entity';

/** What creating a Shared view needs. Everything else starts at its default. */
export interface CreateSharedViewInput {
    organizationId: string;
    tenantId: string;
    ownerUserId: string;
    createdById: string;
    token: string;
    tokenHash: string;
}

/** The settings facets an owner can change. Absent fields are left alone. */
export interface SharedViewSettingsPatch {
    status?: SharedViewStatus;
    sections?: SharedViewSectionsDto;
    knowledgeClasses?: string[];
    searchIndexable?: boolean;
}

/**
 * Data access for `shared_views`.
 *
 * Every write that can race restates its precondition in the UPDATE itself,
 * so two owner tabs (or two API replicas) can never both win: a regenerate
 * applies only against the rotation count it read, and the first-view mark
 * is set at most once per link. Portable across Postgres and better-sqlite3.
 */
@Injectable()
export class SharedViewRepository {
    constructor(
        @InjectRepository(SharedView)
        private readonly repository: Repository<SharedView>,
    ) {}

    findByOrganization(organizationId: string): Promise<SharedView | null> {
        return this.repository.findOne({ where: { organizationId } });
    }

    findById(id: string): Promise<SharedView | null> {
        return this.repository.findOne({ where: { id } });
    }

    /** The public path's single indexed read. The caller has already hashed the token. */
    findByTokenHash(tokenHash: string): Promise<SharedView | null> {
        return this.repository.findOne({ where: { tokenHash } });
    }

    /**
     * Insert the Workspace's Shared view. Throws on the unique
     * `organizationId` index when another request created it first; the
     * service re-reads and returns that row, which is what makes turning
     * sharing on idempotent.
     */
    async createForOrganization(input: CreateSharedViewInput): Promise<SharedView> {
        const defaults = sharedViewDefaults();
        const row = this.repository.create({
            organizationId: input.organizationId,
            tenantId: input.tenantId,
            ownerUserId: input.ownerUserId,
            createdById: input.createdById,
            tokenHash: input.tokenHash,
            tokenEncrypted: { token: input.token },
            status: defaults.status,
            sections: defaults.sections,
            knowledgeClasses: defaults.knowledgeClasses,
            searchIndexable: defaults.searchIndexable,
            viewCount: defaults.viewCount,
            rotationCount: defaults.rotationCount,
            lastViewedAt: null,
            firstViewNotifiedAt: null,
            tokenRotatedAt: null,
        });
        return this.repository.save(row);
    }

    /**
     * Replace the token, but only if nobody else has since the caller read
     * the row. Returns false when the rotation count moved — the losing tab
     * of two simultaneous regenerates. The first-view mark is cleared so the
     * new link notifies its owner once more.
     *
     * One conditional UPDATE: the new hash, the encrypted token (the column
     * transformer runs on `update` too) and the incremented count land
     * together or not at all.
     */
    async rotateToken(
        id: string,
        seenRotationCount: number,
        next: { token: string; tokenHash: string; now: Date },
    ): Promise<boolean> {
        const result = await this.repository.update(
            { id, rotationCount: seenRotationCount },
            {
                tokenHash: next.tokenHash,
                tokenEncrypted: { token: next.token },
                rotationCount: seenRotationCount + 1,
                tokenRotatedAt: next.now,
                firstViewNotifiedAt: null,
            },
        );
        return (result.affected ?? 0) === 1;
    }

    async updateSettings(id: string, patch: SharedViewSettingsPatch): Promise<void> {
        const set: Partial<SharedView> = {};
        if (patch.status !== undefined) set.status = patch.status;
        if (patch.sections !== undefined) set.sections = patch.sections;
        if (patch.knowledgeClasses !== undefined) set.knowledgeClasses = patch.knowledgeClasses;
        if (patch.searchIndexable !== undefined) set.searchIndexable = patch.searchIndexable;
        if (Object.keys(set).length === 0) return;
        await this.repository.update({ id }, set);
    }

    /** Add counted views and move the last-viewed time, in one UPDATE. */
    async applyViewDelta(id: string, delta: number, viewedAt: Date): Promise<void> {
        if (!Number.isInteger(delta) || delta <= 0) return;
        await this.repository.update(
            { id },
            { viewCount: () => `"viewCount" + ${delta}`, lastViewedAt: viewedAt },
        );
    }

    /**
     * Claim the first-view notification for the current link. True for
     * exactly one caller per link: the UPDATE applies only while the mark is
     * still empty and the rotation count is the one the caller saw.
     */
    async claimFirstViewNotification(
        id: string,
        rotationCount: number,
        now: Date,
    ): Promise<boolean> {
        const result = await this.repository.update(
            { id, rotationCount, firstViewNotifiedAt: IsNull() },
            { firstViewNotifiedAt: now },
        );
        return (result.affected ?? 0) === 1;
    }

    async deleteForOrganization(organizationId: string): Promise<boolean> {
        const result = await this.repository.delete({ organizationId });
        return (result.affected ?? 0) > 0;
    }
}
