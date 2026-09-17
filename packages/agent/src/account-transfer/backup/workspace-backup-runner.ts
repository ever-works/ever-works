import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
    BACKUP_DEFAULT_LIMITS,
    BACKUP_DOMAINS,
    buildBackupArchiveFilename,
    type BackupDomainKey,
    type BackupDomainStatus,
    type BackupOmission,
    type BackupTrimReport,
} from '@ever-works/contracts';
import { WorkspaceBackupRepository } from '../../database/repositories/workspace-backup.repository';
import type { WorkspaceBackup } from '../../entities/workspace-backup.entity';
import { BackupArchiveTooLargeError, BackupArchiveWriter } from './backup-archive-writer';
import {
    buildManifest,
    countCompleteDomains,
    hasGaps,
    summarizeManifest,
    type BackupDomainOutcome,
} from './backup-manifest';
import { buildReadme } from './backup-readme';
import { TypeOrmBackupRowSource } from './backup-row-source';
import { BACKUP_STORAGE, type BackupStorage } from './backup-storage';
import {
    BACKUP_WORK_CONTENT,
    type BackupWorkContent,
    type BackupWorkContentSource,
} from './backup-work-content';
import { getBackupCollector } from './collectors';
import type {
    BackupCollectContext,
    BackupFilePlan,
    BackupScope,
    QueuedBackupFile,
} from './collectors/collector.types';

/**
 * Workspace backup (AW-22) — one run of one backup.
 *
 * The runner is the only thing that knows the shape of a whole archive: it
 * claims the row, walks the fifteen domains in published order, writes the
 * manifest, the README and the checksums, hands the stream to storage, and
 * settles the record. Everything else is deliberately unaware of it — the
 * collectors just yield rows, the writer just makes a zip, the storage
 * accessor just takes a stream.
 *
 * ## What makes it survive a bad day
 *
 * - **A domain that throws costs its domain.** Each query gets two retries
 *   inside the collector; when they are spent the domain is marked `failed`
 *   or `partial` with an error code and the archive still completes with the
 *   other fourteen, the coverage summary showing the shortfall (spec FR-17,
 *   S-13). This is only cheap because the domains do not share a
 *   transaction.
 * - **It reports for itself.** A heartbeat after every domain and every page
 *   means a worker that dies is noticed in ten minutes by the sweeper rather
 *   than leaving a backup at "running" forever (spec FR-5, S-14).
 * - **It can be stopped.** Cancellation is checked between domains and
 *   between pages; an abort destroys the zip stream so no partial object is
 *   left on storage (spec FR-8).
 * - **It knows its ceiling before it starts.** The archive limit depends on
 *   whether the active storage backend can take a stream — a backend that
 *   cannot is a smaller ceiling, never a wrong result (spec FR-16).
 *
 * ## Work content comes from the Work's own repo
 *
 * `data/works/content/<slug>/` holds each Work's items, categories, tags,
 * collections and comparisons. None of that is in our database — it lives in
 * the Work's own data repository — so it is read through
 * {@link BackupWorkContentSource}, whose single implementation delegates to
 * the clone-or-pull walk the account export has always used. The archive
 * therefore carries everything `GET /api/account/export` carries and more,
 * and there is still exactly one implementation of "read a Work's items out
 * of its data repo" (Constitution III).
 *
 * The Work refs are paged with the works collector's OWN scope-narrowed
 * query rather than a query this file builds, so there is no second place a
 * workspace predicate could be forgotten. A Work whose repo will not clone
 * costs that Work its content and marks the domain `partial` — never the
 * archive, and never silently.
 */

/** What the runner produced, as the service and the task see it. */
export interface WorkspaceBackupRunResult {
    readonly status: 'ready' | 'ready_with_gaps' | 'failed' | 'cancelled' | 'skipped';
    readonly reason?: string;
    readonly backupId: string;
}

/** Everything the runner needs that is not on the row. */
export interface WorkspaceBackupRunOptions {
    /** Workspace identity written into the manifest (spec FR-11). */
    readonly workspace: {
        readonly id: string;
        readonly slug: string;
        readonly displayName: string;
        readonly kind: 'organization' | 'personal';
    };
    readonly account: { readonly id: string; readonly displayName: string; readonly email: string };
    readonly build: string;
    readonly instance?: string;
    readonly retentionDays?: number;
    readonly formatReferenceUrl?: string;
}

const HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_FORMAT_REFERENCE = 'https://docs.ever.works/features/workspace-backup';

