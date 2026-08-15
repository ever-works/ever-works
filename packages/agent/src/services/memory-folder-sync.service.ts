import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { GitFacadeService } from '../facades/git.facade';
import { ActivityActionType } from '../entities/activity-log.types';
import { MemoryFolder, MemoryFolderSyncRepo } from '../entities/memory-folder.entity';
import { MemoryFolderRepository } from '../database/repositories/memory-folder.repository';
import { MemoryFilesService, MemoryFileRow } from './memory-files.service';
import { MemoryFoldersService } from './memory-folders.service';

/** Per-file outcome of a manual folder sync. */
export interface MemoryFolderSyncFileResult {
    id: string;
    source: MemoryFileRow['source'];
    filename: string;
    /** Repo-relative path the file was written to (when committed). */
    repoPath?: string;
    status: 'committed' | 'skipped-too-large' | 'failed';
    reason?: string;
}

export interface MemoryFolderSyncReport {
    folderId: string;
    commitSha: string | null;
    results: MemoryFolderSyncFileResult[];
}

/**
 * Reads one file's bytes for the sync walk. Injected per call by the API
 * layer because the two upload spines read bytes through DIFFERENT
 * storage stacks (UploadsService's boot-selected backend for
 * `user_uploads`, the KB_STORAGE_PLUGIN for `work_knowledge_uploads`),
 * both of which live in apps/api — keeping this service byte-source
 * agnostic keeps it unit-testable with no storage in play.
 */
export type MemoryFileBytesReader = (row: MemoryFileRow) => Promise<Buffer>;

/** Files above this size are reported in the skip list, never committed. */
export const SYNC_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** v1 is GitHub-only, via the git facade's github provider plugin. */
const SYNC_GIT_PROVIDER = 'github';

/**
 * Memory Files — manual "Sync now" of one folder (and its subtree) to a
 * Git repository, v1 GitHub through `GitFacadeService` (same
 * clone → write → addAll → status → commit → push shape as
 * `KnowledgeBaseGitMirrorService.commitAndPush`).
 *
 * Guard rails:
 *  - refuses (422) unless the folder has `syncRepo` configured with
 *    resolvable owner/repo coordinates;
 *  - files over {@link SYNC_MAX_FILE_BYTES} are skipped and reported;
 *  - a single unreadable file marks THAT file failed and the walk
 *    continues — one bad object must not abort the whole folder;
 *  - filenames are sanitized to a single path segment before any fs
 *    write, and the resolved destination is verified to stay inside the
 *    clone (same posture as the KB mirror's path validation).
 */
@Injectable()
export class MemoryFolderSyncService {
    private readonly logger = new Logger(MemoryFolderSyncService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly folderRepo: MemoryFolderRepository,
        private readonly foldersService: MemoryFoldersService,
        private readonly filesService: MemoryFilesService,
    ) {}

    async syncFolder(
        userId: string,
        folderId: string,
        opts: {
            organizationId?: string;
            readBytes: MemoryFileBytesReader;
        },
    ): Promise<MemoryFolderSyncReport> {
        const folder = await this.foldersService.requireOwned(userId, folderId);
        const target = this.resolveTarget(folder);

        // Subtree walk: the folder itself plus every descendant, files
        // mirrored at their folder-relative paths.
        const subtree = await this.folderRepo.listSubtree(userId, folder.path);
        const perFolderFiles: Array<{ relDir: string; row: MemoryFileRow }> = [];
        for (const node of subtree) {
            const files = await this.filesService.list(userId, {
                organizationId: opts.organizationId,
                folderId: node.id,
            });
            const relDir = node.id === folder.id ? '' : node.path.slice(folder.path.length + 1);
            for (const row of files) {
                perFolderFiles.push({ relDir, row });
            }
        }

        const results: MemoryFolderSyncFileResult[] = [];
        const toCommit: Array<{ relPath: string; row: MemoryFileRow }> = [];
        const usedPaths = new Set<string>();
        for (const { relDir, row } of perFolderFiles) {
            if (row.size !== null && row.size > SYNC_MAX_FILE_BYTES) {
                results.push({
                    id: row.id,
                    source: row.source,
                    filename: row.filename,
                    status: 'skipped-too-large',
                    reason: `File exceeds the ${SYNC_MAX_FILE_BYTES} byte sync cap`,
                });
                continue;
            }
            let relPath = path.posix.join(relDir, this.sanitizeFilename(row.filename));
            if (usedPaths.has(relPath)) {
                // Two files with the same name in one folder (possible across
                // the two spines) — disambiguate with the row-id prefix.
                const ext = path.posix.extname(relPath);
                const stem = ext ? relPath.slice(0, -ext.length) : relPath;
                relPath = `${stem}-${row.id.slice(0, 8)}${ext}`;
            }
            usedPaths.add(relPath);
            toCommit.push({ relPath, row });
        }

        if (toCommit.length === 0) {
            return { folderId: folder.id, commitSha: null, results };
        }

        const dir = await this.gitFacade.cloneOrPull(
            {
                owner: target.owner,
                repo: target.repo,
                ...(target.branch ? { branch: target.branch, autoSwitchToMainBranch: false } : {}),
            },
            { providerId: SYNC_GIT_PROVIDER, userId },
        );

        const rootDir = path.resolve(dir);
        let wroteAny = false;
        for (const { relPath, row } of toCommit) {
            try {
                const buffer = await opts.readBytes(row);
                const destination = this.resolveInsideRepo(
                    rootDir,
                    path.posix.join(target.dirPrefix ?? '', relPath),
                );
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.writeFile(destination, buffer);
                wroteAny = true;
                results.push({
                    id: row.id,
                    source: row.source,
                    filename: row.filename,
                    repoPath: path.posix.join(target.dirPrefix ?? '', relPath),
                    status: 'committed',
                });
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `Memory folder sync: failed to stage ${row.source}/${row.id}: ${reason.slice(0, 300)}`,
                );
                results.push({
                    id: row.id,
                    source: row.source,
                    filename: row.filename,
                    status: 'failed',
                    reason: reason.slice(0, 300),
                });
            }
        }

