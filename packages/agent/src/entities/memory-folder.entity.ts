import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Manual "Sync now" target for a Memory folder — v1 GitHub via
 * `GitFacadeService`. Repo coordinates only, NEVER credentials: the
 * facade resolves the caller's token at sync time, so nothing secret
 * ever lands on this row.
 */
export interface MemoryFolderSyncRepo {
    /** Optional display/origin URL, e.g. `https://github.com/acme/notes`. */
    repoUrl?: string;
    owner?: string;
    repo?: string;
    /** Target branch; the provider default branch when omitted. */
    branch?: string;
    /** Directory inside the repo the folder's files are written under. */
    dirPrefix?: string;
}

/**
 * Who a folder belongs to.
 *
 *  - `user` — the original per-person folder of the /memory Files area. It
 *    organizes one person's uploaded files and is visible to that person
 *    only. Every row that predates the knowledge library has this scope.
 *  - `organization` — a shared Knowledge library folder. It organizes
 *    Knowledge Base documents for a whole Organization and is visible to
 *    every member. `userId` records who created it.
 */
export enum MemoryFolderScope {
    USER = 'user',
    ORGANIZATION = 'organization',
}

/**
 * Memory Files — a user-defined folder in the /memory Files area.
 *
 * Folders organize the user's files across BOTH upload spines
 * (`user_uploads` chat/plain uploads + `work_knowledge_uploads` KB
 * originals) without moving any bytes: each upload row gains a nullable
 * `folderId` pointing here, and an unfiled row (NULL) lives at the root.
 *
 * Tree shape:
 *   - `parentId` is the adjacency edge (NULL = top-level folder).
 *   - `path` is the MATERIALIZED absolute path (`/a/b`), unique per
 *     `userId` and maintained by `MemoryFoldersService` on every
 *     rename/move (subtree rows are rewritten in the same operation).
 *     It exists so subtree queries are a single `LIKE '/a/%'` instead of
 *     a recursive walk. No `@ManyToOne` self-relation — raw uuid column,
 *     per the EW-654 no-cycle rule.
 *
 * Agent privacy:
 *   - `ownerAgentId NULL` ⇒ the folder is GLOBAL (visible to every agent
 *     and surface). Set ⇒ the folder (and its files) is private to that
 *     one agent; `MemoryFilesService.list({ agentId })` enforces the
 *     filter for agent-context reads.
 *
 * Tier C scope columns (`tenantId` / `organizationId`) are stamped by
 * `ScopeStampingSubscriber` on insert — tenancy denormalization, not the
 * ownership discriminator for per-person folders (that is `userId`).
 *
 * Scopes (`scope`, see {@link MemoryFolderScope}):
 *   - `user` rows keep exactly their original semantics. Path uniqueness is
 *     the PARTIAL unique index `uq_memory_folders_user_path` on
 *     `(userId, path) WHERE scope = 'user'`, which enforces over those rows
 *     precisely what the original full index did.
 *   - `organization` rows are shared Knowledge library folders holding
 *     documents. Their paths are unique per Organization through the
 *     partial index `uq_memory_folders_org_path` on
 *     `(organizationId, path) WHERE scope = 'organization'`. Every
 *     per-person query filters on `scope = 'user'`, so a shared folder never
 *     appears in anyone's Files tree and a personal folder never appears on
 *     the shared shelf.
 */
@Entity({ name: 'memory_folders' })
@Index('uq_memory_folders_user_path', ['userId', 'path'], {
    unique: true,
    where: `"scope" = 'user'`,
})
@Index('idx_memory_folders_user_parent', ['userId', 'parentId'])
@Index('uq_memory_folders_org_path', ['organizationId', 'path'], {
    unique: true,
    where: `"scope" = 'organization'`,
})
@Index('idx_memory_folders_org_parent', ['organizationId', 'parentId'], {
    where: `"scope" = 'organization'`,
})
export class MemoryFolder {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owning user. No @ManyToOne — raw uuid + FK by migration (EW-654). */
    @Column({ type: 'uuid' })
    userId: string;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @Column({ type: 'varchar', length: 120 })
    name: string;

    /** Parent folder id; NULL = top level. Raw uuid, no self-relation. */
    @Column({ type: 'uuid', nullable: true })
    parentId?: string | null;

    /** Materialized absolute path (`/a/b`), unique per user, service-maintained. */
    @Column({ type: 'varchar', length: 512 })
    path: string;

    /** NULL = Global folder; set = private to that agent. */
    @Column({ type: 'uuid', nullable: true })
    ownerAgentId?: string | null;

    /** Manual git-sync target (repo coordinates only — no credentials). */
    @Column({ type: 'simple-json', nullable: true })
    syncRepo?: MemoryFolderSyncRepo | null;

    /**
     * `user` (default — a personal Files folder) or `organization` (a shared
     * Knowledge library folder). See {@link MemoryFolderScope}.
     */
    @Column({ type: 'varchar', length: 16, default: MemoryFolderScope.USER })
    scope: MemoryFolderScope;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
