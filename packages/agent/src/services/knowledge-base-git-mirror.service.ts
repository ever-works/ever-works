import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as yaml from 'yaml';

import { GitFacadeService } from '../facades/git.facade';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkKnowledgeDocumentRepository } from '../database/repositories/work-knowledge-document.repository';
import { WorkKnowledgeDocument } from '../entities/work-knowledge-document.entity';
import { Work } from '../entities/work.entity';
import { User } from '../entities/user.entity';
import { KbDocumentClass } from '../entities/kb-types';

/**
 * EW-641 Phase 1B/a — two-layer KB sync.
 *
 * Owns the on-disk + Git side of `WorkKnowledgeDocument`: writes the
 * sidecar `.yml` + body `.md` pair under
 * `.content/kb/<class>/<slug>.{yml,md}`, regenerates the auto-maintained
 * `.content/kb/.index.yml`, and commits + pushes via the configured Git
 * provider plugin. Lives in `services/` (not `git/`) because Knowledge
 * Base concerns dominate; it's a thin layer over `GitFacadeService` and
 * `node:fs/promises`.
 *
 * Invoked from the Trigger.dev `kb-mirror-document` task — never from
 * the inline HTTP request — so the API response can return immediately
 * after the DB write. Failures inside this service surface in the
 * Trigger.dev run UI; the DB row remains the source of truth and
 * `lastCommitSha` stays at its prior value (or `null`) until the next
 * successful sync.
 *
 * Spec: docs/specs/features/knowledge-base/spec.md §7 (folder layout) +
 * §9.4 (materialize step) + §18.2 (backfill).
 */
@Injectable()
export class KnowledgeBaseGitMirrorService {
    private static readonly KB_ROOT = '.content/kb';
    private static readonly INDEX_FILE = '.index.yml';
    private static readonly INDEX_GENERATOR = 'ever-works-platform/kb-indexer';
    private static readonly INDEX_VERSION = 1;
    /**
     * EW-641 Phase 2/e row 37 — first segment under `.content/kb/`
     * where org-scope KB documents get materialized in each Work's
     * data repo (spec §7.6). Hidden-dot prefix keeps it visually
     * distinct from class folders + signals "platform-managed".
     */
    private static readonly ORG_OVERLAY_DIR = '.org';

    /**
     * Class folders the platform ensures exist on every backfill /
     * lazy-init. Drawn directly from `KbDocumentClass`; the enum is the
     * canonical source of truth.
     */
    private static readonly CLASS_FOLDERS: ReadonlyArray<string> = Object.values(
        KbDocumentClass,
    ) as ReadonlyArray<string>;

