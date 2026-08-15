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
 * Character (code-point) length of a path — NOT `String.length`.
 *
 * SQL `substr()` counts CHARACTERS on both postgres and better-sqlite3,
 * while JavaScript's `.length` counts UTF-16 code units. A single astral
 * character (an emoji in a folder name is the everyday case) is 2 units
 * in JS and 1 character in SQL, so a `.length`-derived offset walks past
 * the separator and silently corrupts every descendant path.
 */
function charLength(value: string): number {
    return Array.from(value).length;
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
     * The folder at `path` plus every descendant, ordered parents-first.
     *
     * The descendant test is a `substr(...) = '<path>/'` prefix EQUALITY,
     * deliberately NOT a `LIKE`. Folder names are user text and may
     * legally contain `%` and `_`, which `LIKE` reads as wildcards: the
     * pattern `'/Q1_2026/%'` also matches `/Q1x2026/Receipts`, dragging an
     * unrelated sibling subtree into this one (a recursive delete then
     * dropped those folders and unfiled their files). Equality also
     * removes the driver split that bit the search predicates — sqlite's
     * `LIKE` is case-insensitive, postgres's is not, while `=` is
     * case-sensitive on both.
     */
    async listSubtree(userId: string, path: string): Promise<MemoryFolder[]> {
        const prefix = `${path}/`;
        return this.repo
            .createQueryBuilder('folder')
            .where('folder.userId = :userId', { userId })
            .andWhere('(folder.path = :path OR substr(folder.path, 1, :prefixLength) = :prefix)', {
                path,
                prefix,
                prefixLength: charLength(prefix),
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
     *
     * Three things this must never do, each of which it once did:
     *  - inline `newPath` as a SQL literal. TypeORM expands `:name`
     *    placeholders over the WHOLE statement text, string literals
     *    included, so a folder named `:userId` turned the SET clause into
     *    a positional placeholder and shifted every parameter after it.
     *    `newPath` is a BOUND parameter here.
     *  - match descendants with `LIKE`: `%` / `_` are legal in folder
     *    names and are wildcards to `LIKE` (see `listSubtree`).
     *  - derive the suffix offset from `String.length`: SQL `substr`
     *    counts characters, JS counts UTF-16 units, so one emoji in an
     *    ancestor name shifted every descendant path by a character.
     */
    async updateSubtreePaths(userId: string, oldPath: string, newPath: string): Promise<void> {
        const prefix = `${oldPath}/`;
        await this.repo
            .createQueryBuilder()
            .update(MemoryFolder)
            .set({ path: () => ':newPath || substr(path, :suffixFrom)' })
            .where('userId = :userId')
            .andWhere('(path = :oldPath OR substr(path, 1, :prefixLength) = :prefix)')
            .setParameters({
                userId,
                newPath,
                oldPath,
                prefix,
                prefixLength: charLength(prefix),
                // 1-based: the character right after `oldPath`.
                suffixFrom: charLength(oldPath) + 1,
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
}
