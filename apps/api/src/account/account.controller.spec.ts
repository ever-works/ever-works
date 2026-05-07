jest.mock('@ever-works/agent/account-transfer', () => ({}));

import { AccountController } from './account.controller';
import type {
    AccountExportService,
    AccountImportService,
    GitHubSyncService,
} from '@ever-works/agent/account-transfer';
import type { AuthenticatedUser } from '../auth/types/auth.types';

describe('AccountController', () => {
    let controller: AccountController;
    let exportService: jest.Mocked<Pick<AccountExportService, 'exportAccountData'>>;
    let importService: jest.Mocked<Pick<AccountImportService, 'previewImport' | 'applyImport'>>;
    let syncService: jest.Mocked<
        Pick<
            GitHubSyncService,
            | 'getSyncStatus'
            | 'configureSyncRepo'
            | 'pushToGitHub'
            | 'pullFromGitHub'
            | 'applyPull'
            | 'removeSyncConfig'
        >
    >;
    const auth: AuthenticatedUser = { userId: 'user-1' } as AuthenticatedUser;

    beforeEach(() => {
        exportService = {
            exportAccountData: jest.fn(),
        } as any;
        importService = {
            previewImport: jest.fn(),
            applyImport: jest.fn(),
        } as any;
        syncService = {
            getSyncStatus: jest.fn(),
            configureSyncRepo: jest.fn(),
            pushToGitHub: jest.fn(),
            pullFromGitHub: jest.fn(),
            applyPull: jest.fn(),
            removeSyncConfig: jest.fn(),
        } as any;

        controller = new AccountController(
            exportService as unknown as AccountExportService,
            importService as unknown as AccountImportService,
            syncService as unknown as GitHubSyncService,
        );
    });

    describe('exportData', () => {
        it('passes includeSecrets=true when query is "true"', async () => {
            exportService.exportAccountData.mockResolvedValue({ payload: true } as any);

            const result = await controller.exportData(auth, 'true');

            expect(exportService.exportAccountData).toHaveBeenCalledWith('user-1', {
                includeSecrets: true,
            });
            expect(result).toEqual({ payload: true });
        });

        it('passes includeSecrets=false for any other value', async () => {
            exportService.exportAccountData.mockResolvedValue({} as any);

            await controller.exportData(auth, 'false');
            await controller.exportData(auth, '');
            await controller.exportData(auth, 'TRUE'); // case-sensitive — not "true"

            expect(exportService.exportAccountData).toHaveBeenNthCalledWith(1, 'user-1', {
                includeSecrets: false,
            });
            expect(exportService.exportAccountData).toHaveBeenNthCalledWith(2, 'user-1', {
                includeSecrets: false,
            });
            expect(exportService.exportAccountData).toHaveBeenNthCalledWith(3, 'user-1', {
                includeSecrets: false,
            });
        });
    });

    describe('previewImport', () => {
        it('forwards userId and payload to importService.previewImport', async () => {
            const payload = { version: '1', items: [] } as any;
            importService.previewImport.mockResolvedValue({ conflicts: [] } as any);

            const result = await controller.previewImport(auth, payload);

            expect(importService.previewImport).toHaveBeenCalledWith('user-1', payload);
            expect(result).toEqual({ conflicts: [] });
        });
    });

    describe('applyImport', () => {
        it('forwards payload and resolutions', async () => {
            const payload = { version: '1' } as any;
            const resolutions = [{ id: 'a', strategy: 'overwrite' }] as any;
            importService.applyImport.mockResolvedValue({ status: 'ok' } as any);

            const result = await controller.applyImport(auth, { payload, resolutions });

            expect(importService.applyImport).toHaveBeenCalledWith('user-1', payload, resolutions);
            expect(result).toEqual({ status: 'ok' });
        });

        it('defaults resolutions to [] when missing', async () => {
            const payload = {} as any;
            importService.applyImport.mockResolvedValue({} as any);

            await controller.applyImport(auth, { payload } as any);

            expect(importService.applyImport).toHaveBeenCalledWith('user-1', payload, []);
        });
    });

    describe('getSyncStatus', () => {
        it('returns the sync status from syncService', async () => {
            syncService.getSyncStatus.mockResolvedValue({ configured: true } as any);

            const result = await controller.getSyncStatus(auth);

            expect(syncService.getSyncStatus).toHaveBeenCalledWith('user-1');
            expect(result).toEqual({ configured: true });
        });
    });

    describe('configureSyncRepo', () => {
        it('passes repoFullName and createNew through', async () => {
            syncService.configureSyncRepo.mockResolvedValue({ configured: true } as any);

            const result = await controller.configureSyncRepo(auth, {
                repoFullName: 'octo/cat',
                createNew: true,
            });

            expect(syncService.configureSyncRepo).toHaveBeenCalledWith('user-1', {
                repoFullName: 'octo/cat',
                createNew: true,
            });
            expect(result).toEqual({ configured: true });
        });

        it('handles empty body', async () => {
            syncService.configureSyncRepo.mockResolvedValue({} as any);

            await controller.configureSyncRepo(auth, {});

            expect(syncService.configureSyncRepo).toHaveBeenCalledWith('user-1', {});
        });
    });

    describe('pushToGitHub', () => {
        it('forwards body and returns success status', async () => {
            syncService.pushToGitHub.mockResolvedValue(undefined);

            const result = await controller.pushToGitHub(auth, { includeSecrets: true });

            expect(syncService.pushToGitHub).toHaveBeenCalledWith('user-1', {
                includeSecrets: true,
            });
            expect(result).toEqual({ status: 'success' });
        });

        it('still returns success when body has no flags', async () => {
            syncService.pushToGitHub.mockResolvedValue(undefined);

            const result = await controller.pushToGitHub(auth, {});

            expect(syncService.pushToGitHub).toHaveBeenCalledWith('user-1', {});
            expect(result).toEqual({ status: 'success' });
        });
    });

    describe('pullFromGitHub', () => {
        it('forwards userId and returns the import preview', async () => {
            syncService.pullFromGitHub.mockResolvedValue({ conflicts: [{ id: 'c' }] } as any);

            const result = await controller.pullFromGitHub(auth);

            expect(syncService.pullFromGitHub).toHaveBeenCalledWith('user-1');
            expect(result).toEqual({ conflicts: [{ id: 'c' }] });
        });
    });

    describe('applyPull', () => {
        it('forwards resolutions', async () => {
            syncService.applyPull.mockResolvedValue({ status: 'ok' } as any);
            const resolutions = [{ id: 'a' }] as any;

            const result = await controller.applyPull(auth, { resolutions });

            expect(syncService.applyPull).toHaveBeenCalledWith('user-1', resolutions);
            expect(result).toEqual({ status: 'ok' });
        });

        it('defaults resolutions to [] when missing', async () => {
            syncService.applyPull.mockResolvedValue({} as any);

            await controller.applyPull(auth, {} as any);

            expect(syncService.applyPull).toHaveBeenCalledWith('user-1', []);
        });
    });

    describe('removeSyncConfig', () => {
        it('forwards userId and returns success status', async () => {
            syncService.removeSyncConfig.mockResolvedValue(undefined);

            const result = await controller.removeSyncConfig(auth);

            expect(syncService.removeSyncConfig).toHaveBeenCalledWith('user-1');
            expect(result).toEqual({ status: 'success' });
        });
    });
});
