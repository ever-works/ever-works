import { UserUploadRepository } from './user-upload.repository';

describe('UserUploadRepository — ownership scope', () => {
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sha256 = 'b'.repeat(64);
    const everScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };
    const yoScope = {
        tenantId: everScope.tenantId,
        organizationId: '33333333-3333-4333-8333-333333333333',
    };

    let orm: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
    let uploads: UserUploadRepository;

    beforeEach(() => {
        orm = {
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn((value) => value),
            save: jest.fn(async (value) => ({ id: 'upload-row', ...value })),
        };
        uploads = new UserUploadRepository(orm as never);
    });

    it('uses exact active Ever scope for a same-user known content hash', async () => {
        await uploads.findOwnedByUser(sha256, userId, everScope);

        expect(orm.findOne).toHaveBeenCalledWith({
            where: [{ sha256, userId, ...everScope }],
        });
    });

    it('does not collapse the same user + hash in Yo into Ever', async () => {
        await uploads.findOwnedByUser(sha256, userId, yoScope);

        expect(orm.findOne).toHaveBeenCalledWith({
            where: [{ sha256, userId, ...yoScope }],
        });
        expect(orm.findOne).not.toHaveBeenCalledWith({
            where: [{ sha256, userId, ...everScope }],
        });
    });

    it('allows current and legacy personal uploads but no Organization row', async () => {
        await uploads.findOwnedByUser(sha256, userId, {
            tenantId: everScope.tenantId,
            organizationId: null,
        });

        const where = orm.findOne.mock.calls[0][0].where as Array<Record<string, unknown>>;
        expect(where).toHaveLength(2);
        expect(where[0]).toMatchObject({
            sha256,
            userId,
            tenantId: everScope.tenantId,
            organizationId: expect.objectContaining({ _type: 'isNull' }),
        });
        expect(where[1]).toMatchObject({
            sha256,
            userId,
            tenantId: expect.objectContaining({ _type: 'isNull' }),
            organizationId: expect.objectContaining({ _type: 'isNull' }),
        });
    });

    it('preserves the historical unscoped lookup only for non-request callers', async () => {
        await uploads.findOwnedByUser(sha256, userId);

        expect(orm.findOne).toHaveBeenCalledWith({ where: { sha256, userId } });
    });

    it('dedupes identical bytes independently in Ever and Yo', async () => {
        await uploads.record({
            userId,
            sha256,
            ...everScope,
            storageProvider: 'local-fs',
            storagePath: `${userId}/${sha256}.png`,
        });
        await uploads.record({
            userId,
            sha256,
            ...yoScope,
            storageProvider: 'local-fs',
            storagePath: `${userId}/${sha256}.png`,
        });

        expect(orm.findOne).toHaveBeenNthCalledWith(1, {
            where: [{ userId, sha256, ...everScope }],
        });
        expect(orm.findOne).toHaveBeenNthCalledWith(2, {
            where: [{ userId, sha256, ...yoScope }],
        });
        expect(orm.save).toHaveBeenCalledTimes(2);
    });

    it('dedupes current and legacy personal uploads without matching an Organization row', async () => {
        await uploads.record({
            userId,
            sha256,
            tenantId: everScope.tenantId,
            organizationId: null,
            storageProvider: 'local-fs',
            storagePath: `${userId}/${sha256}.png`,
        });

        const where = orm.findOne.mock.calls[0][0].where as Array<Record<string, unknown>>;
        expect(where).toHaveLength(2);
        expect(where[0]).toMatchObject({ userId, sha256, tenantId: everScope.tenantId });
        expect(where[1]).toMatchObject({ userId, sha256 });
        for (const branch of where) {
            expect(branch.organizationId).toEqual(expect.objectContaining({ _type: 'isNull' }));
        }
    });

    it('normalizes uppercase SHA-256 before scoped lookup and persistence', async () => {
        const uppercaseSha256 = sha256.toUpperCase();

        await uploads.record({
            userId,
            sha256: uppercaseSha256,
            ...everScope,
            storageProvider: 'local-fs',
            storagePath: `${userId}/${sha256}.png`,
        });

        expect(orm.findOne).toHaveBeenCalledWith({
            where: [{ userId, sha256, ...everScope }],
        });
        expect(orm.create).toHaveBeenCalledWith(
            expect.objectContaining({ userId, sha256, ...everScope }),
        );
        expect(orm.create).not.toHaveBeenCalledWith(
            expect.objectContaining({ sha256: uppercaseSha256 }),
        );
    });

    it('normalizes uppercase SHA-256 on owned reads so it dedupes with lowercase rows', async () => {
        await uploads.findOwnedByUser(sha256.toUpperCase(), userId, everScope);

        expect(orm.findOne).toHaveBeenCalledWith({
            where: [{ sha256, userId, ...everScope }],
        });
    });
});
