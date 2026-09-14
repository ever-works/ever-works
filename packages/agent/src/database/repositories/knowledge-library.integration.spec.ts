import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { User } from '../../entities/user.entity';
import { Work } from '../../entities/work.entity';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { MemoryFolder, MemoryFolderScope } from '../../entities/memory-folder.entity';
import { KnowledgeDocumentReaderState } from '../../entities/knowledge-document-reader-state.entity';
import { KbDocumentClass, KbDocumentStatus } from '../../entities/kb-types';
import { Tenant } from '../../entities/tenant.entity';
import { Organization } from '../../entities/organization.entity';
import { WorkKnowledgeDocumentRepository } from './work-knowledge-document.repository';
import { MemoryFolderRepository } from './memory-folder.repository';
import { KnowledgeDocumentReaderStateRepository } from './knowledge-document-reader-state.repository';
import { UserRepository } from './user.repository';
import { OrganizationRepository } from './organization.repository';
import { TenantRepository } from './tenant.repository';
import { AnonymousUserCleanupService } from '../../services/anonymous-user-cleanup.service';
import { MemoryFoldersService } from '../../services/memory-folders.service';

/**
 * Knowledge library persistence, executed against a REAL SQL engine
 * (better-sqlite3 with the full entity inventory synchronized), so the
 * partial unique indexes, the shared-vs-personal folder isolation, the
 * library sort / filter / ranking SQL and the reader-state rollup are
 * exercised as the database interprets them rather than as a mock assumes.
 */
