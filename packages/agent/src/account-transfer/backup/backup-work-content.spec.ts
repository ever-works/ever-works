// The data-repository module is mocked for the same reason
// `account-export.service.spec.ts` mocks it: the walk under test only ever
// calls the static `DataRepository.create`, and pulling in fs-extra /
// isomorphic-git would make this a filesystem test instead of a wiring test.
jest.mock('../../generators/data-generator/data-repository', () => ({
    DataRepository: { create: jest.fn() },
}));

import { AccountExportService } from '../account-export.service';
import { DataRepository } from '../../generators/data-generator/data-repository';
import { Work } from '../../entities/work.entity';
import { AccountExportWorkContentSource } from './backup-work-content';

const dataRepoCreateMock = DataRepository.create as jest.Mock;

/**
 * The Work content port, driven END TO END: the real
 * `AccountExportWorkContentSource` over the real `AccountExportService`,
 * handed the same `{ id, slug }` literal the runner builds out of a raw row.
 *
 * That combination had never been exercised. `account-export.service.spec.ts`
 * drives the walk with a hand-made `makeWork()` that supplies
 * `getRepoOwner` and `getDataRepo` as plain properties, and the runner spec
 * injects a fake content source — so the one seam that mattered, a real ref
 * meeting the real implementation, was tested from neither side.
 *
 * What was wrong: the walk resolves a Work's repository coordinates through
 * `Work.getRepoOwner()` and `Work.getDataRepo()`, instance methods on the
 * entity PROTOTYPE. A `{ id, slug }` object literal has neither, so
 * `dir.getRepoOwner()` threw a `TypeError` inside the walk's own try/catch,
 * which logged a per-Work warning and returned EMPTY content. The port then
 * resolved successfully with five empty arrays, `addWorkContent` never set
 * `degraded`, and every archive of every workspace wrote
 * `data/works/content/<slug>/{items,categories,tags,collections,comparisons}.jsonl`
 * as zero-line files while the manifest reported the `works` domain
 * complete. The parameter being typed `any` is exactly why the compiler did
 * not see it.
 */
describe('AccountExportWorkContentSource over a real backup ref', () => {
    const REF = { id: 'work-1', slug: 'acme-tools' };

    function makeData(overrides: Record<string, jest.Mock> = {}) {
        return {
            getItems: jest.fn().mockResolvedValue([{ slug: 'an-item', name: 'An item' }]),
            getCategories: jest.fn().mockResolvedValue([{ slug: 'a-category' }]),
            getTags: jest.fn().mockResolvedValue([{ slug: 'a-tag' }]),
            getCollections: jest.fn().mockResolvedValue([{ slug: 'a-collection' }]),
            getConfig: jest.fn().mockResolvedValue({ name: 'Acme Tools' }),
            getComparisons: jest.fn().mockResolvedValue([{ slug: 'a-vs-b' }]),
            readMarkdownTemplate: jest.fn().mockResolvedValue({ header: '# Acme' }),
            getComparisonMarkdown: jest.fn().mockResolvedValue('## A vs B'),
            ...overrides,
        };
    }

    /**
     * A REAL `Work` instance, so `getRepoOwner()` and `getDataRepo()` are the
     * prototype methods production calls rather than properties a fixture
     * remembered to add.
     */
    function makeWorkEntity(): Work {
        const work = new Work();
        Object.assign(work, {
            id: REF.id,
            slug: REF.slug,
            name: 'Acme Tools',
            owner: 'acme',
            userId: 'user-1',
            gitProvider: 'a-code-host',
            user: { id: 'user-1', username: 'acme' },
        });
        return work;
    }

    function makeSource(options: { work?: Work | null; data?: ReturnType<typeof makeData> } = {}) {
        const data = options.data ?? makeData();
        dataRepoCreateMock.mockReset();
        dataRepoCreateMock.mockResolvedValue(data);

        const workRepository = {
            findById: jest
                .fn()
                .mockResolvedValue(options.work === undefined ? makeWorkEntity() : options.work),
            findByUser: jest.fn().mockResolvedValue([]),
        };
        const gitFacade = { cloneOrPull: jest.fn().mockResolvedValue('/tmp/clone') };
        const empty = { findByWork: jest.fn().mockResolvedValue([]) };

        const exportService = new AccountExportService(
            workRepository as never,
            empty as never,
            empty as never,
            { findByUser: jest.fn().mockResolvedValue([]) } as never,
            empty as never,
            { findById: jest.fn() } as never,
            { findByWorkId: jest.fn().mockResolvedValue(null) } as never,
            { findByWorkId: jest.fn().mockResolvedValue(null) } as never,
            gitFacade as never,
        );

        return {
            source: new AccountExportWorkContentSource(exportService),
            workRepository,
            gitFacade,
            data,
        };
    }

    it('returns the Work’s actual content for a bare { id, slug } ref', async () => {
        const { source, data } = makeSource();

        const content = await source.readWorkContent(REF);

        // Every group the archive writes has to arrive. Before the fix all
        // five came back empty and nothing said so.
        expect(content.items).toHaveLength(1);
        expect(content.categories).toHaveLength(1);
        expect(content.tags).toHaveLength(1);
        expect(content.collections).toHaveLength(1);
        expect(content.comparisons).toHaveLength(1);
        expect(content.siteConfig).toEqual({ name: 'Acme Tools' });
        expect(content.markdownTemplate).toEqual({ header: '# Acme' });
        expect(data.getItems).toHaveBeenCalled();
    });

    it('resolves the repo coordinates from the loaded entity, not from the ref', async () => {
        const { source, workRepository, gitFacade } = makeSource();

        await source.readWorkContent(REF);

        expect(workRepository.findById).toHaveBeenCalledWith(REF.id);
        // `acme/acme-tools-data` is what `Work.getRepoOwner()` /
        // `getDataRepo()` derive. A ref-shaped literal cannot produce this,
        // which is the whole defect.
        expect(gitFacade.cloneOrPull).toHaveBeenCalledWith(
            { owner: 'acme', repo: 'acme-tools-data' },
            { userId: 'user-1', providerId: 'a-code-host' },
        );
    });

    it('rejects — rather than resolving empty — when the Work cannot be loaded', async () => {
        // A Work the archive was told about and cannot load is a GAP. The
        // runner turns a rejection into `partial` /
        // `work_content_unavailable`; resolving empty is what let the
        // manifest claim completeness over nothing.
        const { source } = makeSource({ work: null });

        await expect(source.readWorkContent(REF)).rejects.toThrow(/No Work found/);
    });

    it('still resolves empty when the repo itself will not read', async () => {
        // The documented contract for an unreachable data repo is unchanged:
        // a Work whose repo is gone costs that Work its content, and the
        // runner marks the domain partial — it does not fail the archive.
        const { source } = makeSource({
            data: makeData({ getItems: jest.fn().mockRejectedValue(new Error('repo gone')) }),
        });
        dataRepoCreateMock.mockRejectedValue(new Error('clone failed'));

        const content = await source.readWorkContent(REF);
        expect(content.items).toEqual([]);
        expect(content.categories).toEqual([]);
    });
});
