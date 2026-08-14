import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemoryFolder, MemoryFolderSyncRepo } from '../../entities/memory-folder.entity';

export interface CreateMemoryFolderInput {
    userId: string;
    name: string;
    parentId?: string | null;
    path: string;
    ownerAgentId?: string | null;
    syncRepo?: MemoryFolderSyncRepo | null;
}

/**
 * Persistence for the /memory Files folder tree.
 *
 * All reads are keyed by `userId` — a folder id belonging to another user
 * resolves to `null`, which the service layer maps to 404 (never 403,
 * per the existence-leak contract). Path/tree INVARIANTS (uniqueness,
 * materialized-path maintenance, delete guards) live in
 * `MemoryFoldersService`; this class is deliberately a thin query layer.
 */
@Injectable()
export class MemoryFolderRepository {
    constructor(
        @InjectRepository(MemoryFolder)
        private readonly repo: Repository<MemoryFolder>,
    ) {}

    async create(input: CreateMemoryFolderInput): Promise<MemoryFolder> {
        const entity = this.repo.create({
            userId: input.userId,
            name: input.name,
            parentId: input.parentId ?? null,
            path: input.path,
            ownerAgentId: input.ownerAgentId ?? null,
            syncRepo: input.syncRepo ?? null,
        });
        return this.repo.save(entity);
    }

    async findById(userId: string, id: string): Promise<MemoryFolder | null> {
        return this.repo.findOne({ where: { id, userId } });
    }

    async findByPath(userId: string, path: string): Promise<MemoryFolder | null> {
        return this.repo.findOne({ where: { userId, path } });
    }

    /** Every folder of the user, ordered by path so parents precede children. */
    async listByUser(userId: string): Promise<MemoryFolder[]> {
        return this.repo.find({ where: { userId }, order: { path: 'ASC' } });
    }

    /**
     * The folder at `path` plus every descendant (`path LIKE '<path>/%'`),
     * ordered parents-first.
     */
    async listSubtree(userId: string, path: string): Promise<MemoryFolder[]> {
        return this.repo
            .createQueryBuilder('folder')
            .where('folder.userId = :userId', { userId })
            .andWhere('(folder.path = :path OR folder.path LIKE :prefix)', {
                path,
                prefix: `${path}/%`,
            })
            .orderBy('folder.path', 'ASC')
            .getMany();
    }

    async update(id: string, patch: Partial<MemoryFolder>): Promise<void> {
        await this.repo.update({ id }, patch);
    }

    /**
     * Rewrite the materialized path of a whole subtree after a rename or
     * move: every row whose path is `oldPath` or starts with `oldPath + '/'`
     * has that prefix swapped for `newPath`. `||` concatenation and
     * `substr` work on both postgres and better-sqlite3, so the statement
     * is portable across the prod / e2e drivers.
     */
    async updateSubtreePaths(userId: string, oldPath: string, newPath: string): Promise<void> {
        await this.repo
            .createQueryBuilder()
            .update(MemoryFolder)
            .set({
                path: () =>
                    `'${newPath.replace(/'/g, "''")}' || substr(path, ${oldPath.length + 1})`,
            })
            .where('userId = :userId', { userId })
            .andWhere('(path = :oldPath OR path LIKE :prefix)', {
                oldPath,
                prefix: `${oldPath}/%`,
            })
            .execute();
    }

    async deleteByIds(userId: string, ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        await this.repo
            .createQueryBuilder()
            .delete()
            .from(MemoryFolder)
            .where('userId = :userId', { userId })
            .andWhere('id IN (:...ids)', { ids })
            .execute();
    }

    async countChildren(userId: string, parentId: string): Promise<number> {
        return this.repo.count({ where: { userId, parentId } });
    }
}
