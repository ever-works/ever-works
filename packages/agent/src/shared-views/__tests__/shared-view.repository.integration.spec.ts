import { DataSource, Repository } from 'typeorm';
import { SharedView } from '../../entities/shared-view.entity';
import { SharedViewRepository } from '../shared-view.repository';
import { generateShareToken, hashShareToken } from '../shared-view-token';

/**
 * Shared view repository against a real in-memory sqlite table, so the
 * unique indexes, the compare-and-set updates and the encrypted token column
 * run for real rather than mocked.
 */
const TEST_KEY = '1'.repeat(64);

describe('SharedViewRepository (integration)', () => {
    let dataSource: DataSource;
    let rows: Repository<SharedView>;
    let repository: SharedViewRepository;
    const prevKey = process.env.PLUGIN_SECRET_ENCRYPTION_KEY;

    beforeAll(async () => {
        process.env.PLUGIN_SECRET_ENCRYPTION_KEY = TEST_KEY;
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [SharedView],
            synchronize: true,
        });
        await dataSource.initialize();
        rows = dataSource.getRepository(SharedView);
        repository = new SharedViewRepository(rows);
    });

    afterAll(async () => {
        await dataSource.destroy();
        if (prevKey === undefined) delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        else process.env.PLUGIN_SECRET_ENCRYPTION_KEY = prevKey;
    });

    beforeEach(async () => {
        await rows.clear();
    });

    async function create(organizationId = 'org-1', token = generateShareToken()) {
        const view = await repository.createForOrganization({
            organizationId,
            tenantId: 'tenant-1',
            ownerUserId: 'owner-1',
            createdById: 'owner-1',
            token,
            tokenHash: hashShareToken(token),
        });
        return { view, token };
    }

    async function rawTokenColumn(id: string): Promise<string> {
        const [row] = await dataSource.query(
            'SELECT "tokenEncrypted" FROM "shared_views" WHERE "id" = ?',
            [id],
        );
        return row.tokenEncrypted as string;
    }

    it('stores the token only as a hash and ciphertext, and reads it back for the owner', async () => {
        const { view, token } = await create();
        const raw = await rawTokenColumn(view.id);
        expect(raw).not.toContain(token);
        expect(raw).toContain('enc::v1::');

        const found = await repository.findByTokenHash(hashShareToken(token));
        expect(found?.id).toBe(view.id);
        expect(found?.tokenEncrypted).toEqual({ token });
        expect(found?.sections).toEqual({ board: true, knowledge: false });
        expect(found?.knowledgeClasses).toEqual([]);
    });

    it('refuses a second view for the same Workspace', async () => {
        await create('org-1');
        await expect(create('org-1')).rejects.toThrow();
    });

    it('rotates the token for exactly one of two writers that saw the same count', async () => {
        const { view, token } = await create();
        const firstToken = generateShareToken();
        const secondToken = generateShareToken();
        const now = new Date('2026-09-14T12:00:00.000Z');

        const first = await repository.rotateToken(view.id, 0, {
            token: firstToken,
            tokenHash: hashShareToken(firstToken),
            now,
        });
        const second = await repository.rotateToken(view.id, 0, {
            token: secondToken,
            tokenHash: hashShareToken(secondToken),
            now,
        });

        expect([first, second]).toEqual([true, false]);
        const current = await repository.findById(view.id);
        expect(current?.rotationCount).toBe(1);
        expect(current?.tokenEncrypted).toEqual({ token: firstToken });
        expect(current?.tokenRotatedAt).toBeTruthy();
        expect(await repository.findByTokenHash(hashShareToken(token))).toBeNull();
        expect(await repository.findByTokenHash(hashShareToken(secondToken))).toBeNull();
        expect(await rawTokenColumn(view.id)).not.toContain(firstToken);
    });

    it('updates only the facets it is given', async () => {
        const { view } = await create();
        await repository.updateSettings(view.id, { searchIndexable: true });
        await repository.updateSettings(view.id, {});
        const current = await repository.findById(view.id);
        expect(current?.searchIndexable).toBe(true);
        expect(current?.status).toBe('active');
        expect(current?.sections).toEqual({ board: true, knowledge: false });
    });

    it('adds views and claims the first-view notice once per link', async () => {
        const { view } = await create();
        const now = new Date('2026-09-14T12:00:00.000Z');
        await repository.applyViewDelta(view.id, 1, now);
        await repository.applyViewDelta(view.id, 2, now);
        await repository.applyViewDelta(view.id, 0, now);

        expect(await repository.claimFirstViewNotification(view.id, 0, now)).toBe(true);
        expect(await repository.claimFirstViewNotification(view.id, 0, now)).toBe(false);

        const current = await repository.findById(view.id);
        expect(current?.viewCount).toBe(3);
        expect(current?.lastViewedAt).toBeTruthy();

        const token = generateShareToken();
        await repository.rotateToken(view.id, 0, { token, tokenHash: hashShareToken(token), now });
        expect(await repository.claimFirstViewNotification(view.id, 0, now)).toBe(false);
        expect(await repository.claimFirstViewNotification(view.id, 1, now)).toBe(true);
    });

    it('deletes the Workspace view and reports whether one existed', async () => {
        await create('org-1');
        expect(await repository.deleteForOrganization('org-1')).toBe(true);
        expect(await repository.deleteForOrganization('org-1')).toBe(false);
        expect(await repository.findByOrganization('org-1')).toBeNull();
    });
});
