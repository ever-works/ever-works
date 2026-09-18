/**
 * The AW-22 port bindings, and the one property that makes them reach their
 * consumers.
 *
 * `BACKUP_STORAGE`, `BACKUP_ACTIVITY_RECORDER` and `BACKUP_NOTIFIER` are
 * bound HERE and injected THERE: `WorkspaceBackupService` and
 * `WorkspaceBackupRunner` are declared in the agent package's
 * `AccountTransferModule`, which this module imports. NestJS resolves a
 * provider's dependencies from its own module, its imports' exports and
 * global exports — never upward into an importer — so a plain `@Module`
 * bound all three to `undefined` at those `@Optional() @Inject()` sites.
 *
 * The visible result was not a boot failure, which is the whole reason this
 * spec exists: `isAvailable()` returned false, `POST /api/account/backups`
 * answered 503 `backup_storage_unconfigured` on a deployment with a working
 * storage backend, and no activity row or notification was ever written.
 * Every unit test passed throughout, because each one constructs the service
 * directly with a storage double.
 *
 * Mocking posture mirrors `memory-facts.module.spec.ts`, which pins the same
 * class of defect for `MEMORY_FACT_EMBED_DISPATCHER`: the heavy barrels are
 * stubbed so the decorator metadata can be asserted without dragging in the
 * entity graph, the plugin host and the notification stack.
 */

const BACKUP_STORAGE = Symbol('BACKUP_STORAGE');
const BACKUP_ACTIVITY_RECORDER = Symbol('BACKUP_ACTIVITY_RECORDER');
const BACKUP_NOTIFIER = Symbol('BACKUP_NOTIFIER');

jest.mock('@ever-works/agent/account-transfer', () => ({
    AccountTransferModule: class AccountTransferModule {},
    BACKUP_STORAGE,
    BACKUP_ACTIVITY_RECORDER,
    BACKUP_NOTIFIER,
    PluginBackupStorage: class PluginBackupStorage {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogModule: class ActivityLogModule {},
    ActivityLogService: class ActivityLogService {},
}));
jest.mock('@ever-works/agent/notifications', () => ({
    NotificationsModule: class NotificationsModule {},
    NotificationService: class NotificationService {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    NotificationCategory: { SYSTEM: 'system' },
    NotificationType: { INFO: 'info' },
}));
jest.mock('./account.controller', () => ({ AccountController: class AccountController {} }));
jest.mock('./workspace-backup.controller', () => ({
    WorkspaceBackupController: class WorkspaceBackupController {},
}));
jest.mock('../scope/scope.module', () => ({ ScopeModule: class ScopeModule {} }));
jest.mock('./tenant-job-runtime/tenant-job-runtime.module', () => ({
    TenantJobRuntimeModule: class TenantJobRuntimeModule {},
}));
jest.mock('../uploads/storage-backend.factory', () => ({
    getActiveStorageBackend: jest.fn(),
}));

import { AccountModule } from './account.module';

describe('AccountModule wiring for the workspace-backup ports', () => {
    const GLOBAL_MODULE_METADATA = '__module:global__';
    const PORTS = [BACKUP_STORAGE, BACKUP_ACTIVITY_RECORDER, BACKUP_NOTIFIER];

    function tokens(key: 'providers' | 'exports'): unknown[] {
        return ((Reflect.getMetadata(key, AccountModule) as unknown[]) ?? []).map((provider) =>
            typeof provider === 'object' && provider !== null
                ? (provider as { provide?: unknown }).provide
                : provider,
        );
    }

    it('binds all three ports', () => {
        for (const token of PORTS) {
            expect(tokens('providers')).toContain(token);
        }
    });

    it('is @Global(), so the agent-side consumers can see what it binds', () => {
        expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, AccountModule)).toBe(true);
    });

    it('exports all three ports — a global module still shares only its exports', () => {
        for (const token of PORTS) {
            expect(tokens('exports')).toContain(token);
        }
    });

    it('exports nothing else, so going global widens only what it must', () => {
        expect(tokens('exports')).toHaveLength(PORTS.length);
        expect(new Set(tokens('exports'))).toEqual(new Set(PORTS));
    });
});