@Injectable()
export class WorkspaceBackupRunner {
    private readonly logger = new Logger(WorkspaceBackupRunner.name);

    constructor(
        private readonly backups: WorkspaceBackupRepository,
        @InjectDataSource() private readonly dataSource: DataSource,
        // Every dependency here is @Optional() and appended last, so an
        // existing construction site keeps compiling and a deployment
        // without the binding degrades rather than failing to boot.
        @Optional() @Inject(BACKUP_STORAGE) private readonly storage?: BackupStorage,
        @Optional()
        @Inject(BACKUP_WORK_CONTENT)
        private readonly workContent?: BackupWorkContentSource,
    ) {}

    /**
     * Produce the archive for one backup row.
     *
     * Returns rather than throws for every outcome the operator cannot act
     * on — a row that vanished, a row someone else already claimed, a
     * cancelled run — so the job runtime acks instead of retrying a payload
     * that will never succeed. Only genuine infrastructure failures throw.
     */
    async run(
        backupId: string,
        options: WorkspaceBackupRunOptions,
    ): Promise<WorkspaceBackupRunResult> {
        const row = await this.dataSource
            .getRepository<WorkspaceBackup>('WorkspaceBackup')
            .findOne({
                where: { id: backupId },
            });
        if (!row) {
            return { status: 'skipped', reason: 'backup-not-found', backupId };
        }
        if (row.status !== 'queued') {
            return { status: 'skipped', reason: 'already-terminal', backupId };
        }
        if (!this.storage) {
            await this.fail(backupId, 'internal', 'No storage backend is configured for archives');
            return { status: 'failed', reason: 'internal', backupId };
        }

        const startedAt = new Date();
        if (!(await this.backups.claimForRun(backupId, startedAt))) {
            return { status: 'skipped', reason: 'already-claimed', backupId };
        }

        try {
            return await this.produce(row, startedAt, options, this.storage);
        } catch (error) {
            if (error instanceof BackupArchiveTooLargeError) {
                await this.fail(backupId, 'too_large', error.message);
                return { status: 'failed', reason: 'too_large', backupId };
            }
            const detail = error instanceof Error ? error.message : String(error);
            this.logger.error(`Workspace backup ${backupId} failed: ${detail}`);
            await this.fail(backupId, 'internal', detail);
            return { status: 'failed', reason: 'internal', backupId };
        }
    }

    /**
     * Resolve who and what this archive is for, then run it.
     *
     * The identity is read HERE rather than carried in the job payload: a
     * runtime replays the original payload on a retry, so a workspace
     * renamed between enqueue and run would otherwise be archived under its
     * old name and the manifest would quietly disagree with the product
     * (spec FR-11).
     */
    async runFromPayload(payload: {
        backupId: string;
        userId: string;
        organizationId?: string | null;
    }): Promise<WorkspaceBackupRunResult> {
        const user = await this.dataSource
            .getRepository<{ id: string; name?: string | null; email: string }>('User')
            .findOne({ where: { id: payload.userId } });

        const organization = payload.organizationId
            ? await this.dataSource
                  .getRepository<{
                      id: string;
                      name?: string | null;
                      slug?: string | null;
                  }>('Organization')
                  .findOne({ where: { id: payload.organizationId } })
            : null;

        const workspace = organization
            ? {
                  id: organization.id,
                  slug: organization.slug ?? organization.id,
                  displayName: organization.name ?? organization.id,
                  kind: 'organization' as const,
              }
            : {
                  id: payload.userId,
                  slug: (user?.email ?? payload.userId).split('@')[0] ?? payload.userId,
                  displayName: user?.name ?? user?.email ?? payload.userId,
                  kind: 'personal' as const,
              };

        return this.run(payload.backupId, {
            workspace,
            account: {
                id: payload.userId,
                displayName: user?.name ?? user?.email ?? payload.userId,
                email: user?.email ?? '',
            },
            build: process.env.EVER_WORKS_BUILD ?? 'development',
        });
    }

