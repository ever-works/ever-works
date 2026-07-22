import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { IStoragePlugin } from '@ever-works/plugin';
import { config } from '../config';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import { KbUploadExtractionStatus } from '../entities/kb-types';
import { KB_STORAGE_PLUGIN } from './knowledge-base.service';

/**
 * EW-643 Phase 3 slice 4a — daily KB reconciliation sweep.
 *
 * Two cross-checks run end-to-end in one tick:
 *
 *   1. **Stale extractions** — uploads stuck in `extractionStatus='running'`
 *      whose `extractionStartedAt` is older than
 *      `KB_RECONCILE_STALE_AFTER_MS` (default 24h). These are flipped to
 *      `failed` with `extractionError='reconcile: stale extraction'` so
 *      the workbench surfaces the dead row to the user. The 24h default
 *      is comfortably longer than the kb-transcribe task's 30-minute
 *      `maxDuration` plus retry budget, so a slow-but-legitimate retry
 *      isn't mistaken for a dead row.
 *
 *   2. **Orphan storage objects** — keys under `kb-originals/` that no
 *      live upload row references via either `storagePath` or
 *      `metadata.normalizedStoragePath`. These are *logged only* — never
 *      deleted. The spec requires that delete-blind reconcile so an
 *      operator can investigate before bytes vanish (e.g. a Postgres
 *      restore that rolled the rows back while object storage kept the
 *      file). Slice 4b adds an opt-in GC path.
 *
 * Storage scan is best-effort: backends that don't implement an
 * optional `listObjects(prefix)` method skip step 2 entirely (the
 * service logs a single warning per tick). The stale-uploads step still
 * runs — it relies only on DB rows, not the storage plugin.
 *
 * Telemetry: emits `kb.reconcile.completed` via the typed kb-events
 * helper. The privacy guard inside the helper will throw if any caller
 * accidentally includes body-ish fields; this service only ships
 * hit-count style counters + durationMs.
 */

/**
 * Optional listing capability layered on top of `IStoragePlugin`.
 * Backends that can enumerate by prefix expose this; backends that
 * can't (e.g. `github-storage` in some modes) leave it unset and
 * reconcile skips the orphan scan for that backend.
 *
 * Declared as a separate shape rather than added to `IStoragePlugin`
 * to keep the storage contract minimal — only the reconcile sweep
 * needs enumeration today.
 */
export interface StorageListingBackend {
    listObjects?(prefix: string): Promise<Array<{ key: string }>>;
}

/**
 * Minimal capture surface — kept narrow so the API module can wire
 * the real PostHog client without this service taking a runtime dep
 * on `@ever-works/monitoring`. Matches the shape consumed by
 * `emitKbEvent`.
 */
export interface KbReconcilePostHogClient {
    capture(input: {
        distinctId: string;
        event: string;
        properties?: Record<string, unknown>;
    }): void;
}

/**
 * DI token for the optional PostHog capture client used by the
 * reconcile telemetry emit. Optional everywhere — without it the
 * service still runs and returns its summary, it just skips the
 * `kb.reconcile.completed` event.
 */
export const KB_RECONCILE_POSTHOG_CLIENT = 'KB_RECONCILE_POSTHOG_CLIENT';

export interface ReconcileSummary {
    /** Storage objects whose key matches no live upload row. */
    orphanedObjects: number;
    /** Upload rows force-marked `failed` because they sat in `running` too long. */
    staleUploads: number;
}

const KB_ORIGINALS_PREFIX = 'kb-originals/';
const STORAGE_CAPABILITY_WARN_ONCE = new WeakSet<object>();

@Injectable()
export class KnowledgeBaseReconcileService {
    private readonly logger = new Logger(KnowledgeBaseReconcileService.name);

    constructor(
        private readonly uploads: WorkKnowledgeUploadRepository,
        // Optional so consumers that import KnowledgeBaseModule but never run a
        // reconcile (e.g. internal-cli's WorkModule import chain, which bootstraps
        // the whole Nest graph without wiring KbStorageModule) still CONSTRUCT.
        // The API provides KB_STORAGE_PLUGIN via the @Global() KbStorageModule.
        // Mirrors KnowledgeBaseMediaNormalizeService, whose KB_STORAGE_PLUGIN is
        // @Optional() for exactly this reason — without it the CLI bootstrap dies
        // with "Nest can't resolve dependencies of the KnowledgeBaseReconcileService
        // … KB_STORAGE_PLUGIN at index [1]". `findOrphanObjects` guards on it below.
        @Optional()
        @Inject(KB_STORAGE_PLUGIN)
        private readonly storage?: IStoragePlugin & StorageListingBackend,
        @Optional()
        @Inject(KB_RECONCILE_POSTHOG_CLIENT)
        private readonly posthog?: KbReconcilePostHogClient,
    ) {}