        let commitSha: string | null = null;
        if (wroteAny) {
            await this.gitFacade.addAll(SYNC_GIT_PROVIDER, dir);
            const status = await this.gitFacade.getStatus(SYNC_GIT_PROVIDER, dir);
            if (status.length > 0) {
                const committer = (await this.gitFacade.getCommitter({
                    providerId: SYNC_GIT_PROVIDER,
                    userId,
                })) ?? { name: 'Ever Works', email: 'noreply@ever.works' };
                commitSha = await this.gitFacade.commit(
                    SYNC_GIT_PROVIDER,
                    dir,
                    `[memory] sync folder ${folder.path} (${toCommit.length} files)`,
                    committer,
                );
                if (commitSha) {
                    await this.gitFacade.push({ dir }, { providerId: SYNC_GIT_PROVIDER, userId });
                }
            }
        }

        await this.foldersService.recordActivity(
            userId,
            ActivityActionType.MEMORY_FOLDER_SYNCED,
            `Synced memory folder ${folder.path} to ${target.owner}/${target.repo}`,
            {
                folderId: folder.id,
                path: folder.path,
                owner: target.owner,
                repo: target.repo,
                commitSha,
                committed: results.filter((r) => r.status === 'committed').length,
                skipped: results.filter((r) => r.status === 'skipped-too-large').length,
                failed: results.filter((r) => r.status === 'failed').length,
            },
        );

        // A no-op commit (identical content already in the repo) leaves the
        // staged files as 'committed' in the report — the repo IS in sync.
        return { folderId: folder.id, commitSha, results };
    }

    // ─── internal ────────────────────────────────────────────────────────

    private resolveTarget(folder: MemoryFolder): {
        owner: string;
        repo: string;
        branch?: string;
        dirPrefix?: string;
    } {
        const sync: MemoryFolderSyncRepo | null | undefined = folder.syncRepo;
        let owner = sync?.owner;
        let repo = sync?.repo;
        if ((!owner || !repo) && sync?.repoUrl) {
            const match = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(sync.repoUrl);
            if (match) {
                owner = owner || match[1];
                repo = repo || match[2];
            }
        }
        if (!sync || !owner || !repo) {
            throw new UnprocessableEntityException({
                status: 'error',
                code: 'SyncNotConfigured',
                message:
                    'This folder has no sync repository configured — set syncRepo (owner/repo) first',
            });
        }
        const dirPrefix = this.sanitizeDirPrefix(sync.dirPrefix);
        return { owner, repo, branch: sync.branch, dirPrefix };
    }

    /** Collapse an arbitrary display filename to one safe path segment. */
    private sanitizeFilename(filename: string): string {
        const base = filename.split(/[\\/]/).pop() ?? '';
        let cleaned = '';
        for (const ch of base) {
            const code = ch.charCodeAt(0);
            cleaned += code < 0x20 || code === 0x7f ? '_' : ch;
        }
        cleaned = cleaned.trim();
        if (!cleaned || cleaned === '.' || cleaned === '..') return 'unnamed';
        return cleaned;
    }

    /** dirPrefix is repo-relative and must not traverse out of the clone. */
    private sanitizeDirPrefix(dirPrefix: string | undefined): string | undefined {
        if (!dirPrefix) return undefined;
        const normalized = path.posix
            .normalize(dirPrefix.replace(/\\/g, '/'))
            .replace(/^\/+/, '')
            .replace(/\/+$/, '');
        if (!normalized || normalized === '.') return undefined;
        if (normalized.split('/').some((seg) => seg === '..')) {
            throw new UnprocessableEntityException({
                status: 'error',
                message: 'syncRepo.dirPrefix must not traverse parent directories',
            });
        }
        return normalized;
    }

    /** Belt-and-suspenders: the resolved destination must stay in the clone. */
    private resolveInsideRepo(rootDir: string, relPath: string): string {
        const resolved = path.resolve(rootDir, relPath);
        const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
        if (resolved !== rootDir && !resolved.startsWith(rootWithSep)) {
            throw new UnprocessableEntityException({
                status: 'error',
                message: `Sync path escapes the repository: ${relPath}`,
            });
        }
        return resolved;
    }
}
