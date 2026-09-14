import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    MemoryFolder,
    MemoryFolderScope,
    MemoryFolderSyncRepo,
} from '../../entities/memory-folder.entity';

export interface CreateMemoryFolderInput {
    userId: string;
    name: string;
    parentId?: string | null;
    path: string;
    ownerAgentId?: string | null;
    syncRepo?: MemoryFolderSyncRepo | null;
    /** Omitted = a per-person folder (`user`), exactly as before scopes existed. */
    scope?: MemoryFolderScope;
    /**
     * Required for an `organization` folder. Omitted for a per-person folder
     * so `ScopeStampingSubscriber` stamps it from the request scope as it
     * always has.
     */
    organizationId?: string | null;
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
 * Who a tree query is about: one person's own folders, or one
 * Organization's shared folders. The column and the scope value travel
 * together so a per-person query can never match a shared folder (and vice
 * versa) — both are rows of the same table.
 */
interface FolderOwner {
    column: 'userId' | 'organizationId';
    value: string;
    scope: MemoryFolderScope;
}

const userOwner = (userId: string): FolderOwner => ({
    column: 'userId',
    value: userId,
    scope: MemoryFolderScope.USER,
});

const organizationOwner = (organizationId: string): FolderOwner => ({
    column: 'organizationId',
    value: organizationId,
    scope: MemoryFolderScope.ORGANIZATION,
});

/**
 * Persistence for the /memory Files folder tree and the shared Knowledge
 * library folders (same table, `scope` discriminator).
 *
 * Per-person reads are keyed by `userId` AND `scope = 'user'` — a folder id
 * belonging to another user, or a shared folder, resolves to `null`, which
 * the service layer maps to 404 (never 403, per the existence-leak
 * contract). Shared-folder reads are keyed by `organizationId` AND
 * `scope = 'organization'`. Path/tree INVARIANTS (uniqueness,
 * materialized-path maintenance, delete guards, depth and count limits)
 * live in `MemoryFoldersService`; this class is deliberately a thin query
 * layer.
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
        // Explicit `if` blocks, not conditional spreads (DTS-emit gotcha).
        if (input.scope !== undefined) {
            entity.scope = input.scope;
        }
        if (input.organizationId !== undefined) {
            entity.organizationId = input.organizationId;
        }
        return this.repo.save(entity);
    }

    async findById(userId: string, id: string): Promise<MemoryFolder | null> {
        return this.repo.findOne({ where: { id, userId, scope: MemoryFolderScope.USER } });
    }

    async findByPath(userId: string, path: string): Promise<MemoryFolder | null> {
        return this.repo.findOne({ where: { userId, path, scope: MemoryFolderScope.USER } });
    }

    /** Every folder of the user, ordered by path so parents precede children. */
    async listByUser(userId: string): Promise<MemoryFolder[]> {
        return this.repo.find({
            where: { userId, scope: MemoryFolderScope.USER },
            order: { path: 'ASC' },
        });
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
        return this.subtree(userOwner(userId), path);
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
        await this.rewriteSubtreePaths(userOwner(userId), oldPath, newPath);
    }

    async deleteByIds(userId: string, ids: string[]): Promise<void> {
        await this.deleteOwned(userOwner(userId), ids);
    }

    // ─── Shared (organization-scope) folders ─────────────────────────────

    async findOrganizationFolder(organizationId: string, id: string): Promise<MemoryFolder | null> {
        return this.repo.findOne({
            where: { id, organizationId, scope: MemoryFolderScope.ORGANIZATION },
        });
    }

    /** Every shared folder of the Organization, parents first. */
    async listByOrganization(organizationId: string): Promise<MemoryFolder[]> {
        return this.repo.find({
            where: { organizationId, scope: MemoryFolderScope.ORGANIZATION },
            order: { path: 'ASC' },
        });
    }

    /** Shared folders the Organization holds (the per-Organization cap). */
    async countByOrganization(organizationId: string): Promise<number> {
        return this.repo.count({
            where: { organizationId, scope: MemoryFolderScope.ORGANIZATION },
        });
    }

    /** Direct children of `parentId` (`null` = top level) among the Organization's shared folders. */
    async listOrganizationChildren(
        organizationId: string,
        parentId: string | null,
    ): Promise<MemoryFolder[]> {
        const qb = this.repo
            .createQueryBuilder('folder')
            .where('folder.organizationId = :organizationId', { organizationId })
            .andWhere('folder.scope = :scope', { scope: MemoryFolderScope.ORGANIZATION });
        if (parentId) {
            qb.andWhere('folder.parentId = :parentId', { parentId });
        } else {
            qb.andWhere('folder.parentId IS NULL');
        }
        return qb.orderBy('folder.path', 'ASC').getMany();
    }