    private async produce(
        row: WorkspaceBackup,
        startedAt: Date,
        options: WorkspaceBackupRunOptions,
        storage: BackupStorage,
    ): Promise<WorkspaceBackupRunResult> {
        await storage.warmUp?.();

        const limits = BACKUP_DEFAULT_LIMITS;
        const maxArchiveBytes = storage.supportsStreaming()
            ? limits.maxArchiveBytes
            : limits.maxBufferedArchiveBytes;

        const writer = new BackupArchiveWriter({
            maxArchiveBytes,
            maxAttachmentBytes: limits.maxAttachmentBytes,
            maxFileBytes: limits.maxFileBytes,
        });

        const scope: BackupScope = {
            userId: row.userId,
            organizationId: row.organizationId ?? null,
            tenantId: row.tenantId ?? null,
        };

        const filename = buildBackupArchiveFilename(
            options.workspace.slug,
            startedAt.toISOString(),
            row.id.slice(0, 6),
        );

        // The upload starts consuming the stream immediately, so the archive
        // never accumulates anywhere: bytes leave for storage as fast as the
        // collectors produce them.
        const upload = storage
            .putArchive(writer.stream, { filename, ownerId: row.userId })
            .catch((error: unknown) => ({ error }) as const);

        const cancelled = { value: false };
        const queuedFiles: QueuedBackupFile[] = [];
        const registeredIds = new Map<string, { ids: readonly string[]; complete: boolean }>();
        let lastHeartbeat = Date.now();

        /**
         * The throttled progress report, and the live cancellation signal.
         *
         * `heartbeat()` is bounded to `status = 'running'` and returns
         * whether it matched a row, so a `false` is exactly "this backup is
         * no longer running" — which after `requestCancel` means the owner
         * cancelled. Reading that return is what makes `shouldStop()` true
         * between pages; without it the only cancel probe was at a domain
         * boundary, so a cancel issued while `activity` paged a
         * multi-million-row table bought nothing until that whole domain
         * finished, contradicting both doc comments that promise otherwise.
         */
        const heartbeat = async (): Promise<void> => {
            if (Date.now() - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
            lastHeartbeat = Date.now();
            if (!(await this.backups.heartbeat(row.id, {}))) {
                cancelled.value = true;
            }
        };

        const context: BackupCollectContext = {
            scope,
            includeFullHistory: row.includeFullHistory,
            now: startedAt,
            source: new TypeOrmBackupRowSource(this.dataSource),
            pageSize: DEFAULT_PAGE_SIZE,
            enqueueFile: (file) => queuedFiles.push(file),
            registerIds: (name, ids, complete = true) => registeredIds.set(name, { ids, complete }),
            idsFor: (name) => registeredIds.get(name)?.ids ?? [],
            // An unregistered name is the "no rows" case, which is honest.
            idsComplete: (name) => registeredIds.get(name)?.complete ?? true,
            shouldStop: () => cancelled.value,
            heartbeat,
        };

        const outcomes: BackupDomainOutcome[] = [];
        const total = BACKUP_DOMAINS.length;

        for (const [index, descriptor] of BACKUP_DOMAINS.entries()) {
            if (await this.isCancelled(row.id)) {
                cancelled.value = true;
                writer.abort('cancelled by the owner');
                return { status: 'cancelled', backupId: row.id };
            }

            await this.backups.heartbeat(row.id, {
                progressPercent: Math.round((index / total) * 100),
                currentDomain: descriptor.key,
                domainsCompleted: index,
            });
            lastHeartbeat = Date.now();

            const { outcome, plans } = await this.runDomain(descriptor.key, context, writer);

            // The Works domain is the only one whose content lives outside
            // our database, so it is the only one with a second pass.
            outcomes.push(
                descriptor.key === 'works'
                    ? await this.addWorkContent(outcome, plans, context, writer, descriptor.dataDir)
                    : outcome,
            );
        }

        const omissions = await this.copyFiles(queuedFiles, writer, storage, heartbeat);

        const manifest = buildManifest({
            producedAt: startedAt,
            build: options.build,
            ...(options.instance ? { instance: options.instance } : {}),
            workspace: options.workspace,
            account: options.account,
            includeFullHistory: row.includeFullHistory,
            outcomes,
            filesIncluded: queuedFiles.length - omissions.length,
            fileBytes: writer.attachmentBytes,
            omissions,
            archiveBytes: writer.bytesWritten,
        });

        await writer.addTextEntry('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
        await writer.addTextEntry(
            'README.md',
            buildReadme({
                manifest,
                retentionDays: options.retentionDays ?? limits.retentionDays,
                formatReferenceUrl: options.formatReferenceUrl ?? DEFAULT_FORMAT_REFERENCE,
            }),
        );
        await writer.addChecksums();

        // The last report before the two operations that can take longest —
        // flushing the zip and finishing the upload — so a large archive
        // does not look stalled to the sweeper at the very end.
        await heartbeat();

        const archive = await writer.close();
        const stored = await upload;
        if ('error' in stored) {
            await this.fail(
                row.id,
                'storage_unavailable',
                stored.error instanceof Error ? stored.error.message : String(stored.error),
            );
            return { status: 'failed', reason: 'storage_unavailable', backupId: row.id };
        }

        const finishedAt = new Date();
        const retentionDays = options.retentionDays ?? limits.retentionDays;
        const gaps = hasGaps(manifest);

        const settled = await this.backups.markTerminal(
            row.id,
            {
                status: gaps ? 'ready_with_gaps' : 'ready',
                finishedAt,
                progressPercent: 100,
                currentDomain: null,
                domainsCompleted: countCompleteDomains(manifest),
                domainsTotal: total,
                manifestSummary: summarizeManifest(manifest),
                storageBackend: stored.backend,
                storageKey: stored.key,
                sizeBytes: archive.bytes,
                sha256: archive.sha256,
                fileCount: manifest.files.included,
                omittedFileCount: omissions.length,
                expiresAt: new Date(finishedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000),
                lastHeartbeatAt: finishedAt,
            },
            ['running'],
        );

        if (!settled) {
            // The row left `running` while the archive was being written —
            // an owner cancelled during the copy phase, or the stall sweep
            // landed in it. The compare-and-set matched nothing, so
            // `storageKey` was never recorded, and the object that WAS
            // uploaded is now unreachable: expiry only visits ready rows,
            // "delete now" needs a storage key, and the prune pass removes
            // the record precisely BECAUSE the key is null. That is a
            // permanent, billable orphan on an object store, so the object
            // goes with the outcome that won.
            await this.discardOrphan(stored.key, storage);
            const current = await this.dataSource
                .getRepository<WorkspaceBackup>('WorkspaceBackup')
                .findOne({ where: { id: row.id }, select: { id: true, status: true } });
            this.logger.warn(
                `Workspace backup ${row.id} settled elsewhere as ${current?.status ?? 'unknown'}; discarded the archive it had already produced`,
            );
            return {
                status: current?.status === 'cancelled' ? 'cancelled' : 'failed',
                reason: current?.status ?? 'settled-elsewhere',
                backupId: row.id,
            };
        }

        return { status: gaps ? 'ready_with_gaps' : 'ready', backupId: row.id };
    }

    /** Remove an archive no row will ever reference. Best effort by design. */
    private async discardOrphan(key: string, storage: BackupStorage): Promise<void> {
        await storage.deleteArchive(key).catch((error: unknown) => {
            this.logger.warn(
                `Could not delete the orphaned archive ${key}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        });
    }

    /**
     * One domain.
     *
     * Nothing here retries: the two retries of spec FR-17 live on the
     * individual query inside the collector, where a transient failure can
     * actually be resumed. What this method owns is the consequence — a
     * domain whose rows stopped arriving is marked `failed` with an error
     * code and the walk moves on, so the archive completes with the other
     * fourteen (spec S-13).
     */
    private async runDomain(
        key: BackupDomainKey,
        context: BackupCollectContext,
        writer: BackupArchiveWriter,
    ): Promise<{ outcome: BackupDomainOutcome; plans: readonly BackupFilePlan[] }> {
        const collector = getBackupCollector(key);
        if (!collector) {
            return {
                outcome: {
                    key,
                    status: 'failed',
                    records: 0,
                    files: [],
                    errorCode: 'collector_missing',
                },
                plans: [],
            };
        }

        const descriptor = BACKUP_DOMAINS.find((domain) => domain.key === key);
        const dataDir = descriptor?.dataDir ?? key;
        let planned: readonly BackupFilePlan[] = [];

        try {
            const plans = await collector.plan(context);
            planned = plans;
            const files: BackupDomainOutcome['files'] = [];
            let records = 0;
            let unavailable = 0;
            let failure: unknown;
            // A plan that named its own shortfall before a single row was
            // read — today, a `parent` file whose id list came from a
            // registration that did not finish. Without this the file is
            // written with zero records and no error, and the coverage table
            // says the section is EMPTY for data that was never read.
            let planCode: string | undefined;

            for (const plan of plans) {
                const entry = await writer.addJsonlEntry(
                    `data/${dataDir}/${plan.file}`,
                    collector.rows(context, plan),
                );
                files.push({ name: entry.name, records: entry.records, sha256: entry.sha256 });
                records += entry.records;
                if (plan.unavailable) unavailable += 1;
                if (plan.errorCode !== undefined && planCode === undefined) {
                    planCode = plan.errorCode;
                }
                if (entry.error !== undefined && failure === undefined) {
                    failure = entry.error;
                }
            }

            if (failure === undefined && planCode !== undefined) {
                return {
                    outcome: {
                        key,
                        status: records > 0 ? 'partial' : 'failed',
                        records,
                        files,
                        errorCode: planCode,
                    },
                    plans: planned,
                };
            }

            if (failure !== undefined) {
                // Some rows landed and some did not. The files are honest —
                // every count still matches its line count — and the domain
                // says so rather than looking complete.
                return {
                    outcome: {
                        key,
                        status: records > 0 ? 'partial' : 'failed',
                        records,
                        files,
                        errorCode: this.errorCodeFor(failure),
                    },
                    plans: planned,
                };
            }

            const trims = await collector.trims(context, plans);
            return {
                outcome: {
                    key,
                    status: this.domainStatus(records, unavailable, plans, trims),
                    records,
                    files,
                    ...(trims.length > 0 ? { trims } : {}),
                },
                plans: planned,
            };
        } catch (error) {
            if (writer.abortReason) {
                throw writer.abortReason;
            }
            this.logger.warn(
                `Backup domain ${key} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return {
                outcome: {
                    key,
                    status: 'failed',
                    records: 0,
                    files: [],
                    errorCode: this.errorCodeFor(error),
                },
                plans: planned,
            };
        }
    }

    /**
     * `data/works/content/<slug>/` — each Work's own content, read out of the
     * Work's data repository through {@link BackupWorkContentSource}.
     *
     * The Works to visit are paged with the works collector's own
     * scope-narrowed query, so this method never builds a workspace predicate
     * of its own. A Work whose repo will not clone yields empty content (the
     * source's contract), and a Work whose read throws outright downgrades the
     * domain to `partial` with `work_content_unavailable` — the other Works,
     * the Work rows and the other fourteen domains all still ship.
     */
    private async addWorkContent(
        outcome: BackupDomainOutcome,
        plans: readonly BackupFilePlan[],
        context: BackupCollectContext,
        writer: BackupArchiveWriter,
        dataDir: string,
    ): Promise<BackupDomainOutcome> {
        const rootPlan = plans.find((plan) => plan.spec.registerIdsAs === 'workIds');
        if (!this.workContent || !rootPlan || rootPlan.unavailable) {
            return outcome;
        }

        const files = [...outcome.files];
        let records = outcome.records;
        let degraded = false;

        try {
            for (const work of await this.pageWorkRefs(context, rootPlan)) {
                if (context.shouldStop()) break;

                let content: BackupWorkContent;
                try {
                    content = await this.workContent.readWorkContent(work);
                } catch (error) {
                    this.logger.warn(
                        `Backup could not read content for work ${work.slug}: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                    degraded = true;
                    continue;
                }

                const base = `data/${dataDir}/content/${this.safeName(work.slug)}`;
                const groups: readonly [string, readonly Record<string, unknown>[]][] = [
                    ['items', content.items],
                    ['categories', content.categories],
                    ['tags', content.tags],
                    ['collections', content.collections],
                    ['comparisons', content.comparisons],
                ];

                for (const [name, rows] of groups) {
                    const entry = await writer.addJsonlEntry(
                        `${base}/${name}.jsonl`,
                        toAsyncIterable(rows),
                    );
                    files.push({
                        name: entry.name,
                        records: entry.records,
                        sha256: entry.sha256,
                    });
                    records += entry.records;
                }

                // The two singletons are objects, not row sets, so they are
                // written as JSON and contribute no record count.
                if (content.siteConfig) {
                    const entry = await writer.addTextEntry(
                        `${base}/site-config.json`,
                        `${JSON.stringify(content.siteConfig, null, 2)}\n`,
                    );
                    files.push({ name: entry.name, records: 0, sha256: entry.sha256 });
                }
                if (content.markdownTemplate) {
                    const entry = await writer.addTextEntry(
                        `${base}/markdown-template.json`,
                        `${JSON.stringify(content.markdownTemplate, null, 2)}\n`,
                    );
                    files.push({ name: entry.name, records: 0, sha256: entry.sha256 });
                }

                await context.heartbeat();
            }
        } catch (error) {
            if (writer.abortReason) {
                throw writer.abortReason;
            }
            this.logger.warn(
                `Backup work content pass failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            degraded = true;
        }

        if (degraded) {
            return {
                ...outcome,
                status: 'partial',
                records,
                files,
                errorCode: outcome.errorCode ?? 'work_content_unavailable',
            };
        }

        return {
            ...outcome,
            status: outcome.status === 'empty' && records > 0 ? 'complete' : outcome.status,
            records,
            files,
        };
    }

    /** Work ids and slugs, paged with the collector's own scoped query. */
    private async pageWorkRefs(
        context: BackupCollectContext,
        plan: BackupFilePlan,
    ): Promise<{ id: string; slug: string }[]> {
        const refs: { id: string; slug: string }[] = [];
        let offset = 0;

        for (;;) {
            const page = await context.source.page(plan.query, offset, context.pageSize);
            for (const row of page) {
                const id = row['id'];
                if (typeof id !== 'string') continue;
                const slug = row['slug'];
                refs.push({ id, slug: typeof slug === 'string' && slug ? slug : id });
            }
            offset += page.length;
            if (page.length < context.pageSize) break;
        }

        return refs;
    }

    private domainStatus(
        records: number,
        unavailable: number,
        plans: readonly BackupFilePlan[],
        trims: readonly BackupTrimReport[],
    ): BackupDomainStatus {
        if (unavailable > 0 && unavailable < plans.length) {
            return 'partial';
        }
        if (records === 0) {
            return 'empty';
        }
        return trims.length > 0 ? 'trimmed' : 'complete';
    }

    /**
     * Copy queued upload bytes into `files/<id>/<filename>` until the
     * attachment budget runs out. Everything left out is listed in the
     * manifest with its id, name, size and reason, so the owner can fetch
     * those individually (spec FR-15, S-11). The structured data is complete
     * either way.
     */
    private async copyFiles(
        queued: readonly QueuedBackupFile[],
        writer: BackupArchiveWriter,
        storage: BackupStorage,
        heartbeat: () => Promise<void>,
    ): Promise<BackupOmission[]> {
        const omissions: BackupOmission[] = [];

        for (const file of queued) {
            // One report per file. With a 2 GiB attachment budget over a
            // remote object store this phase can run far past the ten-minute
            // stall window, and it used to be completely silent — so the
            // sweeper failed backups that were working perfectly, and the
            // archive they went on to produce became an orphan nothing could
            // reach or delete. `heartbeat` throttles itself to 25 s.
            await heartbeat();

            const verdict = writer.canAcceptFile(file.sizeBytes);
            if (!verdict.accepted) {
                omissions.push({
                    id: file.id,
                    name: file.filename,
                    sizeBytes: file.sizeBytes,
                    reason: verdict.reason ?? 'size_limit',
                });
                continue;
            }

            try {
                const object = await storage.readObject(file.storageKey);
                await writer.addFileEntry(
                    `files/${file.id}/${this.safeName(file.filename)}`,
                    object.stream,
                    file.sizeBytes,
                );
            } catch {
                // The metadata row is already written; the bytes simply are
                // not there any more. Say so rather than failing the archive.
                omissions.push({
                    id: file.id,
                    name: file.filename,
                    sizeBytes: file.sizeBytes,
                    reason: 'file_missing',
                });
            }
        }

        return omissions;
    }

    /** Keep a stored filename from becoming a path when it lands in the zip. */
    private safeName(filename: string): string {
        const base = filename.replace(/[\\/]+/g, '_').replace(/^\.+/, '_');
        return base.length > 0 ? base.slice(0, 200) : 'file';
    }

    private async isCancelled(backupId: string): Promise<boolean> {
        const current = await this.dataSource
            .getRepository<WorkspaceBackup>('WorkspaceBackup')
            .findOne({ where: { id: backupId }, select: { id: true, status: true } });
        return !current || current.status !== 'running';
    }

    private async fail(backupId: string, reason: string, detail: string): Promise<void> {
        await this.backups.markTerminal(backupId, {
            status: 'failed',
            failureReason: reason,
            failureDetail: detail.slice(0, 2000),
            finishedAt: new Date(),
            currentDomain: null,
        });
    }

    private errorCodeFor(error: unknown): string {
        if (error instanceof Error && error.name) {
            return error.name;
        }
        return 'domain_failed';
    }
}

/** Hand an in-memory row group to the writer, which only speaks async iterables. */
async function* toAsyncIterable(
    rows: readonly Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
    for (const row of rows) {
        yield row;
    }
}
