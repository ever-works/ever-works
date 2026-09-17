import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    BACKUP_DEFAULT_LIMITS,
    BACKUP_DOMAINS,
    BACKUP_FORMAT_VERSION,
    type BackupManifestSummary,
} from '@ever-works/contracts';
import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';
import type { WorkspaceBackup } from '../../entities/workspace-backup.entity';
import {
    WorkspaceBackupAlreadyActiveError,
    WorkspaceBackupRepository,
    type WorkspaceBackupScope,
} from '../../database/repositories/workspace-backup.repository';
import { TenantRepository } from '../../database/repositories/tenant.repository';
import {
    WORKSPACE_BACKUP_DISPATCHER,
    type WorkspaceBackupDispatcher,
} from '../../tasks/workspace-backup-dispatcher';
import { BACKUP_STORAGE, type BackupStorage } from './backup-storage';

/**
 * Workspace backup (AW-22) — the lifecycle everything else asks about.
 *
 * The controller calls only this class. It owns the four answers that have to
 * be the same however they are reached — from a button, from a second tab,
 * from the sweeper or from a background worker:
 *
 *  1. **One at a time.** A create while one runs ADOPTS the running backup
 *     rather than starting a second (spec FR-3, S-9). The database's partial
 *     unique index is the actual guarantee; this service turns the conflict
 *     it raises into "showing that one" instead of an error.
 *  2. **Three ready outcomes per rolling day.** Failed and cancelled
 *     attempts do not count, because an attempt that produced nothing must
 *     not cost the owner one of their three (spec FR-4, S-14, S-23).
 *  3. **The link is short-lived and bound.** A download token is an HMAC
 *     over the backup, the account, the workspace and an expiry — so a link
 *     for backup A cannot fetch backup B, a link minted for one account is
 *     refused for another, and a stale one is re-minted by the client
 *     without the user seeing anything (spec FR-12, S-15).
 *  4. **Every backup leaves exactly one trace of each kind.** One activity
 *     entry per create, download and delete (spec FR-32) and at most one
 *     notification per finished backup (spec FR-33).
 */

/** Why a create did not start a new backup. */
export type CreateBackupOutcome =
    | { readonly kind: 'started'; readonly backup: WorkspaceBackup }
    | { readonly kind: 'adopted'; readonly backup: WorkspaceBackup }
    | { readonly kind: 'rate_limited'; readonly retryAt: Date; readonly limit: number }
    | { readonly kind: 'unavailable' };

export interface WorkspaceBackupLimits {
    readonly retentionDays: number;
    readonly recordRetentionDays: number;
    readonly dailyAllowance: number;
    readonly historyPageSize: number;
    readonly downloadLinkTtlMinutes: number;
    readonly domainCount: number;
    readonly formatVersion: string;
}

/** A minted download link, as the client receives it. */
export interface BackupDownloadToken {
    readonly token: string;
    readonly expiresAt: Date;
}

/** The narrow view of the activity log this service needs. */
export interface BackupActivityRecorder {
    log(entry: {
        userId: string;
        actionType: ActivityActionType;
        /** Human-readable verb, as every activity row carries. */
        action: string;
        status: ActivityStatus;
        summary: string;
        details?: Record<string, unknown>;
    }): Promise<unknown>;
}

/** The narrow view of notifications this service needs. */
export interface BackupNotifier {
    create(dto: {
        userId: string;
        title: string;
        message: string;
        category: string;
        metadata?: Record<string, unknown>;
    }): Promise<unknown>;
}

