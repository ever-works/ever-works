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

    let orm: { findOne: jest.Mock };
    let uploads: UserUploadRepository;

    beforeEach(() => {
        orm = { findOne: jest.fn().mockResolvedValue(null) };
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
});