    /**
     * Rejects anything that, after normalization, would escape `.content/kb/`
     * or look like an absolute/Windows path. Greptile P1 + Codex P1 both
     * flagged `path.join(repoDir, KB_ROOT, doc.path)` as a traversal vector
     * — a doc created with `path: '../../.git/config'` would unlink the
     * clone's `.git/config`. Defense in depth: `KnowledgeBaseService`
     * validates at the input boundary; this method validates again before
     * any fs write/unlink so a manually-inserted DB row can't bypass it.
     */
    static validateRelativeKbPath(relativePath: string): void {
        if (typeof relativePath !== 'string' || relativePath.length === 0) {
            throw new BadRequestException('KB document path must be a non-empty string');
        }
        if (relativePath.length > 512) {
            throw new BadRequestException('KB document path exceeds 512 characters');
        }
        // Reject Windows-style separators and null bytes outright — the spec
        // canonicalises forward slashes (§7.2) and anything else is suspect.
        if (relativePath.includes('\\') || relativePath.includes('\0')) {
            throw new BadRequestException(
                `KB document path contains illegal characters: ${relativePath}`,
            );
        }
        // Absolute paths (POSIX or Windows drive letter) are always wrong
        // for a Work-relative KB entry.
        if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
            throw new BadRequestException(
                `KB document path must be relative to .content/kb/: ${relativePath}`,
            );
        }
        // Use POSIX semantics so the normalize step doesn't accidentally
        // resolve `..` differently on Windows.
        const normalized = path.posix.normalize(relativePath);
        if (
            normalized.startsWith('..') ||
            normalized === '..' ||
            normalized.split('/').some((seg) => seg === '..')
        ) {
            throw new BadRequestException(
                `KB document path must not traverse parent directories: ${relativePath}`,
            );
        }
        // First segment must be a known class folder — same as the on-disk
        // skeleton — so a stray top-level write is rejected.
        const firstSegment = normalized.split('/')[0];
        if (
            !(KnowledgeBaseGitMirrorService.CLASS_FOLDERS as ReadonlyArray<string>).includes(
                firstSegment,
            )
        ) {
            throw new BadRequestException(
                `KB document path must start with a known class folder: ${relativePath}`,
            );
        }
    }

    private readonly logger = new Logger(KnowledgeBaseGitMirrorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly workRepository: WorkRepository,
        private readonly documentRepository: WorkKnowledgeDocumentRepository,
    ) {}

    /**
     * Upsert a single document into the Work's data repo. Looks up the
     * doc row, writes the sidecar + body, refreshes `.index.yml`, and
     * commits + pushes in a single Git operation. Updates `lastCommitSha`
     * on the DB row when the commit returns a SHA.
     *
     * Idempotent — running twice with no DB change is a no-op commit
     * (Git returns `null` for an empty commit and the SHA stays put).
     */
    async materializeDocument(workId: string, documentId: string): Promise<void> {
        const doc = await this.documentRepository.findById(workId, documentId);
        if (!doc) {
            throw new NotFoundException(`KB document not found for mirror: ${documentId}`);
        }

        await this.runInRepo(workId, async ({ dir, work, committer }) => {
            await this.ensureSkeletonOnDisk(dir);
            await this.writeDocumentFiles(dir, doc);
            await this.writeIndex(dir, workId);

            const commitSha = await this.commitAndPush(
                work,
                dir,
                `[kb] upsert ${doc.kbDocumentClass}/${doc.slug}`,
                committer,
            );

            if (commitSha) {
                await this.documentRepository.update(doc.id, { lastCommitSha: commitSha });
            }
        });
    }

    /**
     * EW-641 Phase 2/e row 37 — materialize an org-scope document into
     * a single target Work's data repo. The fan-out across every Work
     * in the org is owned by the `kb-org-overlay-fanout` Trigger.dev
     * task; this method runs once per `(workId, orgDocumentId)` pair.
     *
     * The on-disk layout follows spec §7.6: org overlays live under a
     * `.org/` first segment so the Work owner can tell at a glance
     * which docs are inherited from the org vs which they wrote
     * locally:
     *
     *   .content/kb/.org/<class>/<slug>.yml   (sidecar)
     *   .content/kb/.org/<class>/<slug>.md    (body)
     *
     * Path discipline: `doc.path` is validated with the existing
     * `validateRelativeKbPath` (rejects `../`, absolute paths, Windows
     * separators, null bytes) — the platform-controlled `.org/` prefix
     * is applied AFTER validation so it can't be smuggled in via a
     * malicious doc row.
     *
     * Idempotent — running twice with no DB change is a no-op commit.
     */
    async materializeOrgDocument(
        workId: string,
        organizationId: string,
        documentId: string,
    ): Promise<void> {
        const doc = await this.documentRepository.findOrgById(organizationId, documentId);
        if (!doc) {
            throw new NotFoundException(
                `KB org document not found for overlay materialization: ${documentId} (org=${organizationId})`,
            );
        }

        await this.runInRepo(workId, async ({ dir, work, committer }) => {
            await this.ensureSkeletonOnDisk(dir);
            await this.writeOrgDocumentFiles(dir, doc);
            await this.writeIndex(dir, workId);

            await this.commitAndPush(
                work,
                dir,
                `[kb] upsert org overlay ${doc.kbDocumentClass}/${doc.slug}`,
                committer,
            );
            // Org overlays don't update lastCommitSha on the source doc —
            // a single org row maps to N commits across N Works; storing
            // the last per-Work SHA on the org row would race.
        });
    }

    /**
     * EW-641 Phase 2/e row 37 — remove an org-scope document's overlay
     * files from a single target Work's data repo. Counterpart to
     * `materializeOrgDocument`; called per-Work by the fan-out task
     * when the org row was deleted (the DB row is gone by the time we
     * run, so `path` + `class` carry the resolution forward — mirrors
     * the per-Work `removeDocument` contract).
     */
    async removeOrgDocument(
        workId: string,
        options: { documentId: string; path: string; class: string },
    ): Promise<void> {
        await this.runInRepo(workId, async ({ dir, work, committer }) => {
            await this.ensureSkeletonOnDisk(dir);

            const removed = await this.removeOrgDocumentFiles(dir, options.path);
            await this.writeIndex(dir, workId);

            const message = removed
                ? `[kb] delete org overlay ${options.class}/${this.slugFromPath(options.path)}`
                : `[kb] index refresh after org overlay ${options.class}/${this.slugFromPath(options.path)} (already absent)`;

            await this.commitAndPush(work, dir, message, committer);
        });
    }

    /**
     * Remove a single document's sidecar + body from the Work's data
     * repo. `path` is required because the DB row is hard-deleted before
     * the task runs.
     */
    async removeDocument(
        workId: string,
        options: { documentId: string; path: string; class: string },
    ): Promise<void> {
        await this.runInRepo(workId, async ({ dir, work, committer }) => {
            await this.ensureSkeletonOnDisk(dir);

            const removed = await this.removeDocumentFiles(dir, options.path);
            await this.writeIndex(dir, workId);

            const message = removed
                ? `[kb] delete ${options.class}/${this.slugFromPath(options.path)}`
                : `[kb] index refresh after ${options.class}/${this.slugFromPath(options.path)} (already absent)`;

            await this.commitAndPush(work, dir, message, committer);
        });
    }

    /**
     * Idempotently create the `.content/kb/` skeleton in a Work's data
     * repo: every class folder with a `.gitkeep` placeholder + an empty
     * `.index.yml`. Skips already-initialized repos (no-op commit).
     */
    async initializeSkeleton(workId: string): Promise<void> {
        await this.runInRepo(workId, async ({ dir, work, committer }) => {
            const created = await this.ensureSkeletonOnDisk(dir);
            await this.writeIndex(dir, workId);

            if (!created) {
                // .index.yml may still have drifted — let commitAndPush decide.
                this.logger.debug(`KB skeleton already exists for work ${workId}`);
            }

            await this.commitAndPush(
                work,
                dir,
                '[kb] initialize knowledge-base skeleton',
                committer,
            );
        });
    }

    /**
     * Regenerate the `.index.yml` for a Work without touching individual
     * documents. Used by reconciliation paths (Phase 3) and by tests.
     */
    async rebuildIndex(workId: string): Promise<void> {
        await this.runInRepo(workId, async ({ dir, work, committer }) => {
            await this.ensureSkeletonOnDisk(dir);
            await this.writeIndex(dir, workId);

            await this.commitAndPush(work, dir, '[kb] rebuild .index.yml', committer);
        });
    }

    /**
     * Restore a document body from a prior Git commit. Reads the sidecar
     * `.yml` + body `.md` at `commitSha` via the Git provider plugin's
     * `getFileContent` capability, applies the body to the DB row, and
     * enqueues a fresh mirror so the head commit moves forward with the
     * restored content. Returns the updated doc.
     *
     * Falls back gracefully when the provider does not implement
     * `getFileContent` (very old plugins) — the caller sees a 400 from
     * the service layer.
     */
    async restoreDocumentFromGit(
        workId: string,
        documentId: string,
        commitSha: string,
    ): Promise<{ restored: boolean; body: string | null }> {
        const doc = await this.documentRepository.findById(workId, documentId);
        if (!doc) {
            throw new NotFoundException(`KB document not found for restore: ${documentId}`);
        }

        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new NotFoundException(`Work not found for restore: ${workId}`);
        }

        const workOwner = work.user as User | undefined;
        if (!workOwner?.id) {
            throw new NotFoundException(`Work owner missing for restore: ${workId}`);
        }

        const owner = work.getRepoOwner('data');
        const repo = work.getDataRepo();
        const relPath = path.posix.join(KnowledgeBaseGitMirrorService.KB_ROOT, doc.path);

        const file = await this.gitFacade.getFileContent(
            owner,
            repo,
            relPath,
            {
                providerId: work.gitProvider,
                userId: workOwner.id,
                workId: work.id,
            },
            commitSha,
        );

        if (!file) {
            return { restored: false, body: null };
        }

        const body = this.decodeFileContent(file);
        const metadata = { ...(doc.metadata ?? {}), body };
        await this.documentRepository.update(doc.id, {
            metadata: metadata as Record<string, unknown>,
            wordCount: this.countWords(body),
            tokenCount: Math.ceil(body.length / 4),
        });

        return { restored: true, body };
    }

    /**
     * EW-641 Phase 1B/d row 18b — list commits that touched a KB
     * document's sidecar `.md` file, newest first.
     *
     * Resolves the doc the same way `restoreDocumentFromGit` does
     * (DB row → Work → repo owner/name + relative KB path), then fans
     * out to the Git provider plugin's optional `listFileCommits`
     * capability via the facade. Providers that don't implement the
     * capability surface as `[]` — the KB history dialog already
     * renders an empty state for that case (row 18c).
     */
    async listDocumentHistory(
        workId: string,
        documentId: string,
        limit: number,
    ): Promise<
        ReadonlyArray<{ sha: string; message: string; authorName: string; authoredAt: string }>
    > {
        const doc = await this.documentRepository.findById(workId, documentId);
        if (!doc) {
            throw new NotFoundException(`KB document not found for history: ${documentId}`);
        }

        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new NotFoundException(`Work not found for history: ${workId}`);
        }

        const workOwner = work.user as User | undefined;
        if (!workOwner?.id) {
            return [];
        }

        const owner = work.getRepoOwner('data');
        const repo = work.getDataRepo();
        const relPath = path.posix.join(KnowledgeBaseGitMirrorService.KB_ROOT, doc.path);

        const commits = await this.gitFacade.listFileCommits(
            owner,
            repo,
            relPath,
            {
                providerId: work.gitProvider,
                userId: workOwner.id,
                workId: work.id,
            },
            limit,
        );

        return commits.map((commit) => ({
            sha: commit.sha,
            message: commit.message,
            authorName: commit.author?.name ?? '',
            authoredAt: commit.date,
        }));
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────────

    /**
     * Wrap a callback that needs the local clone + the resolved Work +
     * committer. Centralizes credential lookup and dir resolution so the
     * public methods read top-to-bottom.
     */
    private async runInRepo(
        workId: string,
        callback: (ctx: {
            dir: string;
            work: Work;
            committer: { name: string; email: string };
        }) => Promise<void>,
    ): Promise<void> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new NotFoundException(`Work not found for KB mirror: ${workId}`);
        }

        const workOwner = work.user as User | undefined;
        if (!workOwner?.id) {
            throw new NotFoundException(
                `Work owner missing — cannot resolve git credentials for ${workId}`,
            );
        }

        const committer = work.resolveCommitter(workOwner);

        const dir = await this.gitFacade.cloneOrPull(
            {
                owner: work.getRepoOwner('data'),
                repo: work.getDataRepo(),
                committer,
            },
            {
                providerId: work.gitProvider,
                userId: workOwner.id,
                workId: work.id,
            },
        );

        await callback({ dir, work, committer });
    }

    /**
     * Ensure every class folder + `.index.yml` exists under
     * `.content/kb/`. Returns `true` when any folder/file was created
     * (caller can decide whether to log).
     */
    private async ensureSkeletonOnDisk(repoDir: string): Promise<boolean> {
        const kbRoot = path.join(repoDir, KnowledgeBaseGitMirrorService.KB_ROOT);

        let createdAny = false;
        await fs.mkdir(kbRoot, { recursive: true });

        for (const folder of KnowledgeBaseGitMirrorService.CLASS_FOLDERS) {
            const folderPath = path.join(kbRoot, folder);
            const gitkeepPath = path.join(folderPath, '.gitkeep');

            try {
                await fs.access(gitkeepPath);
            } catch {
                await fs.mkdir(folderPath, { recursive: true });
                await fs.writeFile(gitkeepPath, '', 'utf-8');
                createdAny = true;
            }
        }

        // Always materialize an .index.yml file so the agent runtime can
        // rely on its presence; content is overwritten by writeIndex().
        const indexPath = path.join(kbRoot, KnowledgeBaseGitMirrorService.INDEX_FILE);
        try {
            await fs.access(indexPath);
        } catch {
            await fs.writeFile(indexPath, this.emptyIndex(), 'utf-8');
            createdAny = true;
        }

        return createdAny;
    }

    private async writeDocumentFiles(repoDir: string, doc: WorkKnowledgeDocument): Promise<void> {
        KnowledgeBaseGitMirrorService.validateRelativeKbPath(doc.path);

        const kbRoot = path.join(repoDir, KnowledgeBaseGitMirrorService.KB_ROOT);
        const sidecarPath = this.resolveInsideKbRoot(kbRoot, this.sidecarPath(doc.path));
        const bodyPath = this.resolveInsideKbRoot(kbRoot, doc.path);

        await fs.mkdir(path.dirname(sidecarPath), { recursive: true });

        const sidecar = this.buildSidecar(doc);
        await fs.writeFile(sidecarPath, yaml.stringify(sidecar), 'utf-8');

        const body = this.readBody(doc);
        await fs.writeFile(bodyPath, body, 'utf-8');
    }

    private async removeDocumentFiles(repoDir: string, relativePath: string): Promise<boolean> {
        KnowledgeBaseGitMirrorService.validateRelativeKbPath(relativePath);

        const kbRoot = path.join(repoDir, KnowledgeBaseGitMirrorService.KB_ROOT);
        const sidecarPath = this.resolveInsideKbRoot(kbRoot, this.sidecarPath(relativePath));
        const bodyPath = this.resolveInsideKbRoot(kbRoot, relativePath);

        let removed = false;
        for (const target of [bodyPath, sidecarPath]) {
            try {
                await fs.unlink(target);
                removed = true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
        }
        return removed;
    }

    /**
     * EW-641 Phase 2/e row 37 — write the org overlay sidecar + body
     * for a single org-scope document into a Work's repo. The
     * `.org/` first segment is applied here AFTER `doc.path` has been
     * validated, so a malicious `path` field on the org doc row
     * cannot escape `.content/kb/.org/`.
     */
    private async writeOrgDocumentFiles(
        repoDir: string,
        doc: WorkKnowledgeDocument,
    ): Promise<void> {
        KnowledgeBaseGitMirrorService.validateRelativeKbPath(doc.path);

        const kbRoot = path.join(repoDir, KnowledgeBaseGitMirrorService.KB_ROOT);
        const orgRoot = path.join(kbRoot, KnowledgeBaseGitMirrorService.ORG_OVERLAY_DIR);
        const sidecarPath = this.resolveInsideKbRoot(
            kbRoot,
            path.posix.join(
                KnowledgeBaseGitMirrorService.ORG_OVERLAY_DIR,
                this.sidecarPath(doc.path),
            ),
        );
        const bodyPath = this.resolveInsideKbRoot(
            kbRoot,
            path.posix.join(KnowledgeBaseGitMirrorService.ORG_OVERLAY_DIR, doc.path),
        );

        await fs.mkdir(path.dirname(sidecarPath), { recursive: true });

        const sidecar = this.buildSidecar(doc);
        // Tag the sidecar so a Work owner reading the file knows it's
        // an inherited org overlay, not their own doc. The flag stays
        // out of the platform DTOs (the row's `organizationId` carries
        // the truth there); this is purely a filesystem affordance.
        sidecar.source = 'org-overlay';
        sidecar.organizationId = doc.organizationId;
        await fs.writeFile(sidecarPath, yaml.stringify(sidecar), 'utf-8');

        const body = this.readBody(doc);
        await fs.writeFile(bodyPath, body, 'utf-8');

        // Ensure the org root exists even when only the body was
        // written via the sidecar's parent-dir creation above.
        await fs.mkdir(orgRoot, { recursive: true });
    }

    /**
     * EW-641 Phase 2/e row 37 — counterpart of `writeOrgDocumentFiles`.
     * Removes both files under `.content/kb/.org/<doc.path>` and its
     * `.yml` sidecar; returns whether anything was actually deleted
     * so the commit message can distinguish a real delete from an
     * idempotent rerun.
     */
    private async removeOrgDocumentFiles(repoDir: string, relativePath: string): Promise<boolean> {
        KnowledgeBaseGitMirrorService.validateRelativeKbPath(relativePath);

        const kbRoot = path.join(repoDir, KnowledgeBaseGitMirrorService.KB_ROOT);
        const sidecarPath = this.resolveInsideKbRoot(
            kbRoot,
            path.posix.join(
                KnowledgeBaseGitMirrorService.ORG_OVERLAY_DIR,
                this.sidecarPath(relativePath),
            ),
        );
        const bodyPath = this.resolveInsideKbRoot(
            kbRoot,
            path.posix.join(KnowledgeBaseGitMirrorService.ORG_OVERLAY_DIR, relativePath),
        );

        let removed = false;
        for (const target of [bodyPath, sidecarPath]) {
            try {
                await fs.unlink(target);
                removed = true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
        }
        return removed;
    }

    /**
     * Final safety net: after the relative-path validator has run, build the
     * absolute path and confirm it still lives under `kbRoot`. Catches any
     * symlink shenanigans or edge cases the textual check missed.
     */
    private resolveInsideKbRoot(kbRoot: string, relativePath: string): string {
        const resolved = path.resolve(kbRoot, relativePath);
        const rootWithSep = kbRoot.endsWith(path.sep) ? kbRoot : kbRoot + path.sep;
        if (resolved !== kbRoot && !resolved.startsWith(rootWithSep)) {
            throw new BadRequestException(`KB document path escapes .content/kb/: ${relativePath}`);
        }
        return resolved;
    }

    /** Page size for the `.index.yml` rebuild scan. */
    private static readonly INDEX_PAGE_SIZE = 500;
    /**
     * Hard ceiling so a runaway loop can never balloon memory or commit
     * size. Per spec §21 a single Work is not expected to approach this;
     * crossing it is itself an event that needs operator attention.
     */
    private static readonly INDEX_MAX_DOCS = 100_000;

    private async writeIndex(repoDir: string, workId: string): Promise<void> {
        const documents: Array<Record<string, unknown>> = [];
        let offset = 0;
        let expectedTotal: number | null = null;

        while (true) {
            const { items, total } = await this.documentRepository.list({
                workId,
                limit: KnowledgeBaseGitMirrorService.INDEX_PAGE_SIZE,
                offset,
            });
            if (expectedTotal === null) {
                expectedTotal = total;
            }

            for (const d of items) {
                documents.push({
                    id: d.id,
                    path: d.path,
                    title: d.title,
                    class: d.kbDocumentClass,
                    tags: d.tags ?? [],
                    status: d.status,
                    locked: d.locked,
                    lock_mode: d.lockMode ?? null,
                    word_count: d.wordCount ?? null,
                    updated_at: d.updatedAt.toISOString(),
                });
                if (documents.length >= KnowledgeBaseGitMirrorService.INDEX_MAX_DOCS) {
                    break;
                }
            }

            if (
                items.length < KnowledgeBaseGitMirrorService.INDEX_PAGE_SIZE ||
                documents.length >= KnowledgeBaseGitMirrorService.INDEX_MAX_DOCS
            ) {
                break;
            }
            offset += items.length;
        }

        if (expectedTotal !== null && documents.length < expectedTotal) {
            // The cap fired before we drained the result set — log loudly so
            // operators can see a Work has crossed the hard ceiling instead
            // of silently writing a stale catalogue (Greptile / Codex P2).
            this.logger.warn(
                `KB index for work ${workId} truncated at ${documents.length} of ${expectedTotal} documents (cap ${KnowledgeBaseGitMirrorService.INDEX_MAX_DOCS})`,
            );
        }

        const payload = {
            generated_at: new Date().toISOString(),
            generator: KnowledgeBaseGitMirrorService.INDEX_GENERATOR,
            version: KnowledgeBaseGitMirrorService.INDEX_VERSION,
            documents,
        };

        const indexPath = path.join(
            repoDir,
            KnowledgeBaseGitMirrorService.KB_ROOT,
            KnowledgeBaseGitMirrorService.INDEX_FILE,
        );
        await fs.writeFile(indexPath, yaml.stringify(payload), 'utf-8');
    }

    private async commitAndPush(
        work: Work,
        dir: string,
        message: string,
        committer: { name: string; email: string },
    ): Promise<string | null> {
        const providerId = work.gitProvider;

        await this.gitFacade.addAll(providerId, dir);

        const status = await this.gitFacade.getStatus(providerId, dir);
        if (status.length === 0) {
            return null;
        }

        const sha = await this.gitFacade.commit(providerId, dir, message, committer);
        if (!sha) {
            return null;
        }

        const workOwner = work.user as User | undefined;
        if (!workOwner?.id) {
            throw new NotFoundException(
                `Work owner missing — cannot push KB commit for ${work.id}`,
            );
        }

        await this.gitFacade.push(
            { dir },
            {
                providerId,
                userId: workOwner.id,
                workId: work.id,
            },
        );

        return sha;
    }

    private buildSidecar(doc: WorkKnowledgeDocument): Record<string, unknown> {
        // snake_case keys per spec §7.3 (matches works.yml convention).
        return {
            id: doc.id,
            slug: doc.slug,
            title: doc.title,
            description: doc.description ?? null,
            class: doc.kbDocumentClass,
            status: doc.status,
            language: doc.language,
            tags: doc.tags ?? [],
            categories: doc.categories ?? [],
            locked: doc.locked,
            lock_mode: doc.lockMode ?? null,
            source: doc.source,
            source_upload_id: doc.sourceUploadId ?? null,
            source_url: doc.sourceUrl ?? null,
            generated_by_agent_run_id: doc.generatedByAgentRunId ?? null,
            created_at: doc.createdAt.toISOString(),
            updated_at: doc.updatedAt.toISOString(),
            word_count: doc.wordCount ?? null,
            token_count: doc.tokenCount ?? null,
        };
    }

    private readBody(doc: WorkKnowledgeDocument): string {
        const meta = (doc.metadata ?? {}) as { body?: unknown };
        return typeof meta.body === 'string' ? meta.body : '';
    }

    private sidecarPath(bodyPath: string): string {
        // `brand/voice.md` -> `brand/voice.yml`
        const ext = path.extname(bodyPath);
        const stem = ext ? bodyPath.slice(0, -ext.length) : bodyPath;
        return `${stem}.yml`;
    }

    private slugFromPath(bodyPath: string): string {
        const last = bodyPath.split('/').pop() ?? bodyPath;
        const ext = path.extname(last);
        return ext ? last.slice(0, -ext.length) : last;
    }

    private emptyIndex(): string {
        return yaml.stringify({
            generated_at: new Date(0).toISOString(),
            generator: KnowledgeBaseGitMirrorService.INDEX_GENERATOR,
            version: KnowledgeBaseGitMirrorService.INDEX_VERSION,
            documents: [],
        });
    }

    private decodeFileContent(file: { content: string; encoding: string }): string {
        if (file.encoding === 'base64') {
            return Buffer.from(file.content, 'base64').toString('utf-8');
        }
        return file.content;
    }

    private countWords(body: string): number {
        if (!body) return 0;
        return body.split(/\s+/).filter(Boolean).length;
    }
}
