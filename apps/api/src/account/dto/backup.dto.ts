import { Exclude, Expose, Type } from 'class-transformer';
import type { BackupManifestSummary } from '@ever-works/contracts';
import type { WorkspaceBackup } from '@ever-works/agent/entities';

/**
 * Workspace backup (AW-22) — what a backup looks like over the wire.
 *
 * A response DTO rather than the entity, because four of the entity's
 * columns must never leave the server and "we happen not to select them" is
 * not a guarantee:
 *
 *  - `storageKey` addresses the object on the storage backend. A client that
 *    has it does not need our download token.
 *  - `failureDetail` is operator-facing text that may name internal hosts or
 *    quote a driver error. The card renders copy keyed off `failureReason`.
 *  - `runtimeRunId` and `credentialVersion` describe our job runtime, not
 *    the owner's backup.
 *
 * They are `@Exclude()`d here AND never assigned by {@link toBackupDto}, so
 * neither a class-transformer misconfiguration nor a future field-spread can
 * leak them on its own.
 */
export class BackupDto {
    @Expose()
    id: string;

    /** `queued` `running` `ready` `ready_with_gaps` `failed` `cancelled` `expired` `deleted`. */
    @Expose()
    status: string;

    /** `stalled` `timeout` `too_large` `storage_unavailable` `cancelled_by_user` `internal`. */
    @Expose()
    failureReason: string | null;

    @Expose()
    includeFullHistory: boolean;

    @Expose()
    formatVersion: string;

    @Expose()
    @Type(() => Date)
    requestedAt: string;

    @Expose()
    startedAt: string | null;

    @Expose()
    finishedAt: string | null;

    @Expose()
    progressPercent: number;

    /** A `BackupDomainKey`; the card renders its own translated label. */
    @Expose()
    currentDomain: string | null;

    @Expose()
    domainsCompleted: number;

    @Expose()
    domainsTotal: number;

    @Expose()
    sizeBytes: number | null;

    @Expose()
    sha256: string | null;

    @Expose()
    fileCount: number;

    @Expose()
    omittedFileCount: number;

    @Expose()
    expiresAt: string | null;

    @Expose()
    artifactDeletedAt: string | null;

    @Expose()
    downloadCount: number;

    /**
     * The coverage summary, which outlives the archive itself so the drawer
     * still works after the bytes expire (spec FR-29).
     */
    @Expose()
    manifestSummary: BackupManifestSummary | null;

    /** Which backend held it. Useful to support; never a key. */
    @Expose()
    storageBackend: string | null;

    // ── Never over the wire ──────────────────────────────────────────
    @Exclude()
    storageKey?: never;

    @Exclude()
    failureDetail?: never;

    @Exclude()
    runtimeRunId?: never;

    @Exclude()
    credentialVersion?: never;
}

/**
 * Build the response shape field by field.
 *
 * Deliberately not `plainToInstance(entity)`: an explicit projection cannot
 * carry a column nobody thought about, which is the whole reason a response
 * DTO exists here.
 */
export function toBackupDto(backup: WorkspaceBackup): BackupDto {
    const iso = (value: Date | null | undefined): string | null =>
        value ? new Date(value).toISOString() : null;

    return {
        id: backup.id,
        status: backup.status,
        failureReason: backup.failureReason ?? null,
        includeFullHistory: backup.includeFullHistory,
        formatVersion: backup.formatVersion,
        requestedAt: new Date(backup.requestedAt).toISOString(),
        startedAt: iso(backup.startedAt),
        finishedAt: iso(backup.finishedAt),
        progressPercent: backup.progressPercent,
        currentDomain: backup.currentDomain ?? null,
        domainsCompleted: backup.domainsCompleted,
        domainsTotal: backup.domainsTotal,
        sizeBytes:
            backup.sizeBytes === null || backup.sizeBytes === undefined
                ? null
                : Number(backup.sizeBytes),
        sha256: backup.sha256 ?? null,
        fileCount: backup.fileCount,
        omittedFileCount: backup.omittedFileCount,
        expiresAt: iso(backup.expiresAt),
        artifactDeletedAt: iso(backup.artifactDeletedAt),
        downloadCount: backup.downloadCount,
        manifestSummary: backup.manifestSummary ?? null,
        storageBackend: backup.storageBackend ?? null,
    } as BackupDto;
}
