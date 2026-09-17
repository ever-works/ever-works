import {
    BACKUP_DOMAINS,
    BACKUP_EXCLUSIONS,
    BACKUP_FORMAT_SENTINEL,
    BACKUP_FORMAT_VERSION,
    type BackupAccountIdentity,
    type BackupDomainKey,
    type BackupDomainReport,
    type BackupDomainStatus,
    type BackupManifest,
    type BackupManifestSummary,
    type BackupOmission,
    type BackupWorkspaceIdentity,
} from '@ever-works/contracts';

/**
 * Workspace backup (AW-22) — `manifest.json`.
 *
 * The manifest is what makes "structured data you can keep" true rather than
 * aspirational. An archive found on a disk years later has to say, without
 * our source tree: which workspace and which account it came from, which
 * build wrote it, what each of the fifteen domains contained, what was
 * trimmed and from when, which files were left out and why, what is
 * deliberately absent, and what a restore could and could not recreate.
 *
 * It is built here rather than assembled inline by the runner so the
 * published shape cannot drift from the writer: every field comes from the
 * same `@ever-works/contracts` module the API, the web report and the field
 * reference read.
 */

/** What one domain's collector reported back, before the manifest shape is applied. */
export interface BackupDomainOutcome {
    readonly key: BackupDomainKey;
    readonly status: BackupDomainStatus;
    readonly records: number;
    readonly files: Array<{ name: string; records: number; sha256: string }>;
    readonly trims?: ReadonlyArray<{ field: string; cutoff: string; omittedRecords: number }>;
    readonly errorCode?: string;
}

export interface BuildBackupManifestInput {
    readonly producedAt: Date;
    readonly build: string;
    readonly instance?: string;
    readonly workspace: BackupWorkspaceIdentity;
    readonly account: BackupAccountIdentity;
    readonly includeFullHistory: boolean;
    readonly outcomes: ReadonlyArray<BackupDomainOutcome>;
    readonly filesIncluded: number;
    readonly fileBytes: number;
    readonly omissions: ReadonlyArray<BackupOmission>;
    readonly archiveBytes: number;
}

/**
 * Build the manifest.
 *
 * Every one of the fifteen domains is present, in `BACKUP_DOMAINS` order,
 * whatever the collectors did — a domain that produced nothing reports
 * `empty`, and a domain whose collector never ran at all reports `failed`
 * with `collector_missing`. A reader must always be able to tell "you have
 * none of these" from "we did not export these" (spec FR-13).
 */
export function buildManifest(input: BuildBackupManifestInput): BackupManifest {
    const byKey = new Map(input.outcomes.map((outcome) => [outcome.key, outcome]));

    const domains: BackupDomainReport[] = BACKUP_DOMAINS.map((descriptor) => {
        const outcome = byKey.get(descriptor.key);
        if (!outcome) {
            return {
                key: descriptor.key,
                status: 'failed' as const,
                restorability: descriptor.restorability,
                records: 0,
                files: [],
                error: { code: 'collector_missing' },
            };
        }

        const report: BackupDomainReport = {
            key: descriptor.key,
            status: outcome.status,
            restorability: descriptor.restorability,
            records: outcome.records,
            files: outcome.files.map((file) => ({
                name: file.name,
                records: file.records,
                sha256: file.sha256,
            })),
            ...(outcome.trims && outcome.trims.length > 0 ? { trims: [...outcome.trims] } : {}),
            ...(outcome.errorCode ? { error: { code: outcome.errorCode } } : {}),
        };
        return report;
    });

    const records = domains.reduce((total, domain) => total + domain.records, 0);

    return {
        everworksBackupFormat: BACKUP_FORMAT_SENTINEL,
        formatVersion: BACKUP_FORMAT_VERSION,
        producedAt: input.producedAt.toISOString(),
        producedBy: input.instance
            ? { build: input.build, instance: input.instance }
            : { build: input.build },
        workspace: input.workspace,
        account: input.account,
        options: { includeFullHistory: input.includeFullHistory },
        domains,
        files: {
            included: input.filesIncluded,
            bytes: input.fileBytes,
            omitted: [...input.omissions],
        },
        exclusions: BACKUP_EXCLUSIONS,
        totals: { records, bytes: input.archiveBytes },
    };
}

/**
 * The manifest as it is stored on the backup record.
 *
 * Identical except that the per-file omission list — the only unbounded part
 * — collapses to a count. The record outlives the archive by ninety days
 * (spec FR-29), and a workspace that omitted thirty thousand files must not
 * put thirty thousand rows in a database column to say so.
 */
export function summarizeManifest(manifest: BackupManifest): BackupManifestSummary {
    const { files, ...rest } = manifest;
    return {
        ...rest,
        files: { included: files.included, bytes: files.bytes, omitted: files.omitted.length },
    };
}

/** How many domains came out whole, for the card's "{done} of {total} sections". */
export function countCompleteDomains(manifest: BackupManifest): number {
    return manifest.domains.filter(
        (domain) => domain.status !== 'failed' && domain.status !== 'partial',
    ).length;
}

/** Did anything at all go missing — a failed domain, a partial one, or an omitted file? */
export function hasGaps(manifest: BackupManifest): boolean {
    if (manifest.files.omitted.length > 0) {
        return true;
    }
    return manifest.domains.some(
        (domain) => domain.status === 'failed' || domain.status === 'partial',
    );
}