describe('Knowledge library repositories (integration)', () => {
    const ORG = '00000000-0000-0000-0000-00000000000a';
    const OTHER_ORG = '00000000-0000-0000-0000-00000000000b';

    let dataSource: DataSource;
    let docs: Repository<WorkKnowledgeDocument>;
    let documents: WorkKnowledgeDocumentRepository;
    let folders: MemoryFolderRepository;
    let readerStates: KnowledgeDocumentReaderStateRepository;
    let userId: string;
    let otherUserId: string;
    let workA: string;
    let workB: string;
    let foreignWork: string;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        docs = dataSource.getRepository(WorkKnowledgeDocument);
        documents = new WorkKnowledgeDocumentRepository(docs);
        folders = new MemoryFolderRepository(dataSource.getRepository(MemoryFolder));
        readerStates = new KnowledgeDocumentReaderStateRepository(
            dataSource.getRepository(KnowledgeDocumentReaderState),
        );

        const users = dataSource.getRepository(User);
        const makeUser = async (name: string) =>
            (
                await users.save(
                    users.create({
                        username: name,
                        email: `${name}@example.com`,
                        password: 'x',
                    } as Partial<User>),
                )
            ).id;
        userId = await makeUser('reader');
        otherUserId = await makeUser('teammate');

        const works = dataSource.getRepository(Work);
        const makeWork = async (slug: string) =>
            (
                await works.save(
                    works.create({ userId, name: slug, slug, description: slug } as Partial<Work>),
                )
            ).id;
        workA = await makeWork('marketing');
        workB = await makeWork('support');
        foreignWork = await makeWork('someone-else');
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const scope = () => ({ workIds: [workA, workB], organizationId: ORG });

    const seed = (overrides: Partial<WorkKnowledgeDocument>) =>
        documents.create({
            workId: workA,
            path: `freeform/${overrides.slug ?? 'doc'}.md`,
            slug: 'doc',
            title: 'Doc',
            kbDocumentClass: KbDocumentClass.FREEFORM,
            status: KbDocumentStatus.ACTIVE,
            ...overrides,
        });

    describe('shared and personal folders share a table but never each other’s queries', () => {
        it('keeps a shared folder out of its creator’s personal tree, and vice versa', async () => {
            const personal = await folders.create({ userId, name: 'Docs', path: '/Docs' });
            const shared = await folders.create({
                userId,
                name: 'Docs',
                path: '/Docs',
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: ORG,
            });

            expect((await folders.listByUser(userId)).map((f) => f.id)).toEqual([personal.id]);
            expect(await folders.findById(userId, shared.id)).toBeNull();
            expect(await folders.findByPath(userId, '/Docs')).toMatchObject({ id: personal.id });
            expect((await folders.listByOrganization(ORG)).map((f) => f.id)).toEqual([shared.id]);
            expect(await folders.findOrganizationFolder(ORG, personal.id)).toBeNull();
            expect(await folders.findOrganizationFolder(OTHER_ORG, shared.id)).toBeNull();
        });

        it('enforces shared-path uniqueness per Organization through the partial index', async () => {
            await folders.create({
                userId,
                name: 'Playbooks',
                path: '/Playbooks',
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: ORG,
            });
            await expect(
                folders.create({
                    userId: otherUserId,
                    name: 'Playbooks',
                    path: '/Playbooks',
                    scope: MemoryFolderScope.ORGANIZATION,
                    organizationId: ORG,
                }),
            ).rejects.toThrow();
            await expect(
                folders.create({
                    userId,
                    name: 'Playbooks',
                    path: '/Playbooks',
                    scope: MemoryFolderScope.ORGANIZATION,
                    organizationId: OTHER_ORG,
                }),
            ).resolves.toBeDefined();
        });

        it('a shared-subtree rename or delete never touches a personal folder with the same path', async () => {
            const personal = await folders.create({ userId, name: 'Docs', path: '/Docs' });
            const personalChild = await folders.create({
                userId,
                name: 'Q3',
                path: '/Docs/Q3',
                parentId: personal.id,
            });
            const shared = await folders.create({
                userId,
                name: 'Docs',
                path: '/Docs',
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: ORG,
            });

            await folders.updateOrganizationSubtreePaths(ORG, '/Docs', '/Guides');
            expect((await folders.listByUser(userId)).map((f) => f.path).sort()).toEqual([
                '/Docs',
                '/Docs/Q3',
            ]);
            expect((await folders.findOrganizationFolder(ORG, shared.id))?.path).toBe('/Guides');

            await folders.deleteOrganizationFoldersByIds(ORG, [
                shared.id,
                personal.id,
                personalChild.id,
            ]);
            expect((await folders.listByUser(userId)).map((f) => f.id).sort()).toEqual(
                [personal.id, personalChild.id].sort(),
            );
            expect(await folders.countByOrganization(ORG)).toBe(0);
        });

        it('refuses an organization-scope folder that names no Organization, and writes nothing', async () => {
            for (const organizationId of [undefined, null, '']) {
                await expect(
                    folders.create({
                        userId,
                        name: 'Orphan',
                        path: '/Orphan',
                        scope: MemoryFolderScope.ORGANIZATION,
                        organizationId,
                    } as never),
                ).rejects.toThrow('requires an organizationId');
            }
            expect(await dataSource.getRepository(MemoryFolder).count()).toBe(0);
            // A personal folder may still carry the tenancy stamp.
            await expect(
                folders.create({ userId, name: 'Mine', path: '/Mine', organizationId: ORG }),
            ).resolves.toMatchObject({ organizationId: ORG });
            expect((await folders.listByUser(userId)).map((f) => f.name)).toEqual(['Mine']);
        });

        it('rolls a shared rename back whole when the folder-row write fails after the path rewrite', async () => {
            const service = new MemoryFoldersService(folders, {} as never, {} as never);
            const parent = await service.createOrganizationFolder(ORG, userId, {
                name: 'Playbooks',
            });
            await service.createOrganizationFolder(ORG, userId, {
                name: 'Support',
                parentId: parent.id,
            });
            jest.spyOn(MemoryFolderRepository.prototype, 'update').mockRejectedValueOnce(
                new Error('write failed'),
            );

            await expect(
                service.renameOrganizationFolder(ORG, userId, parent.id, 'Guides'),
            ).rejects.toThrow('write failed');

            const rows = await folders.listByOrganization(ORG);
            expect(rows.map((row) => [row.name, row.path])).toEqual([
                ['Playbooks', '/Playbooks'],
                ['Support', '/Playbooks/Support'],
            ]);
        });

        it('rolls a shared delete back whole — documents stay filed — when the folder delete fails', async () => {
            const service = new MemoryFoldersService(folders, {} as never, {} as never);
            const folder = await service.createOrganizationFolder(ORG, userId, { name: 'Reports' });
            const filed = await seed({ slug: 'filed-report', folderId: folder.id });
            jest.spyOn(
                MemoryFolderRepository.prototype,
                'deleteOrganizationFoldersByIds',
            ).mockRejectedValueOnce(new Error('delete failed'));

            await expect(
                service.deleteOrganizationFolder(ORG, userId, folder.id, (ids, manager) =>
                    documents.clearFolders(ids, manager),
                ),
            ).rejects.toThrow('delete failed');

            expect((await docs.findOneByOrFail({ id: filed.id })).folderId).toBe(folder.id);
            expect(await folders.findOrganizationFolder(ORG, folder.id)).not.toBeNull();

            // Without the failure the same call unfiles and deletes together.
            await expect(
                service.deleteOrganizationFolder(ORG, userId, folder.id, (ids, manager) =>
                    documents.clearFolders(ids, manager),
                ),
            ).resolves.toEqual({ deletedFolders: 1, unfiledDocuments: 1 });
            expect((await docs.findOneByOrFail({ id: filed.id })).folderId).toBeNull();
        });

        it('lists direct children at the top level and under a parent', async () => {
            const top = await folders.create({
                userId,
                name: 'Playbooks',
                path: '/Playbooks',
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: ORG,
            });
            await folders.create({
                userId,
                name: 'Support',
                path: '/Playbooks/Support',
                parentId: top.id,
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: ORG,
            });
            expect((await folders.listOrganizationChildren(ORG, null)).map((f) => f.name)).toEqual([
                'Playbooks',
            ]);
            expect(
                (await folders.listOrganizationChildren(ORG, top.id)).map((f) => f.name),
            ).toEqual(['Support']);
        });
    });

    describe('library listing', () => {
        it('stamps a revision timestamp on every created document', async () => {
            const created = await seed({ slug: 'fresh', title: 'Fresh' });
            expect(created.revisionAt).toBeInstanceOf(Date);
            expect(created.revision).toBe(1);
        });

        it('two concurrent revision bumps land on two distinct revisions', async () => {
            const d = await seed({ slug: 'contended', revision: 3 });
            const at = new Date('2026-09-14T09:00:00Z');

            const bumps = await Promise.all([
                documents.bumpRevision(d.id, at),
                documents.bumpRevision(d.id, at),
            ]);

            expect(bumps.map((b) => b?.revision ?? 0).sort((a, b) => a - b)).toEqual([4, 5]);
            const reloaded = await docs.findOneByOrFail({ id: d.id });
            expect(reloaded.revision).toBe(5);
            expect(reloaded.revisionAt?.getTime()).toBe(at.getTime());
        });

        it('a bump that read a revision another edit already moved retries onto the next one', async () => {
            const d = await seed({ slug: 'stale', revision: 3 });
            // The first read sees revision 3; before its compare-and-set runs,
            // another edit moves the row to 4 — so the first attempt must not
            // land, and the retry must take 5 rather than write 4 twice.
            const findOne = docs.findOne.bind(docs);
            const spy = jest.spyOn(docs, 'findOne').mockImplementationOnce(async (options) => {
                const row = await findOne(options);
                await docs.update({ id: d.id }, { revision: 4 });
                return row;
            });

            const bumped = await documents.bumpRevision(d.id);

            expect(bumped?.revision).toBe(5);
            expect(spy).toHaveBeenCalledTimes(2);
            expect((await docs.findOneByOrFail({ id: d.id })).revision).toBe(5);
        });

        it('a guarded edit lands content and revision together, and a stale one writes nothing', async () => {
            const d = await seed({ slug: 'guarded', revision: 3, title: 'Before' });

            const landed = await documents.update(
                d.id,
                { title: 'First edit', revision: 4, revisionAt: new Date() },
                { expectedRevision: 3 },
            );
            expect(landed).toMatchObject({ title: 'First edit', revision: 4 });

            // A second edit computed from revision 3 lost the race.
            const stale = await documents.update(
                d.id,
                { title: 'Stale edit', revision: 4, revisionAt: new Date() },
                { expectedRevision: 3 },
            );
            expect(stale).toBeNull();
            expect(await docs.findOneByOrFail({ id: d.id })).toMatchObject({
                title: 'First edit',
                revision: 4,
            });
        });

        it('a bump on a document that no longer exists writes nothing', async () => {
            expect(await documents.bumpRevision('00000000-0000-0000-0000-00000000dead')).toBeNull();
        });

        it('filters archived documents out by default, alone, or mixed in', async () => {
            await seed({ slug: 'live', title: 'Live' });
            await seed({ slug: 'gone', title: 'Gone', status: KbDocumentStatus.ARCHIVED });
            const titles = async (archived: 'exclude' | 'only' | 'include') =>
                (
                    await documents.listForLibrary({
                        ...scope(),
                        archived,
                        sort: 'title',
                        limit: 50,
                        offset: 0,
                    })
                ).items.map((d) => d.title);
            expect(await titles('exclude')).toEqual(['Live']);
            expect(await titles('only')).toEqual(['Gone']);
            expect(await titles('include')).toEqual(['Gone', 'Live']);
        });

        it('includes organization documents and never another Organization’s or a foreign Work’s', async () => {
            await seed({ slug: 'a', title: 'A' });
            await seed({ slug: 'org', title: 'Org doc', workId: null, organizationId: ORG });
            await seed({
                slug: 'other-org',
                title: 'Other org',
                workId: null,
                organizationId: OTHER_ORG,
            });
            await seed({ slug: 'foreign', title: 'Foreign', workId: foreignWork });
            const { items, total } = await documents.listForLibrary({
                ...scope(),
                archived: 'exclude',
                sort: 'title',
                limit: 50,
                offset: 0,
            });
            expect(items.map((d) => d.title)).toEqual(['A', 'Org doc']);
            expect(total).toBe(2);
        });

        it('sorts "recent" by the last substantive change, not by bookkeeping writes', async () => {
            const older = await seed({
                slug: 'older',
                title: 'Older',
                revisionAt: new Date('2026-08-01T00:00:00Z'),
            });
            await seed({
                slug: 'newer',
                title: 'Newer',
                revisionAt: new Date('2026-09-01T00:00:00Z'),
            });
            // A mirror / embed stamp on the older document must not reorder the shelf.
            await documents.update(older.id, {
                lastCommitSha: 'abc123',
                lastIndexedAt: new Date(),
            });

            const { items } = await documents.listForLibrary({
                ...scope(),
                archived: 'exclude',
                sort: 'recent',
                limit: 50,
                offset: 0,
            });
            expect(items.map((d) => d.title)).toEqual(['Newer', 'Older']);
            const reloaded = await docs.findOneByOrFail({ id: older.id });
            expect(reloaded.revision).toBe(1);
        });

        it('sorts titles case-insensitively and pages without repeating rows', async () => {
            for (const title of ['banana', 'Apple', 'cherry', 'apricot']) {
                await seed({ slug: title.toLowerCase(), title });
            }
            const page = async (offset: number) =>
                (
                    await documents.listForLibrary({
                        ...scope(),
                        archived: 'exclude',
                        sort: 'title',
                        limit: 2,
                        offset,
                    })
                ).items.map((d) => d.title);
            expect([...(await page(0)), ...(await page(2))]).toEqual([
                'Apple',
                'apricot',
                'banana',
                'cherry',
            ]);
        });

        it('a keyset page resumes after the last row served even when a newer document arrives in between', async () => {
            for (const [slug, at] of [
                ['d1', '2026-09-01T00:00:00Z'],
                ['d2', '2026-09-02T00:00:00Z'],
                ['d3', '2026-09-03T00:00:00Z'],
                ['d4', '2026-09-04T00:00:00Z'],
            ] as const) {
                await seed({ slug, title: slug, revisionAt: new Date(at) });
            }
            const list = (after?: { sortKey: string; id: string }) =>
                documents.listForLibrary({
                    ...scope(),
                    archived: 'exclude',
                    sort: 'recent',
                    limit: 2,
                    offset: 0,
                    after,
                });

            const first = await list();
            expect(first.items.map((d) => d.title)).toEqual(['d4', 'd3']);
            expect(first.nextAfter).not.toBeNull();

            // Lands at the top of the shelf between the two requests.
            await seed({ slug: 'd5', title: 'd5', revisionAt: new Date('2026-09-05T00:00:00Z') });

            const second = await list(first.nextAfter ?? undefined);
            expect(second.items.map((d) => d.title)).toEqual(['d2', 'd1']);
            expect(second.nextAfter).toBeNull();
            expect(second.total).toBe(5);
        });

        it('a keyset page never repeats or skips a row when titles are re-sorted between requests', async () => {
            for (const title of ['banana', 'Apple', 'cherry', 'apricot']) {
                await seed({ slug: title.toLowerCase(), title });
            }
            const list = (after?: { sortKey: string; id: string }) =>
                documents.listForLibrary({
                    ...scope(),
                    archived: 'exclude',
                    sort: 'title',
                    limit: 2,
                    offset: 0,
                    after,
                });
            const first = await list();
            expect(first.items.map((d) => d.title)).toEqual(['Apple', 'apricot']);
            // A new first title would push an offset page back by one row.
            await seed({ slug: 'aardvark', title: 'Aardvark' });
            const second = await list(first.nextAfter ?? undefined);
            expect(second.items.map((d) => d.title)).toEqual(['banana', 'cherry']);
        });

        it('keyset pages break ties on the sort key by id, across millisecond-equal timestamps', async () => {
            const at = new Date('2026-09-10T10:00:00.123Z');
            const ids: string[] = [];
            for (const slug of ['t1', 't2', 't3']) {
                ids.push((await seed({ slug, title: slug, revisionAt: at })).id);
            }
            const seen: string[] = [];
            let after: { sortKey: string; id: string } | undefined;
            for (let page = 0; page < 3; page++) {
                const result = await documents.listForLibrary({
                    ...scope(),
                    archived: 'exclude',
                    sort: 'recent',
                    limit: 1,
                    offset: 0,
                    after,
                });
                seen.push(...result.items.map((d) => d.id));
                after = result.nextAfter ?? undefined;
                if (!after) break;
            }
            expect(seen).toEqual([...ids].sort());
        });

        it('filters by folder and by Unfiled, and matches free text on the slug too', async () => {
            const folder = await folders.create({
                userId,
                name: 'Playbooks',
                path: '/Playbooks',
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: ORG,
            });
            await seed({ slug: 'refund-policy', title: 'Money back', folderId: folder.id });
            await seed({ slug: 'voice', title: 'Voice guide' });

            const list = (extra: Record<string, unknown>) =>
                documents.listForLibrary({
                    ...scope(),
                    archived: 'exclude',
                    sort: 'title',
                    limit: 50,
                    offset: 0,
                    ...extra,
                });
            expect((await list({ folderId: folder.id })).items.map((d) => d.title)).toEqual([
                'Money back',
            ]);
            expect((await list({ folderId: null })).items.map((d) => d.title)).toEqual([
                'Voice guide',
            ]);
            expect((await list({ q: 'REFUND' })).items.map((d) => d.title)).toEqual(['Money back']);
            expect((await list({ q: '100%' })).items).toEqual([]);
        });
    });

    describe('counts, filing and unfiling', () => {
        it('counts live documents per folder and archived documents separately', async () => {
            const folder = await folders.create({
                userId,
                name: 'Reports',
                path: '/Reports',
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: ORG,
            });
            await seed({ slug: 'r1', folderId: folder.id });
            await seed({ slug: 'r2', folderId: folder.id });
            await seed({ slug: 'loose' });
            await seed({ slug: 'old', status: KbDocumentStatus.ARCHIVED, folderId: folder.id });

            const counts = await documents.countsForLibrary(scope());
            expect(counts.byFolder.get(folder.id)).toBe(2);
            expect(counts.byFolder.get(null)).toBe(1);
            expect(counts.archived).toBe(1);
        });

        it('filing moves only the folder column and leaves the revision alone', async () => {
            const folder = await folders.create({
                userId,
                name: 'Playbooks',
                path: '/Playbooks',
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: ORG,
            });
            const d = await seed({
                slug: 'filed',
                revision: 3,
                normalizedContentHash: 'h'.repeat(64),
            });
            await documents.setFolder([d.id], folder.id);
            const reloaded = await docs.findOneByOrFail({ id: d.id });
            expect(reloaded.folderId).toBe(folder.id);
            expect(reloaded.revision).toBe(3);
            expect(reloaded.normalizedContentHash).toBe('h'.repeat(64));
        });

        it('clearing folders unfiles their documents and reports how many', async () => {
            const folder = await folders.create({
                userId,
                name: 'Playbooks',
                path: '/Playbooks',
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: ORG,
            });
            const a = await seed({ slug: 'a', folderId: folder.id });
            await seed({ slug: 'b', folderId: folder.id, status: KbDocumentStatus.ARCHIVED });
            expect(await documents.clearFolders([folder.id])).toBe(2);
            expect((await docs.findOneByOrFail({ id: a.id })).folderId).toBeNull();
            expect(await documents.clearFolders([folder.id])).toBe(0);
        });
    });

    describe('shared folders outlive their creator’s account', () => {
        const makeTenantWithOrganization = async (ownerUserId: string, slug: string) => {
            const tenants = dataSource.getRepository(Tenant);
            const tenant = await tenants.save(
                tenants.create({ ownerUserId, slug, displayName: slug } as Partial<Tenant>),
            );
            const organizations = dataSource.getRepository(Organization);
            const organization = await organizations.save(
                organizations.create({
                    tenantId: tenant.id,
                    slug: `${slug}-org`,
                    displayName: slug,
                } as Partial<Organization>),
            );
            return { tenant, organization };
        };

        const makeMember = async (
            name: string,
            tenantId: string | null,
            extra: Partial<User> = {},
        ) => {
            const users = dataSource.getRepository(User);
            return users.save(
                users.create({
                    username: name,
                    email: `${name}@example.com`,
                    password: 'x',
                    tenantId,
                    ...extra,
                } as Partial<User>),
            );
        };

        const cleanupService = () =>
            new AnonymousUserCleanupService(
                new UserRepository(dataSource.getRepository(User)),
                undefined,
                folders,
                new OrganizationRepository(dataSource.getRepository(Organization)),
                new TenantRepository(dataSource.getRepository(Tenant)),
            );

        it('hands an expired anonymous member’s shared folders to the Organization before the account goes', async () => {
            const { tenant, organization } = await makeTenantWithOrganization(userId, 'acme');
            await dataSource.getRepository(User).update({ id: userId }, { tenantId: tenant.id });
            const anon = await makeMember('anon-1', tenant.id, {
                isAnonymous: true,
                anonymousExpiresAt: new Date('2026-01-01T00:00:00Z'),
            });
            const shared = await folders.create({
                userId: anon.id,
                name: 'Playbooks',
                path: '/Playbooks',
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: organization.id,
            });
            const personal = await folders.create({ userId: anon.id, name: 'Mine', path: '/Mine' });

            const summary = await cleanupService().purgeExpired(new Date('2026-09-14T00:00:00Z'));

            expect(summary).toMatchObject({ deleted: 1, failed: 0 });
            expect(await dataSource.getRepository(User).findOneBy({ id: anon.id })).toBeNull();
            const kept = await folders.findOrganizationFolder(organization.id, shared.id);
            expect(kept?.userId).toBe(userId);
            expect(kept?.path).toBe('/Playbooks');
            // Personal folders are the account's own and are never re-attributed.
            expect(
                (await dataSource.getRepository(MemoryFolder).findOneBy({ id: personal.id }))
                    ?.userId,
            ).toBe(anon.id);
        });

        it('prefers a registered member over another anonymous one when the Tenant owner is the one leaving', async () => {
            const anonOwner = await makeMember('anon-owner', null, {
                isAnonymous: true,
            });
            const { tenant, organization } = await makeTenantWithOrganization(anonOwner.id, 'solo');
            await dataSource
                .getRepository(User)
                .update({ id: anonOwner.id }, { tenantId: tenant.id });
            await makeMember('anon-peer', tenant.id, { isAnonymous: true });
            const registered = await makeMember('registered', tenant.id);
            await folders.create({
                userId: anonOwner.id,
                name: 'Docs',
                path: '/Docs',
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: organization.id,
            });

            const users = new UserRepository(dataSource.getRepository(User));
            expect((await users.findOtherTenantMember(tenant.id, anonOwner.id))?.id).toBe(
                registered.id,
            );
            expect(await folders.listOrganizationIdsWithFoldersCreatedBy(anonOwner.id)).toEqual([
                organization.id,
            ]);
            expect(
                await folders.reassignOrganizationFolders(
                    organization.id,
                    anonOwner.id,
                    registered.id,
                ),
            ).toBe(1);
            expect(await folders.listOrganizationIdsWithFoldersCreatedBy(anonOwner.id)).toEqual([]);
        });

        it('finds no successor for the last member of a Tenant', async () => {
            const { tenant } = await makeTenantWithOrganization(otherUserId, 'lonely');
            await dataSource
                .getRepository(User)
                .update({ id: otherUserId }, { tenantId: tenant.id });
            const users = new UserRepository(dataSource.getRepository(User));
            expect(await users.findOtherTenantMember(tenant.id, otherUserId)).toBeNull();
        });
    });

    describe('reader state', () => {
        it('records a read once, never moves the read revision backwards, and marks unread as UPDATED', async () => {
            const d = await seed({ slug: 'read-me', revision: 4 });
            const first = await readerStates.upsertRead(
                userId,
                d.id,
                4,
                new Date('2026-09-01T00:00:00Z'),
            );
            expect(first.lastReadRevision).toBe(4);
            const opened = first.lastOpenedAt;

            const stale = await readerStates.upsertRead(
                userId,
                d.id,
                2,
                new Date('2026-09-05T00:00:00Z'),
            );
            expect(stale.lastReadRevision).toBe(4);
            expect(stale.lastOpenedAt?.getTime()).toBe(opened?.getTime());

            const unread = await readerStates.markUnread(userId, d.id);
            expect(unread.lastReadRevision).toBe(0);
            expect(unread.lastOpenedAt).not.toBeNull();
            expect(await dataSource.getRepository(KnowledgeDocumentReaderState).count()).toBe(1);
        });

        it('a read that loaded the row before a higher concurrent read never writes the lower revision back', async () => {
            const d = await seed({ slug: 'raced-read', revision: 5 });
            await readerStates.upsertRead(userId, d.id, 1, new Date('2026-09-01T00:00:00Z'));
            const rows = dataSource.getRepository(KnowledgeDocumentReaderState);
            // The slower read loads the row at revision 1; before it writes,
            // a faster read of revision 5 lands.
            const findOne = rows.findOne.bind(rows);
            jest.spyOn(rows, 'findOne').mockImplementationOnce(async (options) => {
                const row = await findOne(options);
                await rows.update({ userId, documentId: d.id }, { lastReadRevision: 5 });
                return row;
            });

            const slower = await readerStates.upsertRead(userId, d.id, 4);

            expect(slower.lastReadRevision).toBe(5);
            expect(
                (await rows.findOneByOrFail({ userId, documentId: d.id })).lastReadRevision,
            ).toBe(5);
        });

        it('two reads racing on the same row keep the higher revision', async () => {
            const d = await seed({ slug: 'two-reads', revision: 5 });
            await readerStates.upsertRead(userId, d.id, 1);
            await Promise.all([
                readerStates.upsertRead(userId, d.id, 5),
                readerStates.upsertRead(userId, d.id, 4),
            ]);
            const row = await dataSource
                .getRepository(KnowledgeDocumentReaderState)
                .findOneByOrFail({ userId, documentId: d.id });
            expect(row.lastReadRevision).toBe(5);
        });

        it('a pin written from a stale row never moves the read revision, and keeps the first pin time', async () => {
            const d = await seed({ slug: 'pin-race', revision: 5 });
            await readerStates.upsertRead(userId, d.id, 1);
            const rows = dataSource.getRepository(KnowledgeDocumentReaderState);
            const findOne = rows.findOne.bind(rows);
            jest.spyOn(rows, 'findOne').mockImplementationOnce(async (options) => {
                const row = await findOne(options);
                await rows.update({ userId, documentId: d.id }, { lastReadRevision: 5 });
                return row;
            });

            const firstPin = new Date('2026-09-02T00:00:00Z');
            await readerStates.upsertPin(userId, d.id, firstPin);
            const pinned = await readerStates.upsertPin(
                userId,
                d.id,
                new Date('2026-09-03T00:00:00Z'),
            );

            expect(pinned.lastReadRevision).toBe(5);
            expect(pinned.pinnedAt?.getTime()).toBe(firstPin.getTime());
        });

        it('pins and unpins per person', async () => {
            const d = await seed({ slug: 'pin-me' });
            await readerStates.upsertPin(userId, d.id);
            expect(await readerStates.countPins(userId)).toBe(1);
            expect(await readerStates.countPins(otherUserId)).toBe(0);
            await readerStates.deletePin(userId, d.id);
            expect(await readerStates.countPins(userId)).toBe(0);
        });

        it('rolls unread up per folder in one query, for one person only, ignoring archived documents', async () => {
            const folderA = await folders.create({
                userId,
                name: 'A',
                path: '/A',
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: ORG,
            });
            const folderB = await folders.create({
                userId,
                name: 'B',
                path: '/B',
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId: ORG,
            });
            const readInA = await seed({ slug: 'a-read', folderId: folderA.id, revision: 2 });
            await seed({ slug: 'a-new', folderId: folderA.id });
            const readInB = await seed({ slug: 'b-read', folderId: folderB.id, revision: 1 });
            await seed({
                slug: 'b-archived',
                folderId: folderB.id,
                status: KbDocumentStatus.ARCHIVED,
            });
            const updatedUnfiled = await seed({ slug: 'loose', revision: 5 });

            await readerStates.upsertRead(userId, readInA.id, 2);
            await readerStates.upsertRead(userId, readInB.id, 1);
            await readerStates.upsertRead(userId, updatedUnfiled.id, 4);
            // A teammate reading everything changes nothing for the reader.
            await readerStates.upsertRead(otherUserId, updatedUnfiled.id, 5);

            const rollups = await readerStates.rollupsForUser(userId, scope());
            const byFolder = new Map(rollups.map((r) => [r.folderId, r]));
            expect(byFolder.get(folderA.id)).toMatchObject({ hasUnread: true, unreadCount: 1 });
            expect(byFolder.get(folderB.id)).toMatchObject({ hasUnread: false, unreadCount: 0 });
            expect(byFolder.get(null)).toMatchObject({ hasUnread: true, unreadCount: 1 });
        });
    });
});
