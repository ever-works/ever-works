import { Module } from '@nestjs/common';
import { AccountTransferModule } from '@ever-works/agent/account-transfer';
import {
    BACKUP_ACTIVITY_RECORDER,
    BACKUP_NOTIFIER,
    BACKUP_STORAGE,
    PluginBackupStorage,
} from '@ever-works/agent/account-transfer';
import { ActivityLogModule, ActivityLogService } from '@ever-works/agent/activity-log';
import { NotificationsModule, NotificationService } from '@ever-works/agent/notifications';
import {
    NotificationCategory,
    NotificationType,
    type ActivityActionType,
    type ActivityStatus,
} from '@ever-works/agent/entities';
import { AccountController } from './account.controller';
import { WorkspaceBackupController } from './workspace-backup.controller';
import { ScopeModule } from '../scope/scope.module';
import { getActiveStorageBackend } from '../uploads/storage-backend.factory';
import { TenantJobRuntimeModule } from './tenant-job-runtime/tenant-job-runtime.module';

/**
 * Account-scoped APIs. Wires the legacy AccountController (export /
 * import / GitHub sync) plus the EW-742 P2.0 tenant-job-runtime overlay
 * admin surface (`/api/account/job-runtime/...`), and — added by AW-22 —
 * the workspace-backup surface at `/api/account/backups`.
 *
 * The three AW-22 bindings below are all indirection on purpose. The agent
 * package must not import this module's graph to find the active storage
 * backend, the activity log or the notification service, so each is handed
 * over at a DI token with the narrowest possible shape:
 *
 *  - `BACKUP_STORAGE` resolves through `getActiveStorageBackend()`, the same
 *    selector uploads use, so the runner never names a backend and a
 *    deployment that switches from local disk to an object store changes
 *    nothing here (Constitution I and II).
 *  - `BACKUP_ACTIVITY_RECORDER` and `BACKUP_NOTIFIER` are two-method
 *    adapters, so the backup service depends on "record this" and "tell the
 *    owner", not on two whole modules.
 */
@Module({
    imports: [
        AccountTransferModule,
        TenantJobRuntimeModule,
        ScopeModule,
        ActivityLogModule,
        NotificationsModule,
    ],
    controllers: [AccountController, WorkspaceBackupController],
    providers: [
        {
            provide: BACKUP_STORAGE,
            // A resolver rather than an instance: the backend is selected and
            // lazily loaded at boot, and the factory caches it per process.
            useFactory: () => new PluginBackupStorage(() => getActiveStorageBackend()),
        },
        {
            provide: BACKUP_ACTIVITY_RECORDER,
            useFactory: (activity: ActivityLogService) => ({
                log: (entry: {
                    userId: string;
                    actionType: ActivityActionType;
                    action: string;
                    status: ActivityStatus;
                    summary: string;
                    details?: Record<string, unknown>;
                }) => activity.log(entry),
            }),
            inject: [ActivityLogService],
        },
        {
            provide: BACKUP_NOTIFIER,
            useFactory: (notifications: NotificationService) => ({
                create: (dto: {
                    userId: string;
                    title: string;
                    message: string;
                    metadata?: Record<string, unknown>;
                }) =>
                    notifications.create({
                        userId: dto.userId,
                        // A finished backup is a platform event, not an agent
                        // one — the same category the other system notices use.
                        type: NotificationType.INFO,
                        category: NotificationCategory.SYSTEM,
                        title: dto.title,
                        message: dto.message,
                        ...(dto.metadata ? { metadata: dto.metadata } : {}),
                    }),
            }),
            inject: [NotificationService],
        },
    ],
})
export class AccountModule {}
