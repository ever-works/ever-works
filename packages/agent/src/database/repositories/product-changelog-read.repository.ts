import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Not, Repository } from 'typeorm';
import { ProductChangelogRead } from '../../entities/product-changelog-read.entity';

/**
 * What's new (AW-14) — per-person read state for product changelog entries.
 *
 * Every query is keyed by `userId` and never by a workspace scope (spec
 * FR-13). Every method is portable across Postgres and better-sqlite3 — no
 * `unnest`, no dialect-specific upsert — because CI runs the latter.
 */
@Injectable()
export class ProductChangelogReadRepository {
    constructor(
        @InjectRepository(ProductChangelogRead)
        private readonly repository: Repository<ProductChangelogRead>,
    ) {}

    /** The subset of `slugs` this person has a read row for. */
    async findReadSlugs(userId: string, slugs: readonly string[]): Promise<Set<string>> {
        if (slugs.length === 0) {
            return new Set();
        }
        const rows = await this.repository.find({
            select: { entrySlug: true },
            where: { userId, entrySlug: In([...new Set(slugs)]) },
        });
        return new Set(rows.map((row) => row.entrySlug));
    }

    /**
     * Record `slugs` as read. One INSERT with `orIgnore()` (Postgres
     * `ON CONFLICT DO NOTHING`, sqlite `INSERT OR IGNORE`) against the unique
     * `(userId, entrySlug)` index, so a repeat and two tabs marking the same
     * entry at the same moment both leave exactly one row and raise nothing
     * (spec FR-18, S-17).
     */
    async markRead(userId: string, slugs: readonly string[]): Promise<void> {
        const unique = [...new Set(slugs)];
        if (unique.length === 0) {
            return;
        }
        await this.repository
            .createQueryBuilder()
            .insert()
            .into(ProductChangelogRead)
            .values(unique.map((entrySlug) => ({ userId, entrySlug })))
            .orIgnore()
            .execute();
    }

    /** How many of `candidateSlugs` this person has NOT read (spec FR-15). */
    async countUnread(userId: string, candidateSlugs: readonly string[]): Promise<number> {
        const unique = [...new Set(candidateSlugs)];
        if (unique.length === 0) {
            return 0;
        }
        const read = await this.findReadSlugs(userId, unique);
        return unique.length - read.size;
    }

    /**
     * Remove read rows for entries the running build no longer ships, once
     * they are older than `olderThan` (spec FR-22). Nothing calls this yet:
     * it exists so the prune can later be wired through a job-runtime
     * dispatcher without a schema change. Returns the number removed.
     *
     * An empty `slugs` list is refused rather than read as "delete every
     * row": a content source that failed to load must never wipe read state.
     */
    async deleteBySlugsNotIn(slugs: readonly string[], olderThan: Date): Promise<number> {
        const unique = [...new Set(slugs)];
        if (unique.length === 0) {
            return 0;
        }
        const result = await this.repository.delete({
            entrySlug: Not(In(unique)),
            readAt: LessThan(olderThan),
        });
        return result.affected ?? 0;
    }
}