/** DI tokens for the two side-channels, so the service does not import their modules. */
export const BACKUP_ACTIVITY_RECORDER = Symbol('BACKUP_ACTIVITY_RECORDER');
export const BACKUP_NOTIFIER = Symbol('BACKUP_NOTIFIER');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class WorkspaceBackupService {
    private readonly logger = new Logger(WorkspaceBackupService.name);

    constructor(
        private readonly backups: WorkspaceBackupRepository,
        // Every dependency added to this service is @Optional() and appended
        // last, the pattern this repository uses so an existing construction
        // site never has to change.
        @Optional() @Inject(BACKUP_STORAGE) private readonly storage?: BackupStorage,
        @Optional()
        @Inject(WORKSPACE_BACKUP_DISPATCHER)
        private readonly dispatcher?: WorkspaceBackupDispatcher,
        @Optional()
        @Inject(BACKUP_ACTIVITY_RECORDER)
        private readonly activity?: BackupActivityRecorder,
        @Optional() @Inject(BACKUP_NOTIFIER) private readonly notifier?: BackupNotifier,
        @Optional() private readonly tenants?: TenantRepository,
    ) {}

    /**
     * Is this account the workspace owner (spec FR-10)?
     *
     * The owner is the Tenant's `ownerUserId`, which is the only ownership
     * the platform actually records: organization membership carries exactly
     * one role today, and `ORGANIZATION_MEMBER_ROLES` says so explicitly.
     * When per-organization roles land, this is the one function that has to
     * change — which is why the check lives here rather than in the
     * controller, and why the answer is returned to the card as data rather
     * than baked into a disabled attribute.
     *
     * With no tenant repository wired (isolated unit tests, older
     * deployments) the answer is `true`: the scope predicate already keeps
     * one member out of another member's backups, so the fallback narrows
     * nothing it should not.
     */
    async isWorkspaceOwner(scope: WorkspaceBackupScope): Promise<boolean> {
        if (!scope.tenantId || !this.tenants) {
            return true;
        }
        const tenant = await this.tenants.findById(scope.tenantId).catch(() => null);
        if (!tenant) {
            return true;
        }
        return tenant.ownerUserId === scope.userId;
    }

    /**
     * The values in force in THIS deployment (spec FR-47). The card reads
     * them rather than repeating the defaults, so an operator who shortens
     * retention does not leave the interface promising fourteen days.
     */
    limits(): WorkspaceBackupLimits {
        return {
            retentionDays: this.envNumber(
                'BACKUP_RETENTION_DAYS',
                BACKUP_DEFAULT_LIMITS.retentionDays,
            ),
            recordRetentionDays: this.envNumber(
                'BACKUP_RECORD_RETENTION_DAYS',
                BACKUP_DEFAULT_LIMITS.recordRetentionDays,
            ),
            dailyAllowance: this.envNumber(
                'BACKUP_DAILY_ALLOWANCE',
                BACKUP_DEFAULT_LIMITS.dailyAllowance,
            ),
            historyPageSize: BACKUP_DEFAULT_LIMITS.historyPageSize,
            downloadLinkTtlMinutes: BACKUP_DEFAULT_LIMITS.downloadLinkTtlMinutes,
            domainCount: BACKUP_DOMAINS.length,
            formatVersion: BACKUP_FORMAT_VERSION,
        };
    }

    /**
     * Can this deployment produce a backup at all? A deployment with no
     * storage backend gets an explanatory card, never a button that always
     * fails (spec FR-46, S-26).
     */
    async isAvailable(): Promise<boolean> {
        if (!this.storage) {
            return false;
        }
        try {
            await this.storage.warmUp?.();
            return true;
        } catch (error) {
            this.logger.warn(
                `Workspace backups unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
        }
    }

    /**
     * Start a backup, or hand back the one already running.
     *
     * Returns within milliseconds and never carries an archive: the work is
     * dispatched to the configured job runtime (spec FR-2, Constitution IV).
     * A dispatcher that cannot enqueue is NOT silent — the row is failed
     * immediately so the card explains itself rather than showing a backup
     * queued forever.
     */
    async create(
        scope: WorkspaceBackupScope,
        options: { includeFullHistory?: boolean } = {},
    ): Promise<CreateBackupOutcome> {
        if (!(await this.isAvailable())) {
            return { kind: 'unavailable' };
        }

        const running = await this.backups.findActive(scope);
        if (running) {
            return { kind: 'adopted', backup: running };
        }

        const limits = this.limits();
        const since = new Date(Date.now() - MS_PER_DAY);
        const used = await this.backups.countReadyInWindow(scope, since);
        if (used >= limits.dailyAllowance) {
            return {
                kind: 'rate_limited',
                retryAt: await this.nextAllowanceAt(scope, limits.dailyAllowance),
                limit: limits.dailyAllowance,
            };
        }

        let backup: WorkspaceBackup;
        try {
            // DOCUMENTED dispatch-gate bypass. `RunDispatchGateService` is the
            // admission valve for AgentRun rows, and this is not one — it is a
            // `workspace_backups` row, which creates no agent run, consumes no
            // model tokens and takes no slot in the run concurrency budget.
            // Its own admission control is stricter and sits above this line:
            // `findActive` plus the partial unique index allow exactly one
            // live backup per workspace (so two tabs adopt rather than
            // double-run), the rolling allowance checked above caps ready
            // outcomes per 24 hours, and the archive task carries a
            // per-workspace concurrency key with a global limit of two.
            backup = await this.backups.createQueued(scope, {
                includeFullHistory: options.includeFullHistory === true,
                formatVersion: BACKUP_FORMAT_VERSION,
                domainsTotal: BACKUP_DOMAINS.length,
                buildRef: process.env.EVER_WORKS_BUILD ?? null,
            });
        } catch (error) {
            if (error instanceof WorkspaceBackupAlreadyActiveError) {
                // Another tab won the insert race. Adopt whatever it started.
                const adopted = await this.backups.findActive(scope);
                if (adopted) {
                    return { kind: 'adopted', backup: adopted };
                }
            }
            throw error;
        }

        await this.record(scope.userId, {
            actionType: ActivityActionType.WORKSPACE_BACKUP_CREATED,
            action: 'Create workspace backup',
            summary: 'Started a workspace backup',
            status: ActivityStatus.IN_PROGRESS,
            details: { backupId: backup.id, includeFullHistory: backup.includeFullHistory },
        });

        const runId = await this.dispatcher?.dispatchWorkspaceBackup({
            backupId: backup.id,
            userId: scope.userId,
            tenantId: scope.tenantId ?? null,
            organizationId: scope.organizationId ?? null,
            includeFullHistory: backup.includeFullHistory,
        });

        if (!runId) {
            await this.backups.markTerminal(backup.id, {
                status: 'failed',
                failureReason: 'internal',
                failureDetail: 'Could not enqueue the backup: no job runtime is configured',
                finishedAt: new Date(),
            });
            const failed = await this.backups.findInScope(scope, backup.id);
            return { kind: 'started', backup: failed ?? backup };
        }

        await this.backups.attachRuntimeRun(backup.id, runId);
        const started = await this.backups.findInScope(scope, backup.id);
        return { kind: 'started', backup: started ?? backup };
    }

    /** The history list (spec FR-30). */
    list(scope: WorkspaceBackupScope, options: { limit?: number; cursor?: string | null } = {}) {
        return this.backups.listForScope(scope, {
            limit: options.limit ?? this.limits().historyPageSize,
            cursor: options.cursor ?? null,
        });
    }

    /** One backup, only if it belongs to this workspace. */
    get(scope: WorkspaceBackupScope, id: string): Promise<WorkspaceBackup | null> {
        return this.backups.findInScope(scope, id);
    }

    /** The one the card polls while it runs, or the most recent settled one. */
    async getCurrent(scope: WorkspaceBackupScope): Promise<WorkspaceBackup | null> {
        return (await this.backups.findActive(scope)) ?? this.backups.findLatest(scope);
    }

    /** The last completed backup, for the danger-zone banner (spec S-5). */
    findLatest(scope: WorkspaceBackupScope): Promise<WorkspaceBackup | null> {
        return this.backups.findLatest(scope);
    }

    /**
     * Cancel a running backup (spec FR-8). A compare-and-set, so cancelling
     * a backup that finished a moment ago is a no-op rather than a state
     * that contradicts the archive sitting on storage.
     */
    async cancel(scope: WorkspaceBackupScope, id: string): Promise<boolean> {
        const backup = await this.backups.findInScope(scope, id);
        if (!backup) {
            return false;
        }
        return this.backups.requestCancel(id, new Date());
    }

    /**
     * Delete the bytes now (spec FR-31, S-24). The record survives with
     * status `deleted` and the date, because "I took a backup that day" is
     * still true and is the only version of the question anyone asks.
     */
    async deleteArtifact(scope: WorkspaceBackupScope, id: string): Promise<boolean> {
        const backup = await this.backups.findInScope(scope, id);
        if (!backup) {
            return false;
        }

        if (backup.storageKey && this.storage) {
            await this.storage.deleteArchive(backup.storageKey).catch((error: unknown) => {
                // The row still moves to `deleted`: leaving it `ready` would
                // offer a Download button for bytes we just tried to remove.
                this.logger.warn(
                    `Could not delete archive ${backup.storageKey}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            });
        }

        const moved = await this.backups.markTerminal(
            id,
            { status: 'deleted', storageKey: null, artifactDeletedAt: new Date() },
            ['ready', 'ready_with_gaps', 'expired'],
        );

        if (moved) {
            await this.record(scope.userId, {
                actionType: ActivityActionType.WORKSPACE_BACKUP_DELETED,
                action: 'Delete workspace backup',
                summary: 'Deleted a workspace backup archive',
                status: ActivityStatus.COMPLETED,
                details: { backupId: id },
            });
        }
        return moved;
    }

    /**
     * Mint a download link (spec FR-12).
     *
     * The token binds the backup, the account and the workspace together, so
     * it is useless anywhere else, and expires in fifteen minutes so a link
     * left in a browser's history stops working. It is not a bearer token
     * for the account — it can only fetch this one archive.
     */
    mintDownloadToken(scope: WorkspaceBackupScope, backupId: string): BackupDownloadToken {
        const expiresAt = new Date(Date.now() + this.limits().downloadLinkTtlMinutes * 60 * 1000);
        const payload = this.tokenPayload(scope, backupId, expiresAt.getTime());
        const signature = createHmac('sha256', this.tokenSecret())
            .update(payload)
            .digest('base64url');
        return { token: `${expiresAt.getTime()}.${signature}`, expiresAt };
    }

    /**
     * Check a download link. Constant-time, and deliberately answers only
     * yes or no — a caller that learns WHY a token failed learns whether the
     * backup exists.
     */
    verifyDownloadToken(scope: WorkspaceBackupScope, backupId: string, token: string): boolean {
        const separator = token.indexOf('.');
        if (separator <= 0) {
            return false;
        }
        const expiry = Number(token.slice(0, separator));
        const provided = token.slice(separator + 1);
        if (!Number.isFinite(expiry) || expiry < Date.now()) {
            return false;
        }

        const expected = createHmac('sha256', this.tokenSecret())
            .update(this.tokenPayload(scope, backupId, expiry))
            .digest('base64url');

        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        return a.length === b.length && timingSafeEqual(a, b);
    }

    /** Record one download (spec FR-32). */
    async recordDownload(scope: WorkspaceBackupScope, backup: WorkspaceBackup): Promise<void> {
        await this.backups.recordDownload(backup.id, new Date());
        await this.record(scope.userId, {
            actionType: ActivityActionType.WORKSPACE_BACKUP_DOWNLOADED,
            action: 'Download workspace backup',
            summary: 'Downloaded a workspace backup',
            status: ActivityStatus.COMPLETED,
            details: { backupId: backup.id, sizeBytes: Number(backup.sizeBytes ?? 0) },
        });
    }

    /**
     * Raise the single notification a finished backup is allowed (spec
     * FR-33). Called once by the worker as it settles the row; a second call
     * for the same backup is the caller's bug, so the wording is chosen to
     * make a duplicate obvious in the inbox rather than silently deduped
     * here.
     */
    async notifyFinished(backup: WorkspaceBackup): Promise<void> {
        const summary = backup.manifestSummary as BackupManifestSummary | null | undefined;
        const gaps =
            (summary?.files.omitted ?? 0) > 0 ||
            (summary?.domains ?? []).some(
                (domain) => domain.status === 'failed' || domain.status === 'partial',
            );

        if (backup.status === 'failed') {
            await this.notify(backup.userId, 'Your workspace backup did not finish', {
                backupId: backup.id,
                failureReason: backup.failureReason,
            });
            return;
        }
        if (backup.status !== 'ready' && backup.status !== 'ready_with_gaps') {
            return;
        }

        await this.notify(
            backup.userId,
            gaps
                ? 'Your workspace backup is ready, with some things left out'
                : 'Your workspace backup is ready',
            { backupId: backup.id, sizeBytes: Number(backup.sizeBytes ?? 0) },
        );
    }

    /**
     * Sweeper pass 1 — delete the bytes of archives past their retention
     * window, keeping the row (spec FR-28, S-16).
     */
    async expireDueArchives(now: Date, limit = 200): Promise<number> {
        const due = await this.backups.findExpirable(now, limit);
        let expired = 0;
        for (const backup of due) {
            if (backup.storageKey && this.storage) {
                await this.storage.deleteArchive(backup.storageKey).catch(() => undefined);
            }
            const moved = await this.backups.markTerminal(
                backup.id,
                { status: 'expired', storageKey: null, artifactDeletedAt: now },
                ['ready', 'ready_with_gaps'],
            );
            if (moved) expired += 1;
        }
        return expired;
    }

    /**
     * Sweeper pass 2 — fail backups that stopped reporting, and delete
     * whatever partial object they left (spec FR-5, S-14). The allowance is
     * not charged, because nothing was produced.
     */
    async failStalledBackups(now: Date, limit = 200): Promise<number> {
        const heartbeatBefore = new Date(
            now.getTime() - BACKUP_DEFAULT_LIMITS.stallMinutes * 60 * 1000,
        );
        const queuedBefore = new Date(
            now.getTime() - BACKUP_DEFAULT_LIMITS.queuedStallMinutes * 60 * 1000,
        );
        const stalled = await this.backups.findStalled(heartbeatBefore, queuedBefore, limit);

        let failed = 0;
        for (const backup of stalled) {
            if (backup.storageKey && this.storage) {
                await this.storage.deleteArchive(backup.storageKey).catch(() => undefined);
            }
            const moved = await this.backups.markTerminal(backup.id, {
                status: 'failed',
                failureReason: 'stalled',
                failureDetail: 'The backup stopped reporting progress',
                finishedAt: now,
                storageKey: null,
                currentDomain: null,
            });
            if (moved) failed += 1;
        }
        return failed;
    }

    /** Sweeper pass 3 — remove records whose bytes went long ago (spec FR-29). */
    async pruneOldRecords(now: Date, limit = 200): Promise<number> {
        const before = new Date(now.getTime() - this.limits().recordRetentionDays * MS_PER_DAY);
        const prunable = await this.backups.findPrunable(before, limit);
        return this.backups.deleteByIds(prunable.map((backup) => backup.id));
    }

    /**
     * When the daily allowance reopens: one day after the OLDEST ready
     * outcome still inside the window, which is the moment it leaves it.
     */
    private async nextAllowanceAt(scope: WorkspaceBackupScope, allowance: number): Promise<Date> {
        const { rows } = await this.backups.listForScope(scope, { limit: allowance * 2 });
        const readyStatuses = new Set(['ready', 'ready_with_gaps', 'expired', 'deleted']);
        const inWindow = rows
            .filter((row) => readyStatuses.has(row.status))
            .filter((row) => new Date(row.requestedAt).getTime() >= Date.now() - MS_PER_DAY)
            .sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime());

        const oldest = inWindow[0];
        return new Date(
            (oldest ? new Date(oldest.requestedAt).getTime() : Date.now()) + MS_PER_DAY,
        );
    }

    private tokenPayload(scope: WorkspaceBackupScope, backupId: string, expiry: number): string {
        // Every field that must not be swappable is inside the signature.
        return [backupId, scope.userId, scope.organizationId ?? 'personal', String(expiry)].join(
            '|',
        );
    }

    /**
     * The signing key. Falls back to a per-process random secret rather than
     * a constant, so a deployment that never set one gets links that stop
     * working on restart instead of links anybody can forge.
     */
    private tokenSecret(): string {
        const configured = process.env.BACKUP_DOWNLOAD_SECRET || process.env.AUTH_SECRET;
        if (configured) {
            return configured;
        }
        if (!WorkspaceBackupService.ephemeralSecret) {
            WorkspaceBackupService.ephemeralSecret = randomBytes(32).toString('hex');
        }
        return WorkspaceBackupService.ephemeralSecret;
    }

    private static ephemeralSecret: string | null = null;

    private envNumber(name: string, fallback: number): number {
        const value = Number(process.env[name]);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    }

    private async record(
        userId: string,
        entry: {
            actionType: ActivityActionType;
            action: string;
            status: ActivityStatus;
            summary: string;
            details?: Record<string, unknown>;
        },
    ): Promise<void> {
        if (!this.activity) return;
        // A backup must not fail because its audit trail did.
        await this.activity.log({ userId, ...entry }).catch((error: unknown) => {
            this.logger.warn(
                `Could not record backup activity: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
    }

    private async notify(
        userId: string,
        title: string,
        metadata: Record<string, unknown>,
    ): Promise<void> {
        if (!this.notifier) return;
        await this.notifier
            .create({ userId, title, message: title, category: 'system', metadata })
            .catch((error: unknown) => {
                this.logger.warn(
                    `Could not raise backup notification: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            });
    }
}
