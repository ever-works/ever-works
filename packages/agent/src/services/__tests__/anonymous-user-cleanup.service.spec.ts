import { AnonymousUserCleanupService } from '../anonymous-user-cleanup.service';

describe('AnonymousUserCleanupService (EW-617 G2)', () => {
    const buildService = (storage?: { deleteAllByOwner?: jest.Mock; providerName?: string }) => {
        const userRepository = {
            findExpiredAnonymous: jest.fn(),
            deleteAnonymous: jest.fn().mockResolvedValue(undefined),
        } as any;
        const service = new AnonymousUserCleanupService(userRepository, storage);
        return { service, userRepository, storage };
    };

    it('returns an empty summary when no expired anonymous users exist', async () => {
        const { service, userRepository } = buildService();
        userRepository.findExpiredAnonymous.mockResolvedValue([]);

        const summary = await service.purgeExpired();

        expect(summary).toEqual({
            scanned: 0,
            deleted: 0,
            failed: 0,
            failures: [],
            storageDeleted: 0,
            storageFailed: 0,
        });
        expect(userRepository.deleteAnonymous).not.toHaveBeenCalled();
    });

    it('deletes every expired anonymous user and counts successes', async () => {
        const { service, userRepository } = buildService();
        userRepository.findExpiredAnonymous.mockResolvedValue([
            { id: 'u-1' },
            { id: 'u-2' },
            { id: 'u-3' },
        ]);

        const summary = await service.purgeExpired();

        expect(userRepository.deleteAnonymous).toHaveBeenCalledTimes(3);
        expect(userRepository.deleteAnonymous).toHaveBeenNthCalledWith(1, 'u-1');
        expect(userRepository.deleteAnonymous).toHaveBeenNthCalledWith(2, 'u-2');
        expect(userRepository.deleteAnonymous).toHaveBeenNthCalledWith(3, 'u-3');
        expect(summary).toMatchObject({ scanned: 3, deleted: 3, failed: 0, failures: [] });
    });

    it('continues past a single delete failure and reports it', async () => {
        const { service, userRepository } = buildService();
        userRepository.findExpiredAnonymous.mockResolvedValue([
            { id: 'u-1' },
            { id: 'u-stuck' },
            { id: 'u-3' },
        ]);
        userRepository.deleteAnonymous
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('fk constraint'))
            .mockResolvedValueOnce(undefined);

        const summary = await service.purgeExpired();

        expect(summary.scanned).toBe(3);
        expect(summary.deleted).toBe(2);
        expect(summary.failed).toBe(1);
        expect(summary.failures).toEqual([{ userId: 'u-stuck', error: 'fk constraint' }]);
    });

    it('passes the `now` argument through to the repository for testability', async () => {
        const { service, userRepository } = buildService();
        userRepository.findExpiredAnonymous.mockResolvedValue([]);

        const fixedNow = new Date('2026-05-14T03:17:00.000Z');
        await service.purgeExpired(fixedNow);

        expect(userRepository.findExpiredAnonymous).toHaveBeenCalledWith(fixedNow);
    });

    // EW-637 follow-up — when a storage plugin is wired, GC its files
    // BEFORE the user row goes away (so the prefix is still derivable
    // from userId).
    describe('storage GC integration', () => {
        it('calls backend.deleteAllByOwner for each expired user and tallies counts', async () => {
            const storage = {
                deleteAllByOwner: jest
                    .fn()
                    .mockResolvedValueOnce({ deleted: 2 })
                    .mockResolvedValueOnce({ deleted: 5 }),
                providerName: 'local-fs',
            };
            const { service, userRepository } = buildService(storage);
            userRepository.findExpiredAnonymous.mockResolvedValue([{ id: 'u-a' }, { id: 'u-b' }]);

            const summary = await service.purgeExpired();

            expect(storage.deleteAllByOwner).toHaveBeenCalledTimes(2);
            expect(storage.deleteAllByOwner).toHaveBeenNthCalledWith(1, 'u-a');
            expect(storage.deleteAllByOwner).toHaveBeenNthCalledWith(2, 'u-b');
            expect(summary.storageDeleted).toBe(7);
            expect(summary.storageFailed).toBe(0);
            expect(summary.deleted).toBe(2);
        });

        it('still deletes the user row when storage GC fails for that user', async () => {
            const storage = {
                deleteAllByOwner: jest
                    .fn()
                    .mockResolvedValueOnce({ deleted: 1 })
                    .mockRejectedValueOnce(new Error('s3 5xx')),
                providerName: 'aws-s3',
            };
            const { service, userRepository } = buildService(storage);
            userRepository.findExpiredAnonymous.mockResolvedValue([
                { id: 'u-ok' },
                { id: 'u-bad-storage' },
            ]);

            const summary = await service.purgeExpired();

            expect(summary.storageFailed).toBe(1);
            expect(summary.storageDeleted).toBe(1);
            // Critical: row delete still happens — TTL contract holds even when storage misbehaves.
            expect(userRepository.deleteAnonymous).toHaveBeenCalledWith('u-bad-storage');
            expect(summary.deleted).toBe(2);
        });

        it('skips storage GC silently when no plugin is wired (legacy local-fs deployments)', async () => {
            const { service, userRepository } = buildService(undefined);
            userRepository.findExpiredAnonymous.mockResolvedValue([{ id: 'u-1' }]);

            const summary = await service.purgeExpired();

            expect(summary.storageDeleted).toBe(0);
            expect(summary.storageFailed).toBe(0);
            expect(summary.deleted).toBe(1);
        });
    });

    // Knowledge library — an Organization's shared folders record their
    // creator in `memory_folders.userId` (FK `ON DELETE CASCADE`), so they
    // must change hands before the creator's row is deleted.
    describe('shared folder hand-over', () => {
        const ORG = 'org-1';
        const TENANT = 'tenant-1';

        const buildWithFolders = () => {
            const userRepository = {
                findExpiredAnonymous: jest.fn(),
                deleteAnonymous: jest.fn().mockResolvedValue(undefined),
                findById: jest.fn(async (id: string) => ({ id, tenantId: TENANT })),
                findOtherTenantMember: jest.fn(async () => ({ id: 'u-member', tenantId: TENANT })),
            } as any;
            const memoryFolders = {
                listOrganizationIdsWithFoldersCreatedBy: jest.fn(async () => [ORG]),
                reassignOrganizationFolders: jest.fn(async () => 2),
            } as any;
            const organizations = {
                findById: jest.fn(async () => ({ id: ORG, tenantId: TENANT })),
            } as any;
            const tenants = {
                findById: jest.fn(async () => ({ id: TENANT, ownerUserId: 'u-owner' })),
            } as any;
            const storage = { deleteAllByOwner: jest.fn(async () => ({ deleted: 0 })) };
            const service = new AnonymousUserCleanupService(
                userRepository,
                storage,
                memoryFolders,
                organizations,
                tenants,
            );
            return { service, userRepository, memoryFolders, organizations, tenants, storage };
        };

        it('hands the shared folders to the Tenant owner before the row is deleted', async () => {
            const { service, userRepository, memoryFolders } = buildWithFolders();
            userRepository.findExpiredAnonymous.mockResolvedValue([{ id: 'u-anon' }]);

            const summary = await service.purgeExpired();

            expect(memoryFolders.listOrganizationIdsWithFoldersCreatedBy).toHaveBeenCalledWith(
                'u-anon',
            );
            expect(memoryFolders.reassignOrganizationFolders).toHaveBeenCalledWith(
                ORG,
                'u-anon',
                'u-owner',
            );
            expect(userRepository.findOtherTenantMember).not.toHaveBeenCalled();
            expect(
                memoryFolders.reassignOrganizationFolders.mock.invocationCallOrder[0],
            ).toBeLessThan(userRepository.deleteAnonymous.mock.invocationCallOrder[0]);
            expect(summary).toMatchObject({ deleted: 1, failed: 0 });
        });

        it('hands them to another member when the deleted user owns the Tenant', async () => {
            const { service, userRepository, memoryFolders, tenants } = buildWithFolders();
            tenants.findById.mockResolvedValue({ id: TENANT, ownerUserId: 'u-anon' });
            userRepository.findExpiredAnonymous.mockResolvedValue([{ id: 'u-anon' }]);

            await service.purgeExpired();

            expect(userRepository.findOtherTenantMember).toHaveBeenCalledWith(TENANT, 'u-anon');
            expect(memoryFolders.reassignOrganizationFolders).toHaveBeenCalledWith(
                ORG,
                'u-anon',
                'u-member',
            );
            expect(userRepository.deleteAnonymous).toHaveBeenCalledWith('u-anon');
        });

        it('passes over a Tenant owner who has left the Tenant', async () => {
            const { service, userRepository, memoryFolders } = buildWithFolders();
            userRepository.findById.mockResolvedValue({ id: 'u-owner', tenantId: 'elsewhere' });
            userRepository.findExpiredAnonymous.mockResolvedValue([{ id: 'u-anon' }]);

            await service.purgeExpired();

            expect(memoryFolders.reassignOrganizationFolders).toHaveBeenCalledWith(
                ORG,
                'u-anon',
                'u-member',
            );
        });

        it('leaves the folders to the cascade when the user was the last member', async () => {
            const { service, userRepository, memoryFolders, tenants } = buildWithFolders();
            tenants.findById.mockResolvedValue({ id: TENANT, ownerUserId: 'u-anon' });
            userRepository.findOtherTenantMember.mockResolvedValue(null);
            userRepository.findExpiredAnonymous.mockResolvedValue([{ id: 'u-anon' }]);

            const summary = await service.purgeExpired();

            expect(memoryFolders.reassignOrganizationFolders).not.toHaveBeenCalled();
            expect(userRepository.deleteAnonymous).toHaveBeenCalledWith('u-anon');
            expect(summary.deleted).toBe(1);
        });

        it('does nothing for a user who created no shared folders', async () => {
            const { service, userRepository, memoryFolders, organizations } = buildWithFolders();
            memoryFolders.listOrganizationIdsWithFoldersCreatedBy.mockResolvedValue([]);
            userRepository.findExpiredAnonymous.mockResolvedValue([{ id: 'u-anon' }]);

            await service.purgeExpired();

            expect(organizations.findById).not.toHaveBeenCalled();
            expect(memoryFolders.reassignOrganizationFolders).not.toHaveBeenCalled();
            expect(userRepository.deleteAnonymous).toHaveBeenCalledWith('u-anon');
        });

        it('keeps a user whose hand-over failed for the next run, and carries on with the batch', async () => {
            const { service, userRepository, memoryFolders, storage } = buildWithFolders();
            memoryFolders.reassignOrganizationFolders
                .mockRejectedValueOnce(new Error('db down'))
                .mockResolvedValueOnce(1);
            userRepository.findExpiredAnonymous.mockResolvedValue([
                { id: 'u-stuck' },
                { id: 'u-next' },
            ]);

            const summary = await service.purgeExpired();

            expect(userRepository.deleteAnonymous).not.toHaveBeenCalledWith('u-stuck');
            expect(storage.deleteAllByOwner).not.toHaveBeenCalledWith('u-stuck');
            expect(userRepository.deleteAnonymous).toHaveBeenCalledWith('u-next');
            expect(summary).toMatchObject({
                scanned: 2,
                deleted: 1,
                failed: 1,
                failures: [{ userId: 'u-stuck', error: 'db down' }],
            });
        });
    });

    describe('shared folder hand-over without the folder repositories wired', () => {
        it('deletes exactly as before', async () => {
            // `buildService` wires no folder repositories and its user
            // repository has no `findOtherTenantMember`: the hand-over must
            // not touch either.
            const { service, userRepository } = buildService(undefined);
            userRepository.findExpiredAnonymous.mockResolvedValue([{ id: 'u-1' }]);

            const summary = await service.purgeExpired();

            expect(userRepository.deleteAnonymous).toHaveBeenCalledWith('u-1');
            expect(summary).toMatchObject({ scanned: 1, deleted: 1, failed: 0, failures: [] });
        });
    });
});