    async reconcile(opts: { workId?: string } = {}): Promise<ReconcileSummary> {
        const startedAt = Date.now();
        const staleUploads = await this.markStaleUploads(opts);
        const orphanedObjects = await this.findOrphanObjects(opts);

        const durationMs = Date.now() - startedAt;
        this.logger.log(
            `kb-reconcile completed workId=${opts.workId ?? '*'} staleUploads=${staleUploads} orphanedObjects=${orphanedObjects} durationMs=${durationMs}`,
        );
        this.emitTelemetry({
            workId: opts.workId,
            staleUploads,
            orphanedObjects,
            durationMs,
        });

        return { orphanedObjects, staleUploads };
    }

    private async markStaleUploads(opts: { workId?: string }): Promise<number> {
        const cutoff = new Date(Date.now() - config.kb.getReconcileStaleAfterMs());
        const stale = await this.uploads.findStaleRunning({
            olderThan: cutoff,
            workId: opts.workId,
        });
        if (stale.length === 0) return 0;

        let marked = 0;
        for (const row of stale) {
            try {
                await this.uploads.update(row.id, {
                    extractionStatus: KbUploadExtractionStatus.FAILED,
                    extractionError: 'reconcile: stale extraction',
                    extractionFinishedAt: new Date(),
                });
                marked += 1;
                this.logger.warn(
                    `kb-reconcile marked upload ${row.id} (work ${row.workId}) as failed — stuck in running since ${row.extractionStartedAt?.toISOString?.() ?? '?'}`,
                );
            } catch (cause) {
                const error = cause instanceof Error ? cause.message : String(cause);
                this.logger.error(
                    `kb-reconcile: failed to flip upload ${row.id} to failed: ${error}`,
                );
            }
        }
        return marked;
    }

    private async findOrphanObjects(opts: { workId?: string }): Promise<number> {
        // Storage is @Optional() (see the constructor) — absent in DI scopes that
        // import KnowledgeBaseModule without KbStorageModule. The orphan scan is
        // the only step that needs it; skip it (markStaleUploads still runs) rather
        // than crash, exactly as the missing-listObjects() case below does.
        if (!this.storage) {
            if (!STORAGE_CAPABILITY_WARN_ONCE.has(this)) {
                STORAGE_CAPABILITY_WARN_ONCE.add(this);
                this.logger.warn(
                    'kb-reconcile: KB_STORAGE_PLUGIN is not provided in this DI scope — ' +
                        'skipping orphan scan. Wire KbStorageModule to enable it.',
                );
            }
            return 0;
        }
        if (typeof this.storage.listObjects !== 'function') {
            // Warn once per storage instance — the cron runs daily; one log
            // line per backend is enough signal without flooding aggregation.
            if (!STORAGE_CAPABILITY_WARN_ONCE.has(this.storage)) {
                STORAGE_CAPABILITY_WARN_ONCE.add(this.storage);
                this.logger.warn(
                    `kb-reconcile: storage backend "${this.storage.providerName}" does not implement listObjects() — skipping orphan scan. Set up a backend that enumerates by prefix to enable it.`,
                );
            }
            return 0;
        }

        const objects = await this.storage.listObjects(KB_ORIGINALS_PREFIX);
        if (objects.length === 0) return 0;

        const known = new Set<string>();
        const rows = await this.uploads.listStoragePaths(opts.workId);
        for (const r of rows) {
            if (r.storagePath) known.add(r.storagePath);
            if (r.normalizedStoragePath) known.add(r.normalizedStoragePath);
        }

        let orphanCount = 0;
        for (const o of objects) {
            if (known.has(o.key)) continue;
            orphanCount += 1;
            // Log only — slice 4a explicitly does NOT delete; an
            // operator investigates before bytes vanish. The key is
            // safe to log: it's a deterministic content-address path,
            // not body content.
            this.logger.warn(`kb-reconcile orphan storage object: ${o.key}`);
        }
        return orphanCount;
    }

    private emitTelemetry(input: {
        workId?: string;
        staleUploads: number;
        orphanedObjects: number;
        durationMs: number;
    }): void {
        if (!this.posthog) return;
        try {
            this.posthog.capture({
                // The reconcile sweep is system-driven — there is no end-user
                // associated with the tick. Anchor distinctId to the workId
                // when scoped, otherwise a stable system marker so PostHog
                // still groups the events sensibly.
                distinctId: input.workId ?? 'system:kb-reconcile',
                event: 'kb.reconcile.completed',
                properties: {
                    workId: input.workId ?? null,
                    actorType: 'system',
                    // Hit-count style counters only — never body content.
                    // The privacy guard in `emitKbEvent` strips forbidden
                    // keys (`body`, `content`, `snippet`, ...) but we're
                    // calling `capture()` directly here, so keep the
                    // payload strictly numeric / identifier shaped.
                    scanned: input.staleUploads + input.orphanedObjects,
                    driftCount: input.staleUploads,
                    violationCount: 0,
                    orphanCount: input.orphanedObjects,
                    tombstonedCount: 0,
                    revivedCount: 0,
                    durationMs: input.durationMs,
                },
            });
        } catch (cause) {
            // Telemetry must never take down the cron tick.
            const error = cause instanceof Error ? cause.message : String(cause);
            this.logger.warn(`kb-reconcile: telemetry emit failed: ${error}`);
        }
    }
}