    /** Same contract as {@link listSubtree}, over the Organization's shared folders. */
    async listOrganizationSubtree(organizationId: string, path: string): Promise<MemoryFolder[]> {
        return this.subtree(organizationOwner(organizationId), path);
    }

    /** Same contract as {@link updateSubtreePaths}, over the Organization's shared folders. */
    async updateOrganizationSubtreePaths(
        organizationId: string,
        oldPath: string,
        newPath: string,
    ): Promise<void> {
        await this.rewriteSubtreePaths(organizationOwner(organizationId), oldPath, newPath);
    }

    async deleteOrganizationFoldersByIds(organizationId: string, ids: string[]): Promise<void> {
        await this.deleteOwned(organizationOwner(organizationId), ids);
    }

    /**
     * The Organizations in which `userId` created at least one shared
     * folder. A shared folder records its creator in `userId`, whose FK is
     * `ON DELETE CASCADE`, so these are the Organizations that would lose
     * folders if that account were deleted.
     */
    async listOrganizationIdsWithFoldersCreatedBy(userId: string): Promise<string[]> {
        const rows = await this.repo
            .createQueryBuilder('folder')
            .select('folder.organizationId', 'organizationId')
            .distinct(true)
            .where('folder.userId = :userId', { userId })
            .andWhere('folder.scope = :scope', { scope: MemoryFolderScope.ORGANIZATION })
            .andWhere('folder.organizationId IS NOT NULL')
            .getRawMany<{ organizationId: string }>();
        return rows.map((row) => row.organizationId);
    }

    /**
     * Record `toUserId` as the creator of every shared folder `fromUserId`
     * created in the Organization. Only the creator column moves — names,
     * paths, parents and filed documents stay exactly as they are, and
     * personal folders are never touched. Returns how many folders moved.
     */
    async reassignOrganizationFolders(
        organizationId: string,
        fromUserId: string,
        toUserId: string,
    ): Promise<number> {
        const result = await this.repo
            .createQueryBuilder()
            .update(MemoryFolder)
            .set({ userId: toUserId })
            .where('organizationId = :organizationId', { organizationId })
            .andWhere('userId = :fromUserId', { fromUserId })
            .andWhere('scope = :scope', { scope: MemoryFolderScope.ORGANIZATION })
            .execute();
        return result.affected ?? 0;
    }

    // ─── internal ────────────────────────────────────────────────────────

    private subtree(owner: FolderOwner, path: string): Promise<MemoryFolder[]> {
        const prefix = `${path}/`;
        return this.repo
            .createQueryBuilder('folder')
            .where(`folder.${owner.column} = :ownerValue`, { ownerValue: owner.value })
            .andWhere('folder.scope = :ownerScope', { ownerScope: owner.scope })
            .andWhere('(folder.path = :path OR substr(folder.path, 1, :prefixLength) = :prefix)', {
                path,
                prefix,
                prefixLength: charLength(prefix),
            })
            .orderBy('folder.path', 'ASC')
            .getMany();
    }

    private async rewriteSubtreePaths(
        owner: FolderOwner,
        oldPath: string,
        newPath: string,
    ): Promise<void> {
        const prefix = `${oldPath}/`;
        await this.repo
            .createQueryBuilder()
            .update(MemoryFolder)
            .set({ path: () => ':newPath || substr(path, :suffixFrom)' })
            .where(`${owner.column} = :ownerValue`)
            .andWhere('scope = :ownerScope')
            .andWhere('(path = :oldPath OR substr(path, 1, :prefixLength) = :prefix)')
            .setParameters({
                ownerValue: owner.value,
                ownerScope: owner.scope,
                newPath,
                oldPath,
                prefix,
                prefixLength: charLength(prefix),
                // 1-based: the character right after `oldPath`.
                suffixFrom: charLength(oldPath) + 1,
            })
            .execute();
    }

    private async deleteOwned(owner: FolderOwner, ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        await this.repo
            .createQueryBuilder()
            .delete()
            .from(MemoryFolder)
            .where(`${owner.column} = :ownerValue`, { ownerValue: owner.value })
            .andWhere('scope = :ownerScope', { ownerScope: owner.scope })
            .andWhere('id IN (:...ids)', { ids })
            .execute();
    }
}
