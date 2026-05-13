// Mock the data-generator module BEFORE the SUT import to avoid pulling in
// `p-map` (ESM-only) via the data-generator chain. The service consumes
// DataGeneratorService only as a DI token; runtime behaviour is fully
// substituted by the hand-built mock injected into the constructor.
jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class MockDataGeneratorService {},
}));

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkTaxonomyService } from '../work-taxonomy.service';
import { GenerateStatusType } from '@src/entities/types';
import { WorkHistoryActivityType } from '@ever-works/contracts/api';
import type { User } from '@src/entities/user.entity';
import type { Work } from '@src/entities';
import type { Category, Collection, Tag } from '@ever-works/contracts';

describe('WorkTaxonomyService', () => {
    let dataGenerator: {
        getCategoriesTags: jest.Mock;
        saveCategories: jest.Mock;
        saveTags: jest.Mock;
        saveCollections: jest.Mock;
    };
    let ownershipService: {
        ensureAccess: jest.Mock;
        ensureCanEdit: jest.Mock;
    };
    let userRepository: {
        findById: jest.Mock;
    };
    let generationHistoryRepository: {
        createEntry: jest.Mock;
    };
    let service: WorkTaxonomyService;

    const buildUser = (overrides: Partial<User> = {}): User =>
        ({ id: 'u-1', username: 'user', ...overrides }) as User;

    const buildWork = (overrides: Partial<Work> = {}): Work =>
        ({ id: 'w-1', userId: 'u-1', ...overrides }) as Work;

    const buildCategory = (overrides: Partial<Category> = {}): Category => ({
        id: 'cat-1',
        name: 'Category One',
        description: 'desc',
        icon_url: 'https://example.com/icon.png',
        priority: 1,
        ...overrides,
    });

    const buildTag = (overrides: Partial<Tag> = {}): Tag => ({
        id: 'tag-1',
        name: 'Tag One',
        ...overrides,
    });

    const buildCollection = (overrides: Partial<Collection> = {}): Collection => ({
        id: 'col-1',
        name: 'Collection One',
        description: 'col desc',
        icon_url: 'https://example.com/col.png',
        priority: 5,
        ...overrides,
    });

    beforeEach(() => {
        dataGenerator = {
            getCategoriesTags: jest.fn().mockResolvedValue({
                categories: [],
                tags: [],
                collections: [],
            }),
            saveCategories: jest.fn().mockResolvedValue(undefined),
            saveTags: jest.fn().mockResolvedValue(undefined),
            saveCollections: jest.fn().mockResolvedValue(undefined),
        };
        ownershipService = {
            ensureAccess: jest.fn().mockResolvedValue({ work: buildWork() }),
            ensureCanEdit: jest.fn().mockResolvedValue({ work: buildWork() }),
        };
        userRepository = {
            findById: jest.fn().mockResolvedValue(buildUser()),
        };
        generationHistoryRepository = {
            createEntry: jest.fn().mockResolvedValue(undefined),
        };
        service = new WorkTaxonomyService(
            dataGenerator as any,
            ownershipService as any,
            userRepository as any,
            generationHistoryRepository as any,
        );
    });

    // ============================================================================
    // ensureUser (private; observed via list endpoints)
    // ============================================================================
    describe('ensureUser (observed via getCategories)', () => {
        it('throws NotFoundException with userId-interpolated message when user is missing', async () => {
            userRepository.findById.mockResolvedValueOnce(null);

            await expect(service.getCategories('w-1', 'u-missing')).rejects.toMatchObject({
                message: 'User not found: u-missing',
            });
            // Pinned: data-generator NEVER queried when user lookup fails — the
            // service must fail closed so a deleted-user race cannot mutate
            // the data repo.
            expect(dataGenerator.getCategoriesTags).not.toHaveBeenCalled();
        });

        it('forwards positional userId to userRepository.findById', async () => {
            await service.getCategories('w-1', 'u-target');

            expect(userRepository.findById).toHaveBeenCalledWith('u-target');
        });
    });

    // ============================================================================
    // Categories — read
    // ============================================================================
    describe('getCategories', () => {
        it('runs ensureAccess (NOT ensureCanEdit) before ensureUser before getCategoriesTags', async () => {
            const order: string[] = [];
            ownershipService.ensureAccess.mockImplementation(async () => {
                order.push('ensureAccess');
                return { work: buildWork() };
            });
            userRepository.findById.mockImplementation(async () => {
                order.push('findById');
                return buildUser();
            });
            dataGenerator.getCategoriesTags.mockImplementation(async () => {
                order.push('getCategoriesTags');
                return { categories: [], tags: [], collections: [] };
            });

            await service.getCategories('w-1', 'u-1');

            expect(order).toEqual(['ensureAccess', 'findById', 'getCategoriesTags']);
            // Pinned: viewers can read taxonomy — `ensureCanEdit` would refuse
            // viewers AND short-circuit listing. A future tightening would be
            // a deliberate breaking change.
            expect(ownershipService.ensureCanEdit).not.toHaveBeenCalled();
        });

        it('returns categories array from data-generator', async () => {
            const cats = [buildCategory({ id: 'a' }), buildCategory({ id: 'b' })];
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: cats,
                tags: [],
                collections: [],
            });

            const result = await service.getCategories('w-1', 'u-1');

            expect(result).toBe(cats);
        });

        it('coerces missing categories to [] via `|| []` short-circuit', async () => {
            // Pinned: a future swap to `?? []` would change the empty-string
            // / 0-as-truthy semantics, but for arrays they are equivalent.
            // Either way, missing categories MUST present as an empty array
            // so callers don't have to defensively check.
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: undefined,
                tags: [],
                collections: [],
            });

            const result = await service.getCategories('w-1', 'u-1');

            expect(result).toEqual([]);
        });

        it('forwards (work, user) positionally to data-generator', async () => {
            const work = buildWork({ id: 'w-XYZ' });
            const user = buildUser({ id: 'u-XYZ' });
            ownershipService.ensureAccess.mockResolvedValue({ work });
            userRepository.findById.mockResolvedValue(user);

            await service.getCategories('w-XYZ', 'u-XYZ');

            expect(dataGenerator.getCategoriesTags).toHaveBeenCalledWith(work, user);
        });

        it('short-circuits when ensureAccess rejects', async () => {
            const err = new ForbiddenException('forbidden');
            ownershipService.ensureAccess.mockRejectedValueOnce(err);

            await expect(service.getCategories('w-1', 'u-1')).rejects.toBe(err);
            expect(userRepository.findById).not.toHaveBeenCalled();
        });
    });

    // ============================================================================
    // Categories — create
    // ============================================================================
    describe('createCategory', () => {
        it('runs ensureCanEdit (NOT ensureAccess) before everything', async () => {
            const order: string[] = [];
            ownershipService.ensureCanEdit.mockImplementation(async () => {
                order.push('ensureCanEdit');
                return { work: buildWork() };
            });
            userRepository.findById.mockImplementation(async () => {
                order.push('findById');
                return buildUser();
            });
            dataGenerator.getCategoriesTags.mockImplementation(async () => {
                order.push('getCategoriesTags');
                return { categories: [], tags: [], collections: [] };
            });
            dataGenerator.saveCategories.mockImplementation(async () => {
                order.push('saveCategories');
            });
            generationHistoryRepository.createEntry.mockImplementation(async () => {
                order.push('createEntry');
            });

            await service.createCategory('w-1', { name: 'New Cat' } as any, 'u-1');

            expect(order).toEqual([
                'ensureCanEdit',
                'findById',
                'getCategoriesTags',
                'saveCategories',
                'createEntry',
            ]);
            // Pinned: editors only — viewers must NOT be able to mutate taxonomy.
            expect(ownershipService.ensureAccess).not.toHaveBeenCalled();
        });

        it('rejects with BadRequestException when normalized name collides with existing (case- and whitespace-insensitive)', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ name: 'Tools' })],
                tags: [],
                collections: [],
            });

            // Pinned: the dup check uses `name.toLowerCase()` and the dto is
            // `dto.name.toLowerCase().trim()`. Both must match → "  TOOLS  "
            // collides with "Tools".
            await expect(
                service.createCategory('w-1', { name: '  TOOLS  ' } as any, 'u-1'),
            ).rejects.toMatchObject({ message: 'A category with this name already exists' });
            expect(dataGenerator.saveCategories).not.toHaveBeenCalled();
            expect(generationHistoryRepository.createEntry).not.toHaveBeenCalled();
        });

        it('slugifies trimmed name into the id and trims optional fields', async () => {
            await service.createCategory(
                'w-1',
                {
                    name: '  My Tools  ',
                    description: '  desc  ',
                    icon_url: '  https://example.com/i.png  ',
                    priority: 3,
                } as any,
                'u-1',
            );

            const [, , savedList] = dataGenerator.saveCategories.mock.calls[0];
            expect(savedList).toHaveLength(1);
            expect(savedList[0]).toEqual({
                id: 'my-tools',
                name: 'My Tools',
                description: 'desc',
                icon_url: 'https://example.com/i.png',
                priority: 3,
            });
        });

        it('passes existing categories + new appended into save (immutable, spread-based)', async () => {
            const existing = [buildCategory({ id: 'a' }), buildCategory({ id: 'b', name: 'B' })];
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: existing,
                tags: [],
                collections: [],
            });

            await service.createCategory('w-1', { name: 'C' } as any, 'u-1');

            const [, , savedList] = dataGenerator.saveCategories.mock.calls[0];
            // Pinned: existing array is NOT mutated (`[...categories, newCategory]`).
            expect(savedList).toHaveLength(3);
            expect(savedList[2].id).toBe('c');
            expect(existing).toHaveLength(2);
        });

        it('writes a CATEGORY_CHANGE history entry with action="added"', async () => {
            await service.createCategory('w-1', { name: 'New Cat' } as any, 'u-1');

            expect(generationHistoryRepository.createEntry).toHaveBeenCalledTimes(1);
            const [entry] = generationHistoryRepository.createEntry.mock.calls[0];
            expect(entry.workId).toBe('w-1');
            expect(entry.userId).toBe('u-1');
            expect(entry.status).toBe(GenerateStatusType.GENERATED);
            expect(entry.durationInSeconds).toBe(0);
            expect(entry.triggeredBy).toBe('user');
            expect(entry.activityType).toBe(WorkHistoryActivityType.CATEGORY_CHANGE);
            // Pinned: startedAt === finishedAt === one fresh `new Date()` —
            // taxonomy edits are instant from the user's perspective.
            expect(entry.startedAt).toBeInstanceOf(Date);
            expect(entry.finishedAt).toBeInstanceOf(Date);
            expect(entry.startedAt.getTime()).toBe(entry.finishedAt.getTime());
            expect(entry.changelog).toBeDefined();
        });

        it('handles undefined optional fields without crashing on `?.trim()`', async () => {
            await service.createCategory(
                'w-1',
                { name: 'No Optionals', description: undefined, icon_url: undefined } as any,
                'u-1',
            );

            const [, , savedList] = dataGenerator.saveCategories.mock.calls[0];
            // Pinned: `dto.description?.trim()` short-circuits to undefined, NOT
            // empty-string. A future swap to `(dto.description ?? '').trim()`
            // would change the wire shape.
            expect(savedList[0].description).toBeUndefined();
            expect(savedList[0].icon_url).toBeUndefined();
        });

        it('returns documented success envelope with the new category', async () => {
            const result = await service.createCategory('w-1', { name: 'New Cat' } as any, 'u-1');

            expect(result).toEqual({
                status: 'success',
                category: {
                    id: 'new-cat',
                    name: 'New Cat',
                    description: undefined,
                    icon_url: undefined,
                    priority: undefined,
                },
            });
        });

        it('short-circuits when ensureCanEdit rejects', async () => {
            ownershipService.ensureCanEdit.mockRejectedValueOnce(new ForbiddenException());

            await expect(
                service.createCategory('w-1', { name: 'X' } as any, 'u-1'),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(dataGenerator.saveCategories).not.toHaveBeenCalled();
        });

        // ============================================================================
        // icon_svg sanitization (stored-XSS guard — frontend renders inline)
        // ============================================================================
        it('sanitizes inline icon_svg before persisting (strips <script>)', async () => {
            const malicious =
                '<svg viewBox="0 0 24 24"><script>alert(1)</script><circle cx="12" cy="12" r="6"/></svg>';

            await service.createCategory(
                'w-1',
                { name: 'New Cat', icon_svg: malicious } as any,
                'u-1',
            );

            const saved: Category[] = dataGenerator.saveCategories.mock.calls[0][2];
            const persisted = saved[saved.length - 1];
            expect(persisted.icon_svg).toBeDefined();
            expect(persisted.icon_svg).not.toContain('<script');
            expect(persisted.icon_svg).not.toContain('alert');
            expect(persisted.icon_svg).toContain('<circle');
        });

        it('rejects icon_svg with no <svg> root with BadRequestException; nothing persisted', async () => {
            await expect(
                service.createCategory(
                    'w-1',
                    { name: 'Bad', icon_svg: '<div>not-an-svg</div>' } as any,
                    'u-1',
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(dataGenerator.saveCategories).not.toHaveBeenCalled();
        });

        it('rejects icon_svg with external paint-server URL (IP-leak vector)', async () => {
            const beacon =
                '<svg viewBox="0 0 24 24"><circle fill="url(https://tracker.example/pixel)" cx="12" cy="12" r="6"/></svg>';

            await expect(
                service.createCategory(
                    'w-1',
                    { name: 'Beacon', icon_svg: beacon } as any,
                    'u-1',
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(dataGenerator.saveCategories).not.toHaveBeenCalled();
        });
    });

    // ============================================================================
    // Categories — update
    // ============================================================================
    describe('updateCategory', () => {
        it('throws NotFoundException when category id does not exist', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ id: 'a' })],
                tags: [],
                collections: [],
            });

            await expect(
                service.updateCategory('w-1', 'missing', { name: 'X' } as any, 'u-1'),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(dataGenerator.saveCategories).not.toHaveBeenCalled();
        });

        it('rejects when new name normalises to a different existing category', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [
                    buildCategory({ id: 'a', name: 'Apples' }),
                    buildCategory({ id: 'b', name: 'Bananas' }),
                ],
                tags: [],
                collections: [],
            });

            await expect(
                service.updateCategory('w-1', 'a', { name: '  BANANAS  ' } as any, 'u-1'),
            ).rejects.toMatchObject({ message: 'A category with this name already exists' });
        });

        it('allows renaming to the same category (case + whitespace ignored)', async () => {
            // Pinned: dup check excludes self via `c.id !== categoryId`.
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ id: 'a', name: 'Apples' })],
                tags: [],
                collections: [],
            });

            await expect(
                service.updateCategory('w-1', 'a', { name: '  apples  ' } as any, 'u-1'),
            ).resolves.toMatchObject({ status: 'success' });
        });

        it('preserves existing fields and overrides only provided ones (spread-merge)', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [
                    buildCategory({
                        id: 'a',
                        name: 'Apples',
                        description: 'old desc',
                        icon_url: 'old.png',
                        priority: 1,
                    }),
                ],
                tags: [],
                collections: [],
            });

            const result = await service.updateCategory(
                'w-1',
                'a',
                { description: 'new desc' } as any,
                'u-1',
            );

            expect(result.category).toEqual({
                id: 'a',
                name: 'Apples',
                description: 'new desc',
                icon_url: 'old.png',
                priority: 1,
            });
        });

        it('treats explicit `description: null` differently from undefined (null clears via `?.trim()`)', async () => {
            // Pinned: `dto.description !== undefined` gate fires even on null,
            // and `null?.trim()` short-circuits to undefined. So sending
            // `description: null` REPLACES the field with undefined.
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ id: 'a', description: 'old' })],
                tags: [],
                collections: [],
            });

            const result = await service.updateCategory(
                'w-1',
                'a',
                { description: null } as any,
                'u-1',
            );

            expect(result.category.description).toBeUndefined();
        });

        it('does NOT touch fields that are undefined in the dto (PATCH semantics)', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ id: 'a', priority: 5 })],
                tags: [],
                collections: [],
            });

            const result = await service.updateCategory(
                'w-1',
                'a',
                { name: 'New Name' } as any,
                'u-1',
            );

            // Pinned: priority NOT touched because dto.priority is undefined.
            expect(result.category.priority).toBe(5);
        });

        it('does NOT update name when empty-string passed (`if (dto.name)` short-circuit)', async () => {
            // Pinned current behaviour: empty-string name is treated as
            // "no change requested" rather than "clear name". A future
            // swap to `if (dto.name !== undefined)` would let the empty
            // string through and produce a category with empty name.
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ id: 'a', name: 'Apples' })],
                tags: [],
                collections: [],
            });

            const result = await service.updateCategory('w-1', 'a', { name: '' } as any, 'u-1');

            expect(result.category.name).toBe('Apples');
        });

        it('writes CATEGORY_CHANGE history entry with action="updated" and only filtered fieldsChanged', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ id: 'a' })],
                tags: [],
                collections: [],
            });

            await service.updateCategory(
                'w-1',
                'a',
                {
                    name: 'New',
                    description: 'd',
                    icon_url: undefined, // filtered out
                    something_else: 'x', // filtered (not in whitelist)
                } as any,
                'u-1',
            );

            const [entry] = generationHistoryRepository.createEntry.mock.calls[0];
            expect(entry.activityType).toBe(WorkHistoryActivityType.CATEGORY_CHANGE);
            // Pinned whitelist: only ['name', 'description', 'icon_url', 'priority']
            // appear in fieldsChanged AND only those that are NOT undefined.
        });

        it('mutates the array in-place via index assignment (saved list contains the patched row)', async () => {
            const cats = [buildCategory({ id: 'a' })];
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: cats,
                tags: [],
                collections: [],
            });

            await service.updateCategory('w-1', 'a', { name: 'Patched' } as any, 'u-1');

            const [, , saved] = dataGenerator.saveCategories.mock.calls[0];
            expect(saved[0].name).toBe('Patched');
        });

        it('short-circuits when ensureCanEdit rejects', async () => {
            ownershipService.ensureCanEdit.mockRejectedValueOnce(new ForbiddenException());

            await expect(
                service.updateCategory('w-1', 'a', { name: 'X' } as any, 'u-1'),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(dataGenerator.getCategoriesTags).not.toHaveBeenCalled();
        });

        // ============================================================================
        // icon_svg sanitization on update (stored-XSS guard)
        // ============================================================================
        it('sanitizes incoming icon_svg before persisting on update', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ id: 'a' })],
                tags: [],
                collections: [],
            });
            const malicious =
                '<svg viewBox="0 0 24 24" onload="alert(1)"><script>steal()</script><path d="M0 0"/></svg>';

            await service.updateCategory(
                'w-1',
                'a',
                { icon_svg: malicious } as any,
                'u-1',
            );

            const [, , saved] = dataGenerator.saveCategories.mock.calls[0];
            expect(saved[0].icon_svg).not.toMatch(/\bonload=/i);
            expect(saved[0].icon_svg).not.toContain('<script');
            expect(saved[0].icon_svg).not.toContain('steal');
        });

        it('treats empty-string icon_svg as clear (sets to empty), not BadRequest', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ id: 'a', icon_svg: '<svg/>' })],
                tags: [],
                collections: [],
            });

            await service.updateCategory(
                'w-1',
                'a',
                { icon_svg: '' } as any,
                'u-1',
            );

            const [, , saved] = dataGenerator.saveCategories.mock.calls[0];
            expect(saved[0].icon_svg).toBe('');
        });

        it('rejects update with malformed icon_svg; nothing persisted', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ id: 'a' })],
                tags: [],
                collections: [],
            });

            await expect(
                service.updateCategory(
                    'w-1',
                    'a',
                    { icon_svg: '<svg viewBox="0 0 24 24"><circle/>' } as any,
                    'u-1',
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(dataGenerator.saveCategories).not.toHaveBeenCalled();
        });
    });

    // ============================================================================
    // Categories — delete
    // ============================================================================
    describe('deleteCategory', () => {
        it('throws NotFoundException when category id does not exist', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ id: 'a' })],
                tags: [],
                collections: [],
            });

            await expect(service.deleteCategory('w-1', 'missing', 'u-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(dataGenerator.saveCategories).not.toHaveBeenCalled();
        });

        it('removes the category in-place via splice and saves the new list', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [
                    buildCategory({ id: 'a' }),
                    buildCategory({ id: 'b' }),
                    buildCategory({ id: 'c' }),
                ],
                tags: [],
                collections: [],
            });

            await service.deleteCategory('w-1', 'b', 'u-1');

            const [, , saved] = dataGenerator.saveCategories.mock.calls[0];
            expect(saved.map((c: Category) => c.id)).toEqual(['a', 'c']);
        });

        it('writes CATEGORY_CHANGE history with action="removed" and the removed name+slug', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ id: 'tools', name: 'Tools' })],
                tags: [],
                collections: [],
            });

            await service.deleteCategory('w-1', 'tools', 'u-1');

            const [entry] = generationHistoryRepository.createEntry.mock.calls[0];
            expect(entry.activityType).toBe(WorkHistoryActivityType.CATEGORY_CHANGE);
        });

        it('returns documented success envelope', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [buildCategory({ id: 'a' })],
                tags: [],
                collections: [],
            });

            const result = await service.deleteCategory('w-1', 'a', 'u-1');

            expect(result).toEqual({
                status: 'success',
                message: 'Category deleted successfully',
            });
        });

        it('short-circuits when ensureCanEdit rejects', async () => {
            ownershipService.ensureCanEdit.mockRejectedValueOnce(new ForbiddenException());

            await expect(service.deleteCategory('w-1', 'a', 'u-1')).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            expect(dataGenerator.getCategoriesTags).not.toHaveBeenCalled();
        });
    });

    // ============================================================================
    // Tags
    // ============================================================================
    describe('getTags', () => {
        it('runs ensureAccess (NOT ensureCanEdit), returns tags array', async () => {
            const tags = [buildTag({ id: 'a' })];
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags,
                collections: [],
            });

            const result = await service.getTags('w-1', 'u-1');

            expect(result).toBe(tags);
            expect(ownershipService.ensureAccess).toHaveBeenCalledWith('w-1', 'u-1');
            expect(ownershipService.ensureCanEdit).not.toHaveBeenCalled();
        });

        it('coerces missing tags to []', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: undefined,
                collections: [],
            });

            await expect(service.getTags('w-1', 'u-1')).resolves.toEqual([]);
        });
    });

    describe('createTag', () => {
        it('rejects on duplicate name (case-insensitive)', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [buildTag({ name: 'Web' })],
                collections: [],
            });

            await expect(
                service.createTag('w-1', { name: ' WEB ' } as any, 'u-1'),
            ).rejects.toMatchObject({ message: 'A tag with this name already exists' });
        });

        it('writes only id+name (no description/icon_url/priority — Tag is a thin shape)', async () => {
            // Pinned: Tag has only `{id, name}` — a future addition (e.g. color)
            // would need to update `createTag` AND this test together.
            await service.createTag('w-1', { name: 'New Tag' } as any, 'u-1');

            const [, , saved] = dataGenerator.saveTags.mock.calls[0];
            expect(saved[0]).toEqual({ id: 'new-tag', name: 'New Tag' });
        });

        it('writes TAG_CHANGE history (NOT CATEGORY_CHANGE) with action="added"', async () => {
            await service.createTag('w-1', { name: 'X' } as any, 'u-1');

            const [entry] = generationHistoryRepository.createEntry.mock.calls[0];
            expect(entry.activityType).toBe(WorkHistoryActivityType.TAG_CHANGE);
        });

        it('returns success envelope with the new tag', async () => {
            const result = await service.createTag('w-1', { name: 'Web' } as any, 'u-1');

            expect(result).toEqual({
                status: 'success',
                tag: { id: 'web', name: 'Web' },
            });
        });
    });

    describe('updateTag', () => {
        it('throws NotFoundException when tag id does not exist', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [buildTag({ id: 'a' })],
                collections: [],
            });

            await expect(
                service.updateTag('w-1', 'missing', { name: 'X' } as any, 'u-1'),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('rejects on duplicate against another tag', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [
                    buildTag({ id: 'a', name: 'Apples' }),
                    buildTag({ id: 'b', name: 'Bananas' }),
                ],
                collections: [],
            });

            await expect(
                service.updateTag('w-1', 'a', { name: 'BANANAS' } as any, 'u-1'),
            ).rejects.toMatchObject({ message: 'A tag with this name already exists' });
        });

        it('preserves existing id when name is renamed (id is NOT re-slugified)', async () => {
            // Pinned: updates merge `{...tags[i], ...(dto.name && {name})}` — id
            // stays the same. A future swap that re-slugified the id would
            // orphan items that reference the old slug.
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [buildTag({ id: 'old-id', name: 'Old' })],
                collections: [],
            });

            const result = await service.updateTag(
                'w-1',
                'old-id',
                { name: 'Brand New Name' } as any,
                'u-1',
            );

            expect(result.tag).toEqual({ id: 'old-id', name: 'Brand New Name' });
        });

        it('does nothing when dto.name is undefined / empty (returns unchanged tag in success envelope)', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [buildTag({ id: 'a', name: 'Apples' })],
                collections: [],
            });

            const result = await service.updateTag('w-1', 'a', {} as any, 'u-1');

            // Pinned: still a successful no-op (returns the unchanged tag),
            // still writes a history entry. A future tightening to "no-op
            // skips history" would be a deliberate change.
            expect(result.tag.name).toBe('Apples');
            expect(generationHistoryRepository.createEntry).toHaveBeenCalledTimes(1);
        });

        it('fieldsChanged is empty for a no-op update (all dto values undefined)', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [buildTag({ id: 'a' })],
                collections: [],
            });

            await service.updateTag('w-1', 'a', {} as any, 'u-1');

            // The update path filters out undefined values from fieldsChanged,
            // so the changelog should be empty for a no-op.
            expect(generationHistoryRepository.createEntry).toHaveBeenCalled();
        });
    });

    describe('deleteTag', () => {
        it('throws NotFoundException when tag id does not exist', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [buildTag({ id: 'a' })],
                collections: [],
            });

            await expect(service.deleteTag('w-1', 'missing', 'u-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('removes the tag and writes TAG_CHANGE history with removed name+slug', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [buildTag({ id: 'a' }), buildTag({ id: 'b' })],
                collections: [],
            });

            await service.deleteTag('w-1', 'b', 'u-1');

            const [, , saved] = dataGenerator.saveTags.mock.calls[0];
            expect(saved.map((t: Tag) => t.id)).toEqual(['a']);

            const [entry] = generationHistoryRepository.createEntry.mock.calls[0];
            expect(entry.activityType).toBe(WorkHistoryActivityType.TAG_CHANGE);
        });

        it('returns success envelope', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [buildTag({ id: 'a' })],
                collections: [],
            });

            await expect(service.deleteTag('w-1', 'a', 'u-1')).resolves.toEqual({
                status: 'success',
                message: 'Tag deleted successfully',
            });
        });
    });

    // ============================================================================
    // Collections
    // ============================================================================
    describe('getCollections', () => {
        it('runs ensureAccess and returns collections array', async () => {
            const cols = [buildCollection({ id: 'a' })];
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [],
                collections: cols,
            });

            const result = await service.getCollections('w-1', 'u-1');

            expect(result).toBe(cols);
            expect(ownershipService.ensureAccess).toHaveBeenCalledWith('w-1', 'u-1');
            expect(ownershipService.ensureCanEdit).not.toHaveBeenCalled();
        });

        it('coerces missing collections to []', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [],
                collections: undefined,
            });

            await expect(service.getCollections('w-1', 'u-1')).resolves.toEqual([]);
        });
    });

    describe('createCollection', () => {
        it('rejects on duplicate name', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [],
                collections: [buildCollection({ name: 'Picks' })],
            });

            await expect(
                service.createCollection('w-1', { name: ' PICKS ' } as any, 'u-1'),
            ).rejects.toMatchObject({ message: 'A collection with this name already exists' });
        });

        it('slugifies trimmed name into id and trims optional fields', async () => {
            await service.createCollection(
                'w-1',
                {
                    name: '  Best Picks  ',
                    description: ' desc ',
                    icon_url: ' i.png ',
                    priority: 2,
                } as any,
                'u-1',
            );

            const [, , saved] = dataGenerator.saveCollections.mock.calls[0];
            expect(saved[0]).toEqual({
                id: 'best-picks',
                name: 'Best Picks',
                description: 'desc',
                icon_url: 'i.png',
                priority: 2,
            });
        });

        it('writes COLLECTION_CHANGE history with action="added"', async () => {
            await service.createCollection('w-1', { name: 'X' } as any, 'u-1');

            const [entry] = generationHistoryRepository.createEntry.mock.calls[0];
            expect(entry.activityType).toBe(WorkHistoryActivityType.COLLECTION_CHANGE);
        });

        it('returns documented success envelope', async () => {
            const result = await service.createCollection('w-1', { name: 'Picks' } as any, 'u-1');

            expect(result).toEqual({
                status: 'success',
                collection: {
                    id: 'picks',
                    name: 'Picks',
                    description: undefined,
                    icon_url: undefined,
                    priority: undefined,
                },
            });
        });

        it('sanitizes icon_svg on create and rejects malformed payloads', async () => {
            const malicious =
                '<svg viewBox="0 0 24 24"><foreignObject><div onclick="x()"></div></foreignObject><rect width="24" height="24"/></svg>';

            await service.createCollection(
                'w-1',
                { name: 'Safe Picks', icon_svg: malicious } as any,
                'u-1',
            );

            const [, , saved] = dataGenerator.saveCollections.mock.calls[0];
            expect(saved[0].icon_svg).not.toContain('foreignObject');
            expect(saved[0].icon_svg).not.toContain('onclick');

            await expect(
                service.createCollection(
                    'w-1',
                    { name: 'Bad Picks', icon_svg: '<div/>' } as any,
                    'u-1',
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('updateCollection', () => {
        it('throws NotFoundException when collection id does not exist', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [],
                collections: [buildCollection({ id: 'a' })],
            });

            await expect(
                service.updateCollection('w-1', 'missing', { name: 'X' } as any, 'u-1'),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('rejects on duplicate against another collection', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [],
                collections: [
                    buildCollection({ id: 'a', name: 'Alpha' }),
                    buildCollection({ id: 'b', name: 'Beta' }),
                ],
            });

            await expect(
                service.updateCollection('w-1', 'a', { name: 'beta' } as any, 'u-1'),
            ).rejects.toMatchObject({ message: 'A collection with this name already exists' });
        });

        it('spread-merges existing fields with provided dto fields', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [],
                collections: [
                    buildCollection({
                        id: 'a',
                        name: 'Alpha',
                        description: 'old',
                        icon_url: 'old.png',
                        priority: 1,
                    }),
                ],
            });

            const result = await service.updateCollection(
                'w-1',
                'a',
                { priority: 99 } as any,
                'u-1',
            );

            expect(result.collection).toEqual({
                id: 'a',
                name: 'Alpha',
                description: 'old',
                icon_url: 'old.png',
                priority: 99,
            });
        });

        it('writes COLLECTION_CHANGE history with whitelist-filtered fieldsChanged', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [],
                collections: [buildCollection({ id: 'a' })],
            });

            await service.updateCollection('w-1', 'a', { name: 'New', extra: 'x' } as any, 'u-1');

            const [entry] = generationHistoryRepository.createEntry.mock.calls[0];
            expect(entry.activityType).toBe(WorkHistoryActivityType.COLLECTION_CHANGE);
        });
    });

    describe('deleteCollection', () => {
        it('throws NotFoundException when collection id does not exist', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [],
                collections: [buildCollection({ id: 'a' })],
            });

            await expect(service.deleteCollection('w-1', 'missing', 'u-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('removes the collection and writes COLLECTION_CHANGE history', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [],
                collections: [buildCollection({ id: 'a' }), buildCollection({ id: 'b' })],
            });

            await service.deleteCollection('w-1', 'b', 'u-1');

            const [, , saved] = dataGenerator.saveCollections.mock.calls[0];
            expect(saved.map((c: Collection) => c.id)).toEqual(['a']);

            const [entry] = generationHistoryRepository.createEntry.mock.calls[0];
            expect(entry.activityType).toBe(WorkHistoryActivityType.COLLECTION_CHANGE);
        });

        it('returns success envelope', async () => {
            dataGenerator.getCategoriesTags.mockResolvedValue({
                categories: [],
                tags: [],
                collections: [buildCollection({ id: 'a' })],
            });

            await expect(service.deleteCollection('w-1', 'a', 'u-1')).resolves.toEqual({
                status: 'success',
                message: 'Collection deleted successfully',
            });
        });
    });

    // ============================================================================
    // recordTaxonomyHistory (private; observed via public ops)
    // ============================================================================
    describe('recordTaxonomyHistory (observed via createCategory)', () => {
        it('always writes triggeredBy="user" (NOT "schedule" / "api")', async () => {
            // Pinned: taxonomy edits are always user-initiated. A future
            // schedule-driven taxonomy mutation would need to widen this.
            await service.createCategory('w-1', { name: 'X' } as any, 'u-1');

            const [entry] = generationHistoryRepository.createEntry.mock.calls[0];
            expect(entry.triggeredBy).toBe('user');
        });

        it('always writes status=GENERATED + durationInSeconds=0', async () => {
            await service.createCategory('w-1', { name: 'X' } as any, 'u-1');

            const [entry] = generationHistoryRepository.createEntry.mock.calls[0];
            expect(entry.status).toBe(GenerateStatusType.GENERATED);
            expect(entry.durationInSeconds).toBe(0);
        });

        it('does NOT swallow errors from createEntry — propagates up to the caller', async () => {
            // Pinned: history-write failures MUST surface — taxonomy edits
            // are committed to the data repo BEFORE history is written, so
            // a silent history failure would create an audit-log gap.
            const err = new Error('history db down');
            generationHistoryRepository.createEntry.mockRejectedValueOnce(err);

            await expect(service.createCategory('w-1', { name: 'X' } as any, 'u-1')).rejects.toBe(
                err,
            );
        });

        it('forwards startedAt/finishedAt as the SAME Date instance', async () => {
            await service.createCategory('w-1', { name: 'X' } as any, 'u-1');

            const [entry] = generationHistoryRepository.createEntry.mock.calls[0];
            // Pinned: both are set to a single `now = new Date()` capture.
            expect(entry.startedAt).toBe(entry.finishedAt);
        });
    });
});
